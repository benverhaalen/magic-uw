import type { AppBridge, LocalAnswer, ResourceView, SourceHealth } from "@magic/contracts";
import {
  chatItem, dueCaveat, dueInScope, namesAnotherItem, permits, permittedCourses, permittedScope,
  resolveCourseMention, routeIntent, safeWebLink, scopeCourses, scopeLabel, studentError, withoutMention,
  type ChatCourse, type ChatItem, type ChatScope, type DueRow, type DueWindow,
} from "./model";
import { CHAT_READS, intentCourse, intentHits, intentRange, previewIntent, runIntent, type IntentCitation, type IntentResult } from "./intent";

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
  /** Exactly what the page showed: the default evidence for the chat. Never changed, so Back returns here. */
  scope: ChatScope;
}
export interface ChatEntry {
  prompt: string;
  origin: ChatOrigin;
  /** One per submit gesture. Repeating it returns the same chat instead of a second one. */
  idempotencyKey: string;
}

export type ChatResult =
  | { kind: "due"; span: DueWindow; scopeLabel: string; rows: DueRow[]; caveat: string | null; courses: ChatCourse[] }
  /** Saved items that may answer the question. `wider` lists included courses the student could search too. */
  | { kind: "choose"; scopeLabel: string; items: ChatItem[]; searched: boolean; wider: boolean }
  /** The student named a course Magic cannot settle alone; they pick one. */
  | { kind: "course"; reason: "ambiguous" | "unknown"; text: string; courses: ChatCourse[] }
  | { kind: "answer"; answer: LocalAnswer; item: ChatItem }
  /** The intent router's grounded answer: sentences whose quotes code found in the saved passages. */
  | { kind: "grounded"; text: string; citations: IntentCitation[]; notFound: boolean; dropped: number; path: IntentResult["path"] }
  /** The router asked the student to choose; each option is one permitted course. */
  | { kind: "clarify"; question: string; options: { label: string; course: ChatCourse }[] }
  /** The router could not answer (no AI connected, sending held for preview, blocked). Its reason, as given. */
  | { kind: "unavailable"; reason: string }
  /** The router read this as an action that changes something. The chat names it and does not run it. */
  | { kind: "action"; action: string; hint: string | null }
  | { kind: "opened"; item: ChatItem }
  | { kind: "note"; text: string }
  /** owner: claude-chat. The persistent Claude session's answer; `text` grows as it streams. */
  | { kind: "claude"; text: string; streaming: boolean; tools: string[]; sources: { id: string; title: string; course: string; url: string | null }[]; cards: { status: string; message: string } | null; ms: number | null };
export type ExchangeState = "queued" | "running" | "done" | "failed" | "stopped";
export interface Exchange {
  id: string;
  key: string;
  prompt: string;
  /** The one item this question is answered from, once known. */
  target: ChatItem | null;
  /** The course the student picked for this question. */
  course: ChatCourse | null;
  /** The student chose to search every included course for this question. */
  wide: boolean;
  /** The student chose to answer from one saved item on this device instead of the router. */
  local: boolean;
  state: ExchangeState;
  step: "search" | "ask" | "answer" | "open" | null;
  result: ChatResult | null;
  /** `detail` keeps raw technical text for inspection; the body shows `text` only. */
  error: { text: string; setup: "local-model" | "sources" | null; detail?: string | null } | null;
}
export interface Chat {
  id: string;
  origin: ChatOrigin;
  createdAt: string;
  exchanges: Exchange[];
  /** A course the student named or picked. Default for follow-ups until cleared or another is named. */
  course: ChatCourse | null;
  /** An item the student picked. Default for follow-ups until cleared or another item is named. */
  narrowed: ChatItem | null;
  version: number;
}

export type ChatBridge = Pick<AppBridge, "openExternal"> & Partial<Pick<AppBridge, "localAsk" | "cancelLocal" | "query" | "openLink" | "execute" | "intentRun" | "cancelIntent" | "chatAsk" | "cancelChat" | "onChatDelta">>;
/** What the pane passes in while it is visible. Chats only run while shown. */
export interface ChatRuntime {
  bridge: ChatBridge;
  /** The same filtered resources the pages render from. */
  resources: ResourceView[];
  sources: Pick<SourceHealth, "id" | "accountScope">[];
  /** Included courses (from the same course cards as the sidebar). Read on every run, so exclusions apply at once. */
  courses: ChatCourse[];
  now: string;
  onNavigate?(target: {view: string; resourceId?: string; courseId?: string; accountScope?: string}): void;
}

const LIMIT = 12;
const chats = new Map<string, Chat>();
const byKey = new Map<string, string>();
/** Evicted chats keep only their origin, so a replayed key opens nothing new and the pane can still go Back. */
const gone = new Map<string, ChatOrigin>();
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
/** Origin of a chat that was dropped from memory, when it is still remembered. */
export function goneOrigin(id: string | null): ChatOrigin | null {
  return id ? gone.get(id) ?? null : null;
}

function exchange(prompt: string, key: string, target: ChatItem | null = null): Exchange {
  return { id: nextId("x"), key, prompt, target, course: null, wide: false, local: false, state: "queued", step: null, result: null, error: null };
}

/** Matches the existing local-question contract; callers show this before clearing a draft. */
export function chatPromptError(text: string): string | null {
  if (!text.trim()) return "Write a message first.";
  return text.trim().length > 2000 ? "Keep this message to 2,000 characters. Your full draft is still here." : null;
}

/** Nonempty submit from the shell composer. Returns null for an empty prompt or a replayed key of a dropped chat. */
export function startChat(entry: ChatEntry, now = new Date().toISOString()): { chat: Chat; created: boolean } | null {
  const prompt = entry.prompt.trim();
  if (chatPromptError(entry.prompt) || !entry.idempotencyKey) return null;
  const id = byKey.get(entry.idempotencyKey);
  const existing = getChat(id ?? null);
  if (existing) return { chat: existing, created: false };
  if (id) return null;
  const chat: Chat = { id: nextId("c"), origin: entry.origin, createdAt: now, exchanges: [exchange(prompt, entry.idempotencyKey)], course: null, narrowed: null, version: 0 };
  chats.set(chat.id, chat);
  byKey.set(entry.idempotencyKey, chat.id);
  evict();
  emit();
  return { chat, created: true };
}

/** Adopt the already-run shared result exactly once; no second model/router dispatch. */
export function acceptVoiceResult(entry: ChatEntry, result: IntentResult, runtime: ChatRuntime, followUpId?: string): Chat | null {
  let chat = followUpId ? getChat(followUpId) : null;
  if (chat) { if (chat.exchanges.some(x => x.key === entry.idempotencyKey)) return chat; continueChat(chat.id, entry.prompt, entry.idempotencyKey); }
  else { const started = startChat(entry); if (!started || !started.created) return started?.chat ?? null; chat = started.chat; }
  const x = chat.exchanges.at(-1)!;
  const permitted = permittedCourses(chat.origin.scope, runtime.courses), scope = permittedScope(currentScope(chat), permitted);
  if (!scope) { update(chat, x, {state: 'failed', error: {text: 'This course is no longer included. Choose an included course.', setup: 'sources'}}); return chat; }
  applyIntent(chat, x, result, runtime, permitted, scope);
  return chat;
}

/** A follow-up typed into the shell composer while this chat is shown. */
export function continueChat(chatId: string, text: string, idempotencyKey: string): boolean {
  const chat = getChat(chatId), prompt = text.trim();
  if (!chat || chatPromptError(text) || !idempotencyKey) return false;
  if (chat.exchanges.some((x) => x.key === idempotencyKey)) return true;
  chat.exchanges = [...chat.exchanges, exchange(prompt, idempotencyKey)];
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
    gone.set(old.id, old.origin);
  }
  // Keys and origins of dropped chats are small; keep a bounded window of them.
  while (gone.size > LIMIT * 8) {
    const [id] = gone.keys();
    gone.delete(id!);
    for (const [key, chatId] of byKey) if (chatId === id) byKey.delete(key);
  }
}
export function resetChats() {
  chats.clear(); byKey.clear(); gone.clear(); tickets.clear(); localOwner = null;
}

function originCourse(scope: ChatScope): ChatCourse | null {
  return scope.kind === "course" ? scope.course : scope.kind === "item" ? scope.course : null;
}
/** The default evidence for the next follow-up: a picked item, else a named course, else the origin. */
export function currentScope(chat: Chat): ChatScope {
  const page = chat.origin.scope.page;
  if (chat.narrowed) {
    const course = chat.course?.key === chat.narrowed.courseKey ? chat.course : scopeCourses(chat.origin.scope).find((c) => c.key === chat.narrowed!.courseKey) ?? null;
    return { kind: "item", page, course, item: chat.narrowed };
  }
  if (chat.course) {
    const item = chat.origin.scope.kind === "item" && chat.origin.scope.item.courseKey === chat.course.key ? chat.origin.scope.item : null;
    return item ? { kind: "item", page, course: chat.course, item } : { kind: "course", page, course: chat.course };
  }
  return chat.origin.scope;
}
/** Sets or clears the course follow-ups default to. The origin itself never changes. */
export function setCourse(chat: Chat, course: ChatCourse | null) {
  const same = course && originCourse(chat.origin.scope)?.key === course.key;
  chat.course = same ? null : course;
  if (chat.narrowed && course && chat.narrowed.courseKey !== course.key) chat.narrowed = null;
  if (chat.narrowed && !course && chat.narrowed.courseKey !== originCourse(chat.origin.scope)?.key && chat.origin.scope.kind !== "workspace") chat.narrowed = null;
  emit(chat);
}
export function setNarrowed(chat: Chat, item: ChatItem | null) {
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

type Plan =
  | { kind: "pick"; result: Extract<ChatResult, { kind: "course" }> }
  | { kind: "scope"; scope: ChatScope; search: string };
/**
 * Which evidence this question uses, in code. A course the student names (or picks) wins, then the
 * course they named earlier, then the origin page. Only permitted courses can be chosen.
 */
function plan(chat: Chat, x: Exchange, permitted: ChatCourse[], said: string | null = null): Plan {
  const page = chat.origin.scope.page;
  if (x.wide) return { kind: "scope", scope: { kind: "workspace", page, courses: permitted }, search: x.prompt };
  let search = x.prompt;
  let course = x.course && permitted.some((c) => c.key === x.course!.key) ? x.course : null;
  if (!course) {
    // With the router present, its code resolver found the course words; only those are matched here.
    const mention = resolveCourseMention(said ?? x.prompt, permitted);
    if (mention.kind === "ambiguous") return { kind: "pick", result: { kind: "course", reason: "ambiguous", text: mention.text, courses: mention.courses } };
    // Course words the router found that match no permitted course are not included here.
    if (said && mention.kind === "none") return { kind: "pick", result: { kind: "course", reason: "unknown", text: said, courses: permitted } };
    if (mention.kind === "unknown") return { kind: "pick", result: { kind: "course", reason: "unknown", text: mention.text, courses: permitted } };
    if (mention.kind === "one") {
      course = mention.course;
      search = said ? x.prompt : withoutMention(x.prompt, mention);
    }
  }
  if (course && (chat.course ?? originCourse(chat.origin.scope))?.key !== course.key) setCourse(chat, course);
  return { kind: "scope", scope: currentScope(chat), search };
}

async function run(chat: Chat, x: Exchange, rt: ChatRuntime) {
  const ticket = (tickets.get(x.id) ?? 0) + 1;
  tickets.set(x.id, ticket);
  const live = () => tickets.get(x.id) === ticket;
  update(chat, x, { state: "running", error: null, result: null, step: null });
  try {
    const permitted = permittedCourses(chat.origin.scope, rt.courses);
    // Current inclusion wins over historical context. A new explicit target can recover a removed origin.
    let allowedBase = permittedScope(currentScope(chat), permitted);
    if (!allowedBase) {
      const initialPlan = plan(chat, x, permitted);
      if (initialPlan.kind === "pick") return update(chat, x, { state: "done", result: initialPlan.result });
      allowedBase = permittedScope(initialPlan.scope, permitted);
    }
    if (!allowedBase) return update(chat, x, { state: "failed", error: { text: "This course is no longer included. Choose an included course or update Sources.", setup: "sources" } });
    // owner: claude-chat. A free-form question goes to the student's persistent Claude session, which
    // reads the saved coursework through the app's read tools. Exact facts (what's due, opening an
    // item or page) stay on the code path below and answer at once.
    if (rt.bridge.chatAsk && !x.target && !x.wide && !x.course && !x.local && routeIntent(x.prompt).kind === "ask" && !/^\s*(open|go to|take me to)\b/i.test(x.prompt))
      return await askClaude(chat, x, rt, live);
    if (rt.bridge.intentRun && !x.target && !x.wide && !x.course) {
      const courses = scopeCourses(allowedBase);
      const context = { view: chat.origin.view, ...(courses.length === 1 ? {courseId: courses[0]!.key} : {}), ...(allowedBase.kind === 'item' ? {resourceId: allowedBase.item.id} : {}) };
      const result = await rt.bridge.intentRun({ operationId: x.id, text: x.prompt, context });
      if (!live()) return;
      return applyIntent(chat, x, result, rt, permitted, allowedBase);
    }
    const intent = routeIntent(x.prompt);
    let said: string | null = null;
    if (!x.target && !x.local && !x.course && !x.wide) {
      const base = allowedBase;
      const item = base.kind === "item" ? base.item : null;
      // A remembered item answers its own follow-ups on this device unless another item is named.
      const itemFirst = item && intent.kind === "ask" && !namesAnotherItem(x.prompt, item, rt.resources.filter((r) => !r.deleted).map((r) => chatItem(r, rt.sources)).filter((i) => i.courseKey === item.courseKey));
      if (!itemFirst) {
        const courses = scopeCourses(base), ref = courses.length === 1 ? courses[0]!.key : null;
        const preview = await previewIntent(rt.bridge, x.prompt, ref);
        if (!live()) return;
        if (preview?.action && !CHAT_READS.has(preview.action)) return update(chat, x, { state: "done", result: { kind: "action", action: preview.action, hint: preview.hint } });
        if (preview?.action) {
          update(chat, x, { step: preview.action === "ask" ? "answer" : "search" });
          const result = await runIntent(rt.bridge, x.prompt, ref);
          if (!live()) return;
          return applyIntent(chat, x, result, rt, permitted, base);
        }
        said = preview ? preview.slots.course ?? "" : null;
      }
    }
    const p = x.target ? null : plan(chat, x, permitted, said);
    if (p?.kind === "pick") return update(chat, x, { state: "done", result: p.result });
    const scope = permittedScope(p?.scope ?? currentScope(chat), permitted);
    if (!scope) return update(chat, x, { state: "failed", error: { text: "This course is no longer included. Choose an included course or update Sources.", setup: "sources" } });

    if (intent.kind === "due" && !x.target) {
      const courses = scopeCourses(scope);
      const label = scope.kind === "item" && scope.course ? scope.course.label : scopeLabel(scope);
      return update(chat, x, { state: "done", result: { kind: "due", span: intent.span, scopeLabel: label, rows: dueInScope(scope, rt.resources, rt.sources, rt.now, intent.span), caveat: dueCaveat(courses), courses } });
    }

    // The item to answer from: the one the student picked for this question, else the remembered
    // default unless the question names a different saved item.
    const fallback = scope.kind === "item" ? scope.item : null;
    const candidates = scopeCourses(scope).length
      ? rt.resources.filter((r) => !r.deleted).map((r) => chatItem(r, rt.sources)).filter((i) => scopeCourses(scope).some((c) => c.key === i.courseKey))
      : [];
    const chosen = x.target ?? (fallback && !(intent.kind === "ask" && namesAnotherItem(x.prompt, fallback, candidates)) ? fallback : null);
    if (chosen) {
      if (!rt.resources.length) return update(chat, x, { state: "failed", error: { text: "Saved items are still loading. Try again in a moment.", setup: null } });
      const target = refresh(chosen, rt);
      if (!target) return update(chat, x, { state: "failed", error: { text: `${chosen.title} is no longer in your saved workspace.`, setup: null } });
      if (!permits(permitted, target, chat.origin.scope)) return update(chat, x, { state: "failed", error: { text: `${target.title} is not in an included course.`, setup: "sources" } });
      if (intent.kind === "open") return await open(chat, x, target, rt, live);
      // An item question is answered by the student's connected Claude Code or Codex, scoped to that item.
      if (!rt.bridge.intentRun) return update(chat, x, { state: "failed", error: { text: "Answers need your connected Claude Code or Codex. Choose it in Data & AI.", setup: "local-model" } });
      update(chat, x, { step: "ask", target });
      const courseKey = target.courseKey;
      const result = await rt.bridge.intentRun({ operationId: x.id, text: x.prompt, context: { view: chat.origin.view, ...(courseKey ? { courseId: courseKey } : {}), resourceId: target.id } });
      if (!live()) return;
      return applyIntent(chat, x, result, rt, permitted, scope);
    }
    if (intent.kind === "open") return update(chat, x, { state: "done", result: { kind: "note", text: "Choose one item to open. Ask about it by name and pick it from the saved matches." } });

    const courses = scopeCourses(scope);
    if (!courses.length) {
      if (fallback) return update(chat, x, { state: "done", result: { kind: "choose", scopeLabel: scopeLabel(scope), items: [fallback], searched: false, wider: permitted.length > 0 } });
      return update(chat, x, { state: "failed", error: { text: "No courses are included yet, so there is nothing saved to answer from.", setup: "sources" } });
    }
    update(chat, x, { step: "search" });
    const allowed = new Set(courses.map((c) => c.key));
    const search = p?.kind === "scope" ? p.search : x.prompt;
    let items: ChatItem[] = [], searched = false;
    if (rt.bridge.query) {
      const single = courses.length === 1 ? courses[0]! : null;
      const found = await rt.bridge.query({ view: "resources", search: search.slice(0, 500), limit: 50, ...(single ? { courseId: single.courseId, accountScope: single.accountScope } : {}) });
      if (found.view === "resources") items = found.items.map((r) => chatItem(r, rt.sources));
      searched = true;
    } else {
      const terms = search.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
      items = rt.resources.filter((r) => !r.deleted && terms.some((t) => r.title.toLowerCase().includes(t))).map((r) => chatItem(r, rt.sources));
    }
    if (!live()) return;
    items = items.filter((i) => i.courseKey && allowed.has(i.courseKey));
    // The remembered item stays first, so keeping it is one click.
    if (fallback) items = [fallback, ...items.filter((i) => i.id !== fallback.id)];
    const wider = !x.wide && permitted.some((c) => !allowed.has(c.key));
    update(chat, x, { state: "done", step: null, result: { kind: "choose", scopeLabel: scopeLabel(scope.kind === "item" && scope.course ? { kind: "course", page: scope.page, course: scope.course } : scope), items: items.slice(0, 4), searched, wider } });
  } catch (cause) {
    if (!live()) return;
    update(chat, x, { state: "failed", step: null, error: { ...studentError(message(cause, ""), "Magic could not finish this request. Try again."), setup: null } });
  }
}

// owner: claude-chat
async function askClaude(chat: Chat, x: Exchange, rt: ChatRuntime, live: () => boolean) {
  const answer: Extract<ChatResult, { kind: "claude" }> = { kind: "claude", text: "", streaming: true, tools: [], sources: [], cards: null, ms: null };
  update(chat, x, { step: "answer", result: { ...answer } });
  const off = rt.bridge.onChatDelta?.((id, delta) => {
    if (id !== x.id || !live()) return;
    if (delta.text) answer.text += delta.text;
    if (delta.tool) answer.tools = [...answer.tools, delta.tool];
    update(chat, x, { step: delta.tool ? "search" : "answer", result: { ...answer, text: visibleText(answer.text) } });
  });
  try {
    const r = await rt.bridge.chatAsk!({ operationId: x.id, text: x.prompt });
    if (!live()) return;
    if (r.status === "setup")
      return update(chat, x, { state: "failed", step: null, result: null, error: { text: "Chat answers through your Claude Code. Choose it and sign in as Your AI.", setup: "local-model", detail: r.reason } });
    update(chat, x, { state: "done", step: null, result: { kind: "claude", text: r.text, streaming: false, tools: r.tools, sources: r.sources, cards: r.cards ? { status: r.cards.status, message: r.cards.message } : null, ms: r.ms } });
  } finally {
    off?.();
  }
}
/** While streaming, the code-read SOURCES/ACTION lines are hidden as soon as they start. */
function visibleText(text: string): string {
  return text.split(/\r?\n/).filter((line) => !/^\s*(SOURCES|ACTION):/i.test(line)).join("\n");
}
// end owner: claude-chat

/** Maps the router's result into the chat. Rows and items come from the same saved data the pages show. */
function applyIntent(chat: Chat, x: Exchange, r: IntentResult, rt: ChatRuntime, permitted: ChatCourse[], base: ChatScope) {
  const byKey = new Map(permitted.map((c) => [c.key, c]));
  // The send gate refused the connected client: say how to turn it on instead of the gate's bare reason.
  if (r.status === "unavailable" && /Fully local processing|hosted AI has not been selected|not agreed to share|Sharing course text is disabled/.test(r.reason))
    return update(chat, x, { state: "failed", step: null, error: { text: "Chat answers through your Claude Code or Codex. Choose it as Your AI in Data & AI.", setup: "local-model", detail: r.reason } });
  if (r.status === "unavailable") return update(chat, x, { state: "done", step: null, result: { kind: "unavailable", reason: r.reason } });
  if (r.status === "answer") return update(chat, x, { state: "done", step: null, result: { kind: "grounded", text: r.text, citations: r.citations, notFound: r.notFound, dropped: r.dropped, path: r.path } });
  if (r.status === "clarify") {
    const options = r.candidates.filter((c) => CHAT_READS.has(c.action)).flatMap((c) => {
      const matches = c.args.course ? permitted.filter((p) => [p.code, p.name, p.label].some((v) => v && v.toLowerCase() === c.args.course!.trim().toLowerCase())) : [];
      return matches.map((course) => ({ label: matches.length > 1 ? `${course.label} (${course.accountScope})` : course.label, course }));
    });
    const unique = [...new Map(options.map((o) => [o.course.key, o])).values()];
    return update(chat, x, { state: "done", step: null, result: { kind: "clarify", question: r.question, options: unique } });
  }
  if (r.status !== "ran") return update(chat, x, { state: "failed", step: null, error: { text: "Magic could not finish this request. Try again.", setup: null, detail: `Unexpected router status: ${r.status}` } });
  if (['page.open', 'course.open', 'assignment.open'].includes(r.action)) {
    const target = (r.result as {navigate?: {view: string; resourceId?: string; courseId?: string; accountScope?: string}})?.navigate;
    if (target && typeof target.view === 'string') {
      const valid = target.view === 'course' ? permitted.some(c => c.courseId === target.courseId && c.accountScope === target.accountScope)
        : target.view === 'assignment' ? rt.resources.some(row => !row.deleted && row.id === target.resourceId && permits(permitted, chatItem(row, rt.sources), chat.origin.scope))
        : ['today', 'courses', 'calendar', 'myuw'].includes(target.view);
      if (valid) { update(chat, x, {state: 'done', step: null, result: {kind: 'note', text: 'Opened the requested page.'}}); rt.onNavigate?.(target); return; }
    }
    return update(chat, x, {state: 'done', step: null, result: {kind: 'unavailable', reason: 'That page is no longer available.'}});
  }
  const named = intentCourse(r.args);
  const course = named ? byKey.get(named.ref) ?? null : null;
  // A course core resolved but that is not included here is refused, never read.
  if (named && !course) return update(chat, x, { state: "done", step: null, result: { kind: "course", reason: "unknown", text: named.code ?? named.name, courses: permitted } });
  if (course && (chat.course ?? originCourse(chat.origin.scope))?.key !== course.key) setCourse(chat, course);
  const scope: ChatScope = course ? { kind: "course", page: base.page, course } : base;
  if (r.action === "agenda.due") {
    const span = intentRange(r.args, r.result) ?? "week";
    const courses = scopeCourses(scope);
    const label = scope.kind === "item" && scope.course ? scope.course.label : scopeLabel(scope);
    return update(chat, x, { state: "done", step: null, result: { kind: "due", span, scopeLabel: label, rows: dueInScope(scope, rt.resources, rt.sources, rt.now, span), caveat: dueCaveat(courses), courses } });
  }
  if (r.action === "materials.search") {
    const items = intentHits(r.result).flatMap((h) => {
      const res = rt.resources.find((v) => v.id === h.resourceId && !v.deleted);
      const item = res ? chatItem(res, rt.sources) : null;
      return item && permits(permitted, item, chat.origin.scope) ? [item] : [];
    });
    const unique = [...new Map(items.map((i) => [i.id, i])).values()].slice(0, 4);
    return update(chat, x, { state: "done", step: null, result: { kind: "choose", scopeLabel: scopeLabel(scope), items: unique, searched: true, wider: false } });
  }
  // owner: voice-plan. The connected planner's final line, observed-result based; never a grounded answer.
  if (r.action === "voice.plan") return update(chat, x, { state: "done", step: null, result: { kind: "note", text: String((r.result as { say?: unknown } | null)?.say ?? "Done.").slice(0, 400) } });
  return update(chat, x, { state: "done", step: null, result: { kind: "note", text: `Magic ran ${r.action}.` } });
}

function refresh(item: ChatItem, rt: ChatRuntime): ChatItem | null {
  const current = rt.resources.find((r) => r.id === item.id && !r.deleted);
  return current ? chatItem(current, rt.sources) : null;
}
function message(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
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

/**
 * Stops this exchange only. The local runtime is shared, so it is cancelled only if this exchange owns it.
 * Limit: the desktop's cancel is not per request yet, so a run started elsewhere in the same instant can be
 * cancelled too (recorded as a backend finding).
 */
export function stop(chat: Chat, x: Exchange, bridge: ChatBridge) {
  if (x.state !== "running" && x.state !== "queued") return;
  tickets.set(x.id, (tickets.get(x.id) ?? 0) + 1);
  void bridge.cancelIntent?.(x.id).catch(() => undefined);
  void bridge.cancelChat?.(x.id).catch(() => undefined); // owner: claude-chat
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
const idle = (chat: Chat) => !chat.exchanges.some((e) => e.state === "running");
/**
 * Picking a match answers the same question from that one item and makes it the default for follow-ups.
 * `course` is the item's included course when it is not the origin's.
 */
export function choose(chat: Chat, x: Exchange, item: ChatItem, course: ChatCourse | null = null) {
  if (!idle(chat)) return;
  if (course && course.key === item.courseKey && chat.course?.key !== course.key) setCourse(chat, course);
  chat.narrowed = item;
  update(chat, x, { target: item, state: "queued", result: null, error: null });
}
/** Picking a course when the named one was ambiguous or not included. */
export function chooseCourse(chat: Chat, x: Exchange, course: ChatCourse) {
  if (!idle(chat)) return;
  update(chat, x, { course, state: "queued", result: null, error: null });
}
/** The student chose to answer from one saved item on this device instead of the router. */
export function answerLocally(chat: Chat, x: Exchange) {
  if (!idle(chat)) return;
  update(chat, x, { local: true, state: "queued", result: null, error: null });
}
/** The student asked to search every included course for this question. */
export function searchAll(chat: Chat, x: Exchange) {
  if (!idle(chat)) return;
  update(chat, x, { wide: true, state: "queued", result: null, error: null });
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
