import test from "node:test";
import assert from "node:assert/strict";
import type { ResourceView, SourceHealth } from "@magic/contracts";
import type { CourseCard, CoursePage } from "../packages/domain/src/course-page";
import {
  answerIsStale, chatItem, chatScopeForPage, coverageLine, dueCaveat, dueInScope, localErrorNeedsSetup,
  narrowTo, routeIntent, safeWebLink, scopeLabel,
} from "../apps/desktop/src/renderer/chat/model";
import {
  choose, continueChat, drive, getChat, resetChats, retry, startChat, stop, subscribe,
  type ChatBridge, type ChatOrigin, type ChatRuntime,
} from "../apps/desktop/src/renderer/chat/store";

const now = "2026-09-27T15:00:00Z";
const sources = [
  { id: "canvas-a", accountScope: "uw" },
  { id: "canvas-b", accountScope: "other" },
] as SourceHealth[];
const card = (key: string, courseId: string, name: string, freshness: CourseCard["freshness"] = "current_capture") =>
  ({ key, courseId, courseName: name, rawCourseName: `${name} (Fall 2026) raw`, code: "COMPSCI 220", cue: "", next: null, freshness, syllabusMissing: false }) as CourseCard;
const cards = [card("uw:220", "220", "Software Design"), card("other:220", "220", "Other 220", "partial")];
const resource = (id: string, sourceId: string, courseId: string, dueAt: string | null, extra: Partial<ResourceView> = {}) =>
  ({ id, sourceId, courseId, kind: "assignment", title: `Work ${id}`, contentHash: `h-${id}`, url: `https://canvas.wisc.edu/courses/${courseId}/assignments/${id}`,
    observedAt: "2026-09-26T20:00:00Z", policy: { mode: "unknown", evidence: "" }, kindLabel: "Assignment", deleted: false, completed: false,
    submitted: false, dueAt, deadline: { dueAt }, courseName: "Software Design", ...extra }) as unknown as ResourceView;
const resources = [
  resource("a1", "canvas-a", "220", "2026-09-28T04:59:00Z"),
  resource("a2", "canvas-a", "220", "2026-10-20T04:59:00Z"),
  resource("b1", "canvas-b", "220", "2026-09-28T05:00:00Z"),
  resource("a3", "canvas-a", "220", "2026-09-29T04:59:00Z", { submitted: true } as Partial<ResourceView>),
  resource("a4", "canvas-a", "220", "2026-09-29T04:59:00Z", { completed: true }),
];
const page = { key: "uw:220", accountScope: "uw", courseId: "220", courseName: "Software Design", rawCourseName: "raw", code: "COMPSCI 220", freshness: "current_capture", lastSuccessAt: "2026-09-27T12:00:00Z" } as CoursePage;

test("scope follows the page and keeps account identity apart", () => {
  const home = chatScopeForPage({ page: "today", cards, sources });
  assert.equal(home.kind, "workspace");
  assert.equal(scopeLabel(home), "2 included courses");
  const course = chatScopeForPage({ page: "courses", course: page, cards, sources });
  assert.equal(course.kind === "course" && course.course.accountScope, "uw");
  assert.equal(course.kind === "course" && course.course.label, "COMPSCI 220 · Software Design");
  const item = chatScopeForPage({ page: "resource", resource: resources[2], cards, sources });
  assert.equal(item.kind === "item" && item.course?.key, "other:220", "same course number in another account is a different course");
});

test("narrowing stays inside the originating scope and never widens", () => {
  const course = chatScopeForPage({ page: "courses", course: page, cards, sources });
  assert.equal(narrowTo(course, chatItem(resources[0]!, sources))?.kind, "item");
  assert.equal(narrowTo(course, chatItem(resources[2]!, sources)), null, "other account's 220 is outside");
  const item = chatScopeForPage({ page: "resource", resource: resources[0], cards, sources });
  assert.equal(narrowTo(item, chatItem(resources[1]!, sources)), null);
});

test("due list uses saved deadlines, account-scoped, keeps submitted visible and never claims done", () => {
  const course = chatScopeForPage({ page: "courses", course: page, cards, sources });
  const rows = dueInScope(course, resources, sources, now, 7);
  assert.deepEqual(rows.map((r) => r.id), ["a1", "a3"]);
  assert.equal(rows[1]!.submitted, true);
  const home = chatScopeForPage({ page: "today", cards, sources });
  assert.deepEqual(dueInScope(home, resources, sources, now, 7).map((r) => r.id), ["a1", "b1", "a3"]);
  assert.equal(dueCaveat(course.kind === "course" ? [course.course] : []), null);
  assert.match(dueCaveat(home.kind === "workspace" ? home.courses : []) ?? "", /only partly checked, so more work may be due/);
});

test("coverage never reads partial, stale or unknown as checked", () => {
  const home = chatScopeForPage({ page: "today", cards, sources });
  assert.match(coverageLine(home.kind === "workspace" ? home.courses : []), /^Partly checked/);
  assert.equal(coverageLine([]), "No courses are included yet");
  const stale = chatScopeForPage({ page: "today", cards: [card("uw:1", "1", "X", "stale")], sources });
  assert.equal(coverageLine(stale.kind === "workspace" ? stale.courses : []), "Not checked yet");
  const unknown = chatScopeForPage({ page: "today", cards: [card("uw:1", "1", "X", "unknown"), cards[0]!], sources });
  assert.equal(coverageLine(unknown.kind === "workspace" ? unknown.courses : []), "Freshness unknown");
});

test("routing is code-first and conservative", () => {
  assert.deepEqual(routeIntent("What's due this week?"), { kind: "due", days: 7 });
  assert.deepEqual(routeIntent("anything due today"), { kind: "due", days: 1 });
  assert.deepEqual(routeIntent("open in canvas"), { kind: "open" });
  assert.equal(routeIntent("Why does the rubric say the due date matters for partial credit on the design doc and what should I focus on first when revising?").kind, "ask");
  assert.equal(routeIntent("Explain dependency injection from the reading").kind, "ask");
});

test("answers are bound to the version they read; links must be plain https", () => {
  const item = chatItem(resources[0]!, sources);
  const answer = { resourceId: "a1", inputHash: "h-a1" };
  assert.equal(answerIsStale(answer, item), false);
  assert.equal(answerIsStale(answer, { ...item, contentHash: "h-new" }), true);
  assert.equal(safeWebLink("https://canvas.wisc.edu/x"), "https://canvas.wisc.edu/x");
  assert.equal(safeWebLink("http://canvas.wisc.edu/x"), null);
  assert.equal(safeWebLink("https://user:pw@canvas.wisc.edu/x"), null);
  assert.equal(safeWebLink("file:///etc/passwd"), null);
});

test("setup errors offer setup; evidence and policy errors do not", () => {
  assert.equal(localErrorNeedsSetup("Start a compatible local Ollama service with cloud disabled."), true);
  assert.equal(localErrorNeedsSetup("No installed model exactly matches a suitable llmfit recommendation"), true);
  assert.equal(localErrorNeedsSetup("This item changed. Review its current evidence and ask again."), false);
  assert.equal(localErrorNeedsSetup("This course is excluded. Include it in Sources before sharing its data."), false);
});

// Store: entry, idempotency, runs. Synthetic fixtures and a fake bridge; no live model or Canvas.
const origin = (scope = chatScopeForPage({ page: "courses", course: page, cards, sources })): ChatOrigin =>
  ({ view: "courses", resourceId: null, courseKey: "uw:220", label: "COMPSCI 220", focusKey: "course-row-a1", anchor: "course-work", offset: 12, scroll: 340, scope });
const settle = () => new Promise((r) => setTimeout(r, 0));
function runtime(bridge: Partial<ChatBridge> = {}): ChatRuntime {
  return { bridge: { openExternal: async () => undefined, ...bridge } as ChatBridge, resources, sources, now };
}
const answerFor = (id: string, hash: string) => ({ text: "Start with the interface.", model: "qwen3:8b", policyLimited: false, recipient: "local" as const, resourceId: id, inputHash: hash, sourceTitle: `Work ${id}`, sourceUrl: "", observedAt: "2026-09-26T20:00:00Z" });

test("only a nonempty submit creates a chat; each new submit is a new chat; the same key is the same chat", () => {
  resetChats();
  assert.equal(startChat({ prompt: "   ", origin: origin(), idempotencyKey: "k0" }), null);
  const a = startChat({ prompt: "What's due this week?", origin: origin(), idempotencyKey: "k1" })!;
  const again = startChat({ prompt: "What's due this week?", origin: origin(), idempotencyKey: "k1" })!;
  const b = startChat({ prompt: "What's due this week?", origin: origin(), idempotencyKey: "k2" })!;
  assert.equal(a.created, true);
  assert.equal(again.created, false);
  assert.equal(again.chat.id, a.chat.id);
  assert.notEqual(b.chat.id, a.chat.id, "same page and prompt still starts a new chat");
  assert.equal(b.chat.exchanges.length, 1);
  assert.deepEqual({ ...b.chat.origin, scope: undefined }, { ...origin(), scope: undefined }, "origin is returned unchanged for Back");
});

test("due answer is code-resolved, account-scoped and honest about coverage", async () => {
  resetChats();
  const home = chatScopeForPage({ page: "today", cards, sources });
  const { chat } = startChat({ prompt: "what's due this week", origin: { ...origin(home), view: "today", label: "Home" }, idempotencyKey: "d" })!;
  drive(chat, runtime());
  await settle();
  const r = chat.exchanges[0]!.result;
  assert.equal(r?.kind, "due");
  if (r?.kind !== "due") return;
  assert.deepEqual(r.rows.map((x) => x.id), ["a1", "b1", "a3"]);
  assert.match(r.caveat ?? "", /more work may be due/);
});

test("course question searches only its own account and course, then asks one chosen item bound to its hash", async () => {
  resetChats();
  const queries: unknown[] = [], asks: unknown[] = [];
  const rt = runtime({
    query: (async (q: unknown) => { queries.push(q); return { view: "resources", items: [resources[0], resources[2]] }; }) as unknown as ChatBridge["query"],
    localAsk: async (q) => { asks.push(q); return answerFor(q.id, q.inputHash); },
  });
  const { chat } = startChat({ prompt: "Explain the interface design reading", origin: origin(), idempotencyKey: "s" })!;
  drive(chat, rt);
  await settle();
  const x = chat.exchanges[0]!;
  assert.deepEqual(queries[0], { view: "resources", search: "Explain the interface design reading", limit: 50, courseId: "220", accountScope: "uw" });
  assert.equal(x.result?.kind, "choose");
  if (x.result?.kind !== "choose") return;
  assert.deepEqual(x.result.items.map((i) => i.id), ["a1"], "the other account's 220 is filtered out");
  choose(chat, x, x.result.items[0]!);
  drive(chat, rt);
  await settle();
  assert.deepEqual(asks[0], { id: "a1", inputHash: "h-a1", question: "Explain the interface design reading" });
  assert.equal(x.result?.kind, "answer");
  assert.equal(chat.narrowed?.id, "a1", "follow-ups stay on the chosen item");
  assert.equal(continueChat(chat.id, "And the rubric?", "f1"), true);
  assert.equal(continueChat(chat.id, "And the rubric?", "f1"), true);
  assert.equal(chat.exchanges.length, 2, "a repeated follow-up key is not sent twice");
  assert.equal(chat.exchanges[1]!.target?.id, "a1");
});

test("no fake course-wide answer: without a matching item nothing is generated", async () => {
  resetChats();
  let asked = false;
  const rt = runtime({ query: (async () => ({ view: "resources", items: [] })) as unknown as ChatBridge["query"], localAsk: async () => { asked = true; throw new Error("no"); } });
  const { chat } = startChat({ prompt: "Summarize everything in this course", origin: origin(), idempotencyKey: "n" })!;
  drive(chat, rt);
  await settle();
  assert.equal(asked, false);
  assert.deepEqual(chat.exchanges[0]!.result, { kind: "choose", scopeLabel: "COMPSCI 220 · Software Design", items: [], searched: true });
});

test("failures stay inline with retry and setup; a mismatched answer version is not shown", async () => {
  resetChats();
  const item = chatScopeForPage({ page: "resource", resource: resources[0], cards, sources });
  let calls = 0;
  const rt = runtime({ localAsk: async (q) => { calls++; if (calls === 1) throw new Error("Start a compatible local Ollama service with cloud disabled."); if (calls === 2) return answerFor(q.id, "h-old"); return answerFor(q.id, q.inputHash); } });
  const { chat } = startChat({ prompt: "Where do I start?", origin: origin(item), idempotencyKey: "e" })!;
  const x = chat.exchanges[0]!;
  drive(chat, rt); await settle();
  assert.equal(x.state, "failed");
  assert.equal(x.error?.setup, "local-model");
  retry(chat, x); drive(chat, rt); await settle();
  assert.equal(x.state, "failed");
  assert.match(x.error?.text ?? "", /did not match this item's current version/);
  retry(chat, x); drive(chat, rt); await settle();
  assert.equal(x.state, "done");
  assert.equal(x.result?.kind, "answer");
});

test("stop cancels only this chat's own local run and a late answer is dropped", async () => {
  resetChats();
  const item = chatScopeForPage({ page: "resource", resource: resources[0], cards, sources });
  let release!: () => void, cancels = 0;
  const rt = runtime({
    localAsk: (q) => new Promise((resolve) => { release = () => resolve(answerFor(q.id, q.inputHash)); }),
    cancelLocal: async () => { cancels++; },
  });
  const one = startChat({ prompt: "First", origin: origin(item), idempotencyKey: "p1" })!.chat;
  const two = startChat({ prompt: "Second", origin: origin(item), idempotencyKey: "p2" })!.chat;
  drive(one, rt); await settle();
  assert.equal(one.exchanges[0]!.step, "ask");
  drive(two, rt); await settle();
  assert.equal(two.exchanges[0]!.state, "failed", "the device runs one local request at a time");
  assert.match(two.exchanges[0]!.error?.text ?? "", /still running/);
  stop(two, two.exchanges[0]!, rt.bridge);
  assert.equal(cancels, 0, "a chat cannot cancel another chat's run");
  stop(one, one.exchanges[0]!, rt.bridge);
  assert.equal(cancels, 1);
  release(); await settle();
  assert.equal(one.exchanges[0]!.state, "stopped");
  assert.equal(one.exchanges[0]!.result, null);
});

test("an item that disappeared is reported, not answered from memory; empty scope routes to Sources", async () => {
  resetChats();
  const item = chatScopeForPage({ page: "resource", resource: resources[1], cards, sources });
  const gone = { ...runtime({ localAsk: async () => { throw new Error("should not ask"); } }), resources: resources.filter((r) => r.id !== "a2") };
  const { chat } = startChat({ prompt: "Explain", origin: origin(item), idempotencyKey: "g" })!;
  drive(chat, gone); await settle();
  assert.match(chat.exchanges[0]!.error?.text ?? "", /no longer in your saved workspace/);
  const empty = chatScopeForPage({ page: "today", cards: [], sources });
  const e = startChat({ prompt: "Explain recursion", origin: origin(empty), idempotencyKey: "z" })!.chat;
  drive(e, runtime()); await settle();
  assert.equal(e.exchanges[0]!.error?.setup, "sources");
});

test("chats are memory only, bounded, and notify subscribers", () => {
  resetChats();
  let n = 0;
  const off = subscribe(() => n++);
  const first = startChat({ prompt: "What's due today", origin: origin(), idempotencyKey: "m0" })!.chat;
  first.exchanges[0]!.state = "done";
  for (let i = 1; i <= 12; i++) startChat({ prompt: "What's due today", origin: origin(), idempotencyKey: `m${i}` })!.chat.exchanges[0]!.state = "done";
  off();
  assert.equal(getChat(first.id), null, "the oldest idle chat is dropped past the limit");
  assert.ok(n >= 13);
});
