import type { AppBridge, LocalAnswer, ResourceView, SourceHealth } from "@magic/contracts";
import {
  chatItem, dueCaveat, dueInScope, localErrorNeedsSetup, narrowTo, routeIntent, safeWebLink, scopeCourses, scopeLabel,
  type ChatItem, type ChatScope, type DueRow,
} from "./model";

// owner: chat lane. Chats live in renderer memory only: prompts and answers can contain coursework.
// Each nonempty submit from the shell composer makes a new chat; nothing is shared between chats.

/** Where the student was when they submitted. The integrator fills and restores the route fields. */
export interface ChatOrigin {
  view: string;
  resourceId: string | null;
  courseKey: string | null;
  /** Visible page name for the Back control, for example "Home" or "COMPSCI 220". */
  label: string;
  /** data-focus-key of the last focused workspace element before the composer took focus. */
  focusKey: string | null;
  /** data-place-anchor nearest the top of the pane, with its offset, as navigation.ts captures it. */
  anchor: string | null;
  offset: number;
  scroll: number;
  /** Exactly what the page showed. The chat may narrow this to one item, never widen it. */
  scope: ChatScope;
}
export interface ChatEntry {
  prompt: string;
  origin: ChatOrigin;
  /** One per submit gesture. Repeating it returns the same chat instead of a second one. */
  idempotencyKey: string;
}

export type ChatResult =
  | { kind: "due"; days: number; scopeLabel: string; rows: DueRow[]; caveat: string | null }
  | { kind: "choose"; scopeLabel: string; items: ChatItem[]; searched: boolean }
  | { kind: "answer"; answer: LocalAnswer; item: ChatItem }
  | { kind: "opened"; item: ChatItem }
  | { kind: "note"; text: string };
export type ExchangeState = "queued" | "running" | "done" | "failed" | "stopped";
export interface Exchange {
  id: string;
  key: string;
  prompt: string;
  /** The one item this question is answered from, once known. */
  target: ChatItem | null;
  state: ExchangeState;
  step: "search" | "ask" | "open" | null;
  result: ChatResult | null;
  error: { text: string; setup: "local-model" | "sources" | null } | null;
}
export interface Chat {
  id: string;
  origin: ChatOrigin;
  createdAt: string;
  exchanges: Exchange[];
  /** An item the student chose inside the origin scope. Cleared only by the student. */
  narrowed: ChatItem | null;
  version: number;
}

export type ChatBridge = Pick<AppBridge, "openExternal"> & Partial<Pick<AppBridge, "localAsk" | "cancelLocal" | "query" | "openLink" | "execute">>;
/** What the pane passes in while it is visible. Chats only run while shown. */
export interface ChatRuntime {
  bridge: ChatBridge;
  /** The same filtered resources the pages render from. */
  resources: ResourceView[];
  sources: Pick<SourceHealth, "id" | "accountScope">[];
  now: string;
}

const LIMIT = 12;
const chats = new Map<string, Chat>();
const byKey = new Map<string, string>();
const listeners = new Set<() => void>();
const tickets = new Map<string, number>();
/** The desktop runs one local model request at a time (local-service.ts). Owner is exchange id + run ticket. */
let localOwner: string | null = null;
let seq = 0;
const nextId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`;

function emit(chat?: Chat) {
  if (chat) chat.version++;
  for (const listener of listeners) listener();
}
export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
export function getChat(id: string | null): Chat | null {
  return id ? chats.get(id) ?? null : null;
}

function exchange(prompt: string, key: string, target: ChatItem | null): Exchange {
  return { id: nextId("x"), key, prompt, target, state: "queued", step: null, result: null, error: null };
}

/** Nonempty submit from the shell composer. Returns null for an empty prompt: nothing opens. */
export function startChat(entry: ChatEntry, now = new Date().toISOString()): { chat: Chat; created: boolean } | null {
  const prompt = entry.prompt.trim();
  if (!prompt || !entry.idempotencyKey) return null;
  const existing = getChat(byKey.get(entry.idempotencyKey) ?? null);
  if (existing) return { chat: existing, created: false };
  const target = entry.origin.scope.kind === "item" ? entry.origin.scope.item : null;
  const chat: Chat = { id: nextId("c"), origin: entry.origin, createdAt: now, exchanges: [exchange(prompt.slice(0, 2000), entry.idempotencyKey, target)], narrowed: null, version: 0 };
  chats.set(chat.id, chat);
  byKey.set(entry.idempotencyKey, chat.id);
  evict();
  emit();
  return { chat, created: true };
}

/** A follow-up typed into the shell composer while this chat is shown. */
export function continueChat(chatId: string, text: string, idempotencyKey: string): boolean {
  const chat = getChat(chatId), prompt = text.trim();
  if (!chat || !prompt || !idempotencyKey) return false;
  if (chat.exchanges.some((x) => x.key === idempotencyKey)) return true;
  chat.exchanges = [...chat.exchanges, exchange(prompt.slice(0, 2000), idempotencyKey, currentScope(chat).kind === "item" ? itemOf(currentScope(chat)) : null)];
  emit(chat);
  return true;
}

/** Placeholder for the shell composer while this chat is shown. */
export function followUpHint(chat: Chat): string {
  return `Ask a follow-up about ${scopeLabel(currentScope(chat))}`;
}

function evict() {
  const idle = [...chats.values()].filter((c) => !c.exchanges.some((x) => x.state === "running" || x.state === "queued"));
  while (chats.size > LIMIT && idle.length) {
    const old = idle.shift()!;
    chats.delete(old.id);
    for (const [key, id] of byKey) if (id === old.id) byKey.delete(key);
  }
}
export function resetChats() {
  chats.clear(); byKey.clear(); tickets.clear(); localOwner = null;
}

export function currentScope(chat: Chat): ChatScope {
  return chat.narrowed ? narrowTo(chat.origin.scope, chat.narrowed) ?? chat.origin.scope : chat.origin.scope;
}
function itemOf(scope: ChatScope) {
  return scope.kind === "item" ? scope.item : null;
}
export function setNarrowed(chat: Chat, item: ChatItem | null) {
  if (item && !narrowTo(chat.origin.scope, item)) return;
  chat.narrowed = item;
  emit(chat);
}

function update(chat: Chat, x: Exchange, patch: Partial<Exchange>) {
  Object.assign(x, patch);
  chat.exchanges = [...chat.exchanges];
  emit(chat);
}

/** Starts the next queued exchange of a shown chat. One exchange runs per chat at a time. */
export function drive(chat: Chat, runtime: ChatRuntime) {
  if (chat.exchanges.some((x) => x.state === "running")) return;
  const next = chat.exchanges.find((x) => x.state === "queued");
  if (next) void run(chat, next, runtime);
}

async function run(chat: Chat, x: Exchange, rt: ChatRuntime) {
  const ticket = (tickets.get(x.id) ?? 0) + 1;
  tickets.set(x.id, ticket);
  const live = () => tickets.get(x.id) === ticket;
  const scope = currentScope(chat);
  const target = x.target && refresh(x.target, rt);
  update(chat, x, { state: "running", error: null, result: null, step: null });
  try {
    if (x.target && !target) return update(chat, x, { state: "failed", error: { text: `${x.target.title} is no longer in your saved workspace.`, setup: null } });
    const intent = routeIntent(x.prompt);
    if (intent.kind === "due") {
      const label = scope.kind === "item" && scope.course ? scope.course.label : scopeLabel(scope);
      return update(chat, x, { state: "done", result: { kind: "due", days: intent.days, scopeLabel: label, rows: dueInScope(scope, rt.resources, rt.sources, rt.now, intent.days), caveat: dueCaveat(scopeCourses(scope)) } });
    }
    if (intent.kind === "open") {
      if (!target) return update(chat, x, { state: "done", result: { kind: "note", text: "Choose one item to open. Ask about it by name and pick it from the saved matches." } });
      return await open(chat, x, target, rt, live);
    }
    if (target) return await ask(chat, x, target, rt, live, `${x.id}:${ticket}`);
    if (!scopeCourses(scope).length) return update(chat, x, { state: "failed", error: { text: "No courses are included yet, so there is nothing saved to answer from.", setup: "sources" } });
    update(chat, x, { step: "search" });
    const allowed = new Set(scopeCourses(scope).map((c) => c.key));
    let items: ChatItem[] = [], searched = false;
    if (rt.bridge.query) {
      const courses = scopeCourses(scope), single = courses.length === 1 ? courses[0]! : null;
      const found = await rt.bridge.query({ view: "resources", search: x.prompt.slice(0, 500), limit: 50, ...(single ? { courseId: single.courseId, accountScope: single.accountScope } : {}) });
      if (found.view === "resources") items = found.items.map((r) => chatItem(r, rt.sources));
      searched = true;
    } else {
      const terms = x.prompt.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
      items = rt.resources.filter((r) => !r.deleted && terms.some((t) => r.title.toLowerCase().includes(t))).map((r) => chatItem(r, rt.sources));
    }
    if (!live()) return;
    items = items.filter((i) => i.courseKey && allowed.has(i.courseKey)).slice(0, 4);
    update(chat, x, { state: "done", step: null, result: { kind: "choose", scopeLabel: scopeLabel(scope), items, searched } });
  } catch (cause) {
    if (!live()) return;
    update(chat, x, { state: "failed", step: null, error: { text: message(cause, "Saved items could not be searched."), setup: null } });
  }
}

function refresh(item: ChatItem, rt: ChatRuntime): ChatItem | null {
  const current = rt.resources.find((r) => r.id === item.id && !r.deleted);
  return current ? chatItem(current, rt.sources) : rt.resources.length ? null : item;
}
function message(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

async function ask(chat: Chat, x: Exchange, target: ChatItem, rt: ChatRuntime, live: () => boolean, owner: string) {
  if (!rt.bridge.localAsk) return update(chat, x, { state: "failed", error: { text: "Answers need the desktop app's local model. This window cannot run it.", setup: "local-model" } });
  if (localOwner) return update(chat, x, { state: "failed", error: { text: "Another question is still running on this device. Try again when it finishes.", setup: null } });
  localOwner = owner;
  update(chat, x, { step: "ask", target });
  try {
    const answer = await rt.bridge.localAsk({ id: target.id, inputHash: target.contentHash, question: x.prompt });
    if (!live()) return;
    if (answer.resourceId !== target.id || answer.inputHash !== target.contentHash)
      return update(chat, x, { state: "failed", step: null, error: { text: "The answer did not match this item's current version, so it was not shown.", setup: null } });
    update(chat, x, { state: "done", step: null, result: { kind: "answer", answer, item: target } });
  } catch (cause) {
    if (!live()) return;
    const text = message(cause, "The local model could not answer.");
    update(chat, x, { state: "failed", step: null, error: { text, setup: localErrorNeedsSetup(text) ? "local-model" : null } });
  } finally {
    if (localOwner === owner) localOwner = null;
  }
}

async function open(chat: Chat, x: Exchange, target: ChatItem, rt: ChatRuntime, live: () => boolean) {
  const url = safeWebLink(target.url);
  if (!url) return update(chat, x, { state: "done", result: { kind: "note", text: `${target.title} has no web link Magic can open.` } });
  update(chat, x, { step: "open", target });
  try {
    await (rt.bridge.openLink ?? rt.bridge.openExternal)(url);
    if (live()) update(chat, x, { state: "done", step: null, result: { kind: "opened", item: target } });
  } catch (cause) {
    if (live()) update(chat, x, { state: "failed", step: null, error: { text: message(cause, "The source could not be opened."), setup: null } });
  }
}

/** Stops this exchange only. The local runtime is shared, so it is cancelled only if this exchange owns it. */
export function stop(chat: Chat, x: Exchange, bridge: ChatBridge) {
  if (x.state !== "running" && x.state !== "queued") return;
  tickets.set(x.id, (tickets.get(x.id) ?? 0) + 1);
  if (localOwner?.startsWith(`${x.id}:`)) {
    localOwner = null;
    void bridge.cancelLocal?.().catch(() => undefined);
  }
  update(chat, x, { state: "stopped", step: null });
}
export function retry(chat: Chat, x: Exchange) {
  if (x.state !== "failed" && x.state !== "stopped") return;
  update(chat, x, { state: "queued", error: null, result: null });
}
/** Picking a match answers the same question from that one item and narrows later follow-ups to it. */
export function choose(chat: Chat, x: Exchange, item: ChatItem) {
  if (!narrowTo(chat.origin.scope, item) || chat.exchanges.some((e) => e.state === "running")) return;
  chat.narrowed = item;
  update(chat, x, { target: item, state: "queued", result: null, error: null });
}
/** Opening the source from an answer or choice; recorded inline, not as a new question. */
export async function openSource(item: ChatItem, bridge: ChatBridge): Promise<string | null> {
  const url = safeWebLink(item.url);
  if (!url) return `${item.title} has no web link Magic can open.`;
  try {
    await (bridge.openLink ?? bridge.openExternal)(url);
    return null;
  } catch (cause) {
    return message(cause, "The source could not be opened.");
  }
}
