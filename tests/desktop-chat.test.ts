import test from "node:test";
import assert from "node:assert/strict";
import type { ResourceView, SourceHealth } from "@magic/contracts";
import type { CourseCard, CoursePage } from "../packages/domain/src/course-page";
import {
  answerIsStale, chatCourse, chatItem, chatScopeForPage, coverageBlocker, coverageLine, dueCaveat, dueInScope, localErrorIsBusy,
  localErrorNeedsSetup, namesAnotherItem, permits, permittedCourses, resolveCourseMention, routeIntent, safeWebLink, scopeLabel,
  studentError, withoutMention,
} from "../apps/desktop/src/renderer/chat/model";
import {
  answerLocally, chatPromptError, choose, chooseCourse, continueChat, drive, getChat, goneOrigin, resetChats, retry, searchAll, startChat, stop, subscribe,
  type ChatBridge, type ChatOrigin, type ChatRuntime,
} from "../apps/desktop/src/renderer/chat/store";
import { previewIntent, runIntent, intentSupport, resetIntentSupport, type IntentResult } from "../apps/desktop/src/renderer/chat/intent";

// Synthetic fixtures and fake bridges only; no live model, Canvas, database or auth.
const now = "2026-09-27T15:00:00Z";
const sources = [
  { id: "canvas-a", accountScope: "uw" },
  { id: "canvas-b", accountScope: "other" },
] as SourceHealth[];
const card = (key: string, courseId: string, name: string, freshness: CourseCard["freshness"] = "current_capture", code = "COMPSCI 220") =>
  ({ key, courseId, courseName: name, rawCourseName: `${code} ${name} (Fall 2026) raw`, code, cue: "", next: null, freshness, syllabusMissing: false }) as CourseCard;
const cards = [card("uw:220", "220", "Software Design"), card("other:220", "220", "Other 220", "partial")];
const bioCard = card("uw:120", "120", "Biology", "current_capture", "BIOLOGY 120");
/** What the student has included: their UW courses. The other account's 220 is not included. */
const included = [chatCourse(cards[0]!), chatCourse(bioCard)];
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
  resource("bio1", "canvas-a", "120", "2026-09-29T04:59:00Z", { title: "Lab report: osmosis" }),
  resource("bio2", "canvas-a", "120", null, { kind: "page", kindLabel: "Page", title: "Reading: membrane transport" } as unknown as Partial<ResourceView>),
  resource("r5", "canvas-a", "220", null, { kind: "page", kindLabel: "Page", title: "Reading: APIs and debugging" } as unknown as Partial<ResourceView>),
  resource("r6", "canvas-a", "220", null, { kind: "page", kindLabel: "Page", title: "Reading: testing seams" } as unknown as Partial<ResourceView>),
];
const page = { key: "uw:220", accountScope: "uw", courseId: "220", courseName: "Software Design", rawCourseName: "raw", code: "COMPSCI 220", freshness: "current_capture", lastSuccessAt: "2026-09-27T12:00:00Z" } as CoursePage;
const courseScope = () => chatScopeForPage({ page: "courses", course: page, cards, sources });

test("scope follows the page and keeps account identity apart", () => {
  const home = chatScopeForPage({ page: "today", cards, sources });
  assert.equal(home.kind, "workspace");
  assert.equal(scopeLabel(home), "2 included courses");
  const course = courseScope();
  assert.equal(course.kind === "course" && course.course.accountScope, "uw");
  assert.equal(course.kind === "course" && course.course.label, "COMPSCI 220 · Software Design");
  const item = chatScopeForPage({ page: "resource", resource: resources[2], cards, sources });
  assert.equal(item.kind === "item" && item.course?.key, "other:220", "same course number in another account is a different course");
});

test("account boundary: an included course may be used; another account's same-numbered course may not", () => {
  const permitted = permittedCourses(courseScope(), included);
  assert.deepEqual(permitted.map((c) => c.key), ["uw:220", "uw:120"]);
  assert.equal(permits(permitted, chatItem(resources[0]!, sources)), true);
  assert.equal(permits(permitted, chatItem(resources[5]!, sources)), true, "an explicitly named included course is allowed");
  assert.equal(permits(permitted, chatItem(resources[2]!, sources)), false, "other account's 220 is not included");
  const item = chatScopeForPage({ page: "resource", resource: resources[2], cards, sources });
  assert.equal(permits(permitted, chatItem(resources[2]!, sources), item), false, "historical origin cannot override current course inclusion");
});

test("course mentions resolve by code only against permitted courses; ambiguity and unknown codes are explicit", () => {
  const permitted = [...included, chatCourse(cards[1]!)];
  const one = resolveCourseMention("What's due in BIOLOGY 120 this week?", included);
  assert.equal(one.kind === "one" && one.course.key, "uw:120");
  assert.equal(resolveCourseMention("explain the bio 120 reading", included).kind, "one");
  assert.equal(resolveCourseMention("anything for comp sci 220", included).kind, "one");
  const both = resolveCourseMention("What's due in CS 220?", permitted);
  assert.equal(both.kind, "ambiguous");
  assert.deepEqual(both.kind === "ambiguous" && both.courses.map((c) => c.key).sort(), ["other:220", "uw:220"]);
  assert.deepEqual(resolveCourseMention("Is ECON 101 on my list?", included), { kind: "unknown", text: "ECON 101" });
  assert.equal(resolveCourseMention("the top 100 tips on page 220", included).kind, "none");
  assert.equal(resolveCourseMention("Explain the interface reading", included).kind, "none");
  const bio = resolveCourseMention("Explain the membrane transport reading for Biology 120", included);
  assert.equal(withoutMention("Explain the membrane transport reading for Biology 120", bio), "Explain the membrane transport reading");
});

test("a remembered item is a default: a follow-up naming another saved item is not sent to it", () => {
  const items = resources.map((r) => chatItem(r, sources));
  const apis = items.find((i) => i.id === "r5")!;
  assert.equal(namesAnotherItem("Now explain the testing seams reading", apis, items), true);
  assert.equal(namesAnotherItem("And the rubric?", apis, items), false);
  assert.equal(namesAnotherItem("Where do I start?", apis, items), false);
});

test("due list uses saved deadlines by calendar day, account-scoped, keeps submitted visible and never claims done", () => {
  const course = courseScope();
  const rows = dueInScope(course, resources, sources, now, "week");
  assert.deepEqual(rows.map((r) => r.id), ["a1", "a3"]);
  assert.equal(rows[1]!.submitted, true);
  const home = chatScopeForPage({ page: "today", cards, sources });
  assert.deepEqual(dueInScope(home, resources, sources, now, "week").map((r) => r.id), ["a1", "b1", "a3"]);
  assert.equal(dueCaveat(course.kind === "course" ? [course.course] : []), null);
  assert.match(dueCaveat(home.kind === "workspace" ? home.courses : []) ?? "", /only partly checked, so more work may be due/);
});

test("today is today only: tomorrow is excluded and earlier-today unsubmitted work stays as past due", () => {
  const local = (d: number, h: number) => new Date(2026, 8, d, h).toISOString();
  const at3pm = local(27, 15);
  const day = [
    resource("lab", "canvas-a", "220", local(27, 12)),
    resource("done", "canvas-a", "220", local(27, 11), { submitted: true } as Partial<ResourceView>),
    resource("late", "canvas-a", "220", local(27, 23)),
    resource("quiz", "canvas-a", "220", local(28, 9)),
  ];
  const today = dueInScope(courseScope(), day, sources, at3pm, "today");
  assert.deepEqual(today.map((r) => [r.id, r.pastDue]), [["done", false], ["lab", true], ["late", false]]);
  assert.deepEqual(dueInScope(courseScope(), day, sources, at3pm, "tomorrow").map((r) => r.id), ["quiz"]);
  assert.deepEqual(dueInScope(courseScope(), day, sources, at3pm, { from: "2026-09-28", to: "2026-09-28", label: "tomorrow" }).map((r) => r.id), ["quiz"]);
});

test("coverage never reads partial, stale or unknown as checked; only those are visible blockers", () => {
  const home = chatScopeForPage({ page: "today", cards, sources });
  assert.match(coverageLine(home.kind === "workspace" ? home.courses : []), /^Partly checked/);
  assert.equal(coverageBlocker(home.kind === "workspace" ? home.courses : []), "Partly checked");
  assert.equal(coverageBlocker(included), null, "a current check is routine detail, not a body cue");
  assert.equal(coverageLine([]), "No courses are included yet");
  const stale = chatScopeForPage({ page: "today", cards: [card("uw:1", "1", "X", "stale")], sources });
  assert.equal(coverageLine(stale.kind === "workspace" ? stale.courses : []), "Not checked yet");
  const unknown = chatScopeForPage({ page: "today", cards: [card("uw:1", "1", "X", "unknown"), cards[0]!], sources });
  assert.equal(coverageLine(unknown.kind === "workspace" ? unknown.courses : []), "Freshness unknown");
});

test("routing is code-first and conservative", () => {
  assert.deepEqual(routeIntent("What's due this week?"), { kind: "due", span: "week" });
  assert.deepEqual(routeIntent("anything due today"), { kind: "due", span: "today" });
  assert.deepEqual(routeIntent("What\u2019s due in BIOLOGY 120 this week?"), { kind: "due", span: "week" }, "smart quotes route the same");
  assert.deepEqual(routeIntent("open in canvas"), { kind: "open" });
  assert.deepEqual(routeIntent("open it"), { kind: "open" });
  assert.equal(routeIntent("Open the rubric for the essay").kind, "ask", "a named target is searched, not opened blind");
  assert.equal(routeIntent("What is the due date policy for late work?").kind, "ask");
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

test("setup errors offer setup; a busy runtime, evidence and policy errors do not; raw blobs stay out of the body", () => {
  assert.equal(localErrorNeedsSetup("Start a compatible local Ollama service with cloud disabled."), true);
  assert.equal(localErrorNeedsSetup("No installed model exactly matches a suitable llmfit recommendation"), true);
  assert.equal(localErrorNeedsSetup("This item changed. Review its current evidence and ask again."), false);
  assert.equal(localErrorNeedsSetup("This course is excluded. Include it in Sources before sharing its data."), false);
  const busy = "A local AI request is already running. Cancel it before starting another.";
  assert.equal(localErrorIsBusy(busy), true);
  assert.equal(localErrorNeedsSetup(busy), false);
  const blob = "Error invoking remote method 'magic:execute': ZodError: [\n  {\n    \"code\": \"invalid_union\" } ]";
  assert.deepEqual(studentError(blob, "Magic could not finish this request. Try again."), { text: "Magic could not finish this request. Try again.", detail: blob });
  assert.deepEqual(studentError("This item changed.", "x"), { text: "This item changed.", detail: null });
});

// Store: entry, idempotency, runs. The bridge has no router here, so the on-device path is used.
const origin = (scope = courseScope()): ChatOrigin =>
  ({ view: "courses", resourceId: null, courseKey: "uw:220", label: "COMPSCI 220", focusKey: "course-row-a1", anchor: "course-work", offset: 12, scroll: 340, scope });
const settle = () => new Promise((r) => setTimeout(r, 0));
function runtime(bridge: Partial<ChatBridge> = {}, courses = included): ChatRuntime {
  return { bridge: { openExternal: async () => undefined, ...bridge } as ChatBridge, resources, sources, courses, now };
}
const answerFor = (id: string, hash: string) => ({ text: "Start with the interface.", model: "qwen3:8b", policyLimited: false, recipient: "local" as const, resourceId: id, inputHash: hash, sourceTitle: `Work ${id}`, sourceUrl: "", observedAt: "2026-09-26T20:00:00Z" });
const searchOf = (items: ResourceView[], log: unknown[] = []) =>
  (async (q: unknown) => { log.push(q); return { view: "resources", items }; }) as unknown as ChatBridge["query"];

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
  drive(chat, runtime({}, cards.map(card => chatCourse(card)))); await settle();
  const r = chat.exchanges[0]!.result;
  assert.equal(r?.kind, "due");
  if (r?.kind !== "due") return;
  assert.deepEqual(r.rows.map((x) => x.id), ["a1", "b1", "a3"]);
  assert.match(r.caveat ?? "", /more work may be due/);
});

test("P1-1: an explicit question about another included course answers from that course; origin stays for Back", async () => {
  resetChats();
  const { chat } = startChat({ prompt: "What's due in BIOLOGY 120 this week?", origin: origin(), idempotencyKey: "bio" })!;
  drive(chat, runtime()); await settle();
  const r = chat.exchanges[0]!.result;
  assert.equal(r?.kind === "due" && r.scopeLabel, "BIOLOGY 120 · Biology");
  assert.deepEqual(r?.kind === "due" && r.rows.map((x) => x.id), ["bio1"]);
  assert.equal(chat.origin.scope.kind === "course" && chat.origin.scope.course.key, "uw:220", "origin is immutable");
  assert.equal(chat.course?.key, "uw:120", "the named course is the default for follow-ups");
  continueChat(chat.id, "What's due in COMPSCI 220 this week?", "back-to-cs");
  drive(chat, runtime()); await settle();
  const cs = chat.exchanges[1]!.result;
  assert.deepEqual(cs?.kind === "due" && cs.rows.map((x) => x.id), ["a1", "a3"], "the other account's 220 is never listed");
  assert.equal(chat.course, null, "naming the origin course returns to it");
});

test("ambiguity is a real choice: the same code in two included accounts asks which one", async () => {
  resetChats();
  const both = [...included, chatCourse(cards[1]!)];
  const home = chatScopeForPage({ page: "today", cards: [...cards, bioCard], sources });
  const { chat } = startChat({ prompt: "What's due in CS 220 this week?", origin: { ...origin(home), label: "Home" }, idempotencyKey: "amb" })!;
  drive(chat, runtime({}, both)); await settle();
  const x = chat.exchanges[0]!;
  assert.equal(x.result?.kind === "course" && x.result.reason, "ambiguous");
  if (x.result?.kind !== "course") return;
  chooseCourse(chat, x, x.result.courses.find((c) => c.key === "other:220")!);
  drive(chat, runtime({}, both)); await settle();
  const after = chat.exchanges[0]!.result as { kind: string; rows?: { id: string }[] };
  assert.deepEqual(after.kind === "due" && after.rows!.map((row) => row.id), ["b1"]);
  resetChats();
  const unknown = startChat({ prompt: "What's due in ECON 101?", origin: origin(), idempotencyKey: "econ" })!.chat;
  drive(unknown, runtime()); await settle();
  assert.equal(unknown.exchanges[0]!.result?.kind === "course" && unknown.exchanges[0]!.result.reason, "unknown");
});

test("P1-2: an item question naming another included course searches that course; searching all stays inside permitted courses", async () => {
  resetChats();
  const queries: unknown[] = [], asks: unknown[] = [];
  const rt = runtime({ query: searchOf([resources[6]!], queries), localAsk: async (q) => { asks.push(q); return answerFor(q.id, q.inputHash); } });
  const { chat } = startChat({ prompt: "Explain the membrane transport reading for Biology 120", origin: origin(), idempotencyKey: "p12" })!;
  drive(chat, rt); await settle();
  assert.deepEqual(queries[0], { view: "resources", search: "Explain the membrane transport reading", limit: 50, courseId: "120", accountScope: "uw" });
  const x = chat.exchanges[0]!;
  assert.deepEqual(x.result?.kind === "choose" && x.result.items.map((i) => i.id), ["bio2"]);
  if (x.result?.kind !== "choose") return;
  choose(chat, x, x.result.items[0]!);
  drive(chat, rt); await settle();
  assert.equal((asks[0] as { id: string }).id, "bio2");

  resetChats();
  const wide: unknown[] = [];
  const rt2 = runtime({ query: (async (q: { courseId?: string }) => { wide.push(q); return { view: "resources", items: q.courseId ? [] : [resources[6], resources[2]] }; }) as unknown as ChatBridge["query"] });
  const c2 = startChat({ prompt: "Summarize the osmosis worksheet", origin: origin(), idempotencyKey: "wide" })!.chat;
  drive(c2, rt2); await settle();
  const y = c2.exchanges[0]!;
  assert.equal(y.result?.kind === "choose" && y.result.items.length, 0);
  assert.equal(y.result?.kind === "choose" && y.result.wider, true, "no-match offers searching all included courses");
  searchAll(c2, y);
  drive(c2, rt2); await settle();
  assert.equal((wide[1] as { courseId?: string }).courseId, undefined);
  assert.deepEqual(y.result?.kind === "choose" && y.result.items.map((i) => i.id), ["bio2"], "the other account's item is refused");
});

test("P1-3: a picked item answers follow-ups by default, and a follow-up naming another item is not sent to it", async () => {
  resetChats();
  const asks: { id: string }[] = [];
  const rt = runtime({ query: searchOf([resources[7]!, resources[8]!, resources[2]!]), localAsk: async (q) => { asks.push(q); return answerFor(q.id, q.inputHash); } });
  const { chat } = startChat({ prompt: "Explain the APIs reading", origin: origin(), idempotencyKey: "s" })!;
  drive(chat, rt); await settle();
  const x = chat.exchanges[0]!;
  assert.deepEqual(x.result?.kind === "choose" && x.result.items.map((i) => i.id), ["r5", "r6"], "the other account's 220 is filtered out");
  if (x.result?.kind !== "choose") return;
  choose(chat, x, x.result.items[0]!);
  drive(chat, rt); await settle();
  assert.equal(asks[0]!.id, "r5");
  assert.equal(chat.narrowed?.id, "r5");
  continueChat(chat.id, "And the rubric?", "f1");
  assert.equal(continueChat(chat.id, "And the rubric?", "f1"), true);
  assert.equal(chat.exchanges.length, 2, "a repeated follow-up key is not sent twice");
  drive(chat, rt); await settle();
  assert.equal(asks[1]!.id, "r5", "a follow-up without another name stays on the picked item");
  continueChat(chat.id, "Now explain the testing seams reading", "f2");
  drive(chat, rt); await settle();
  const z = chat.exchanges[2]!;
  assert.equal(asks.length, 2, "not answered from the APIs reading");
  assert.deepEqual(z.result?.kind === "choose" && z.result.items.map((i) => i.id).slice(0, 2), ["r5", "r6"], "remembered item first, the named one offered");
});

test("no fake course-wide answer: without a matching item nothing is generated", async () => {
  resetChats();
  let asked = false;
  const rt = runtime({ query: searchOf([]), localAsk: async () => { asked = true; throw new Error("no"); } });
  const { chat } = startChat({ prompt: "Summarize everything in this course", origin: origin(), idempotencyKey: "n" })!;
  drive(chat, rt); await settle();
  assert.equal(asked, false);
  assert.deepEqual(chat.exchanges[0]!.result, { kind: "choose", scopeLabel: "COMPSCI 220 · Software Design", items: [], searched: true, wider: true });
});

test("failures stay inline with retry and setup; a busy runtime is not a setup problem; a mismatched version is not shown", async () => {
  resetChats();
  const item = chatScopeForPage({ page: "resource", resource: resources[0], cards, sources });
  let calls = 0;
  const rt = runtime({ localAsk: async (q) => {
    calls++;
    if (calls === 1) throw new Error("Start a compatible local Ollama service with cloud disabled.");
    if (calls === 2) throw new Error("A local AI request is already running. Cancel it before starting another.");
    if (calls === 3) return answerFor(q.id, "h-old");
    return answerFor(q.id, q.inputHash);
  } });
  const { chat } = startChat({ prompt: "Where do I start?", origin: origin(item), idempotencyKey: "e" })!;
  const x = chat.exchanges[0]!;
  drive(chat, rt); await settle();
  assert.equal(x.error?.setup, "local-model");
  retry(chat, x); drive(chat, rt); await settle();
  assert.equal(x.error?.setup, null);
  assert.equal(x.error?.text, "Another answer is running on this device. Try again when it finishes.");
  retry(chat, x); drive(chat, rt); await settle();
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
  assert.match(two.exchanges[0]!.error?.text ?? "", /running on this device/);
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
  drive(e, runtime({}, [])); await settle();
  assert.equal(e.exchanges[0]!.error?.setup, "sources");
});

test("chats are memory only and bounded; a dropped chat keeps its origin for Back and a replayed key opens nothing", () => {
  resetChats();
  let n = 0;
  const off = subscribe(() => n++);
  const first = startChat({ prompt: "What's due today", origin: origin(), idempotencyKey: "m0" })!.chat;
  first.exchanges[0]!.state = "done";
  for (let i = 1; i <= 12; i++) startChat({ prompt: "What's due today", origin: origin(), idempotencyKey: `m${i}` })!.chat.exchanges[0]!.state = "done";
  off();
  assert.equal(getChat(first.id), null, "the oldest idle chat is dropped past the limit");
  assert.equal(goneOrigin(first.id)?.label, "COMPSCI 220");
  assert.equal(startChat({ prompt: "What's due today", origin: origin(), idempotencyKey: "m0" }), null, "no duplicate chat for a replayed key");
  assert.ok(n >= 13);
});

// Router path: a fake bridge shaped like main's intent router (ae66b91). Synthetic results; no model.
function routerBridge(outcome: (text: string, courseId?: string) => IntentResult, preview: (text: string) => { action: string | null; hint: string | null; slots?: Record<string, string> }, log: unknown[] = []) {
  const meta = { path: "code" as const, latencyMs: 1, tokens: { in: 0, cached: 0, out: 0 } };
  return {
    query: (async (q: { view: string; text?: string; courseId?: string }) => {
      log.push(q);
      if (q.view === "intent.preview") { const p = preview(q.text!); return { view: "intent.preview", preview: { status: "preview", slots: p.slots ?? {}, hint: p.hint, action: p.action, ...meta } }; }
      return { view: "resources", items: [resources[7]] };
    }) as unknown as ChatBridge["query"],
    execute: (async (c: { type: string; value: { text: string; context?: { courseId?: string } } }) => {
      log.push(c);
      return { command: outcome(c.value.text, c.value.context?.courseId) };
    }) as unknown as ChatBridge["execute"],
  };
}
const ran = (action: string, args: Record<string, unknown>, result: unknown = {}): IntentResult => ({ status: "ran", action, args, result, path: "code", latencyMs: 1, tokens: { in: 0, cached: 0, out: 0 } });
const bioRef = { ref: "uw:120", accountScope: "uw", courseId: "120", code: "BIOLOGY 120", name: "Biology" };

test("router: the origin course goes in as the account-scoped ref; a grounded answer keeps its checked quotes", async () => {
  resetChats(); resetIntentSupport();
  const log: { type?: string; value?: { context?: { courseId?: string } } }[] = [];
  const bridge = routerBridge(() => ({ status: "answer", text: "Seams let a test swap a dependency.", citations: [{ sourceId: "p1", resourceId: "r6", title: "Reading: testing seams", url: "", quote: "A seam is a place", start: 0, end: 17 }], notFound: false, dropped: 1, path: "ai", latencyMs: 900, tokens: { in: 1, cached: 0, out: 1 } }), () => ({ action: "ask", hint: "Ask" }), log as unknown[]);
  const { chat } = startChat({ prompt: "What is a seam?", origin: origin(), idempotencyKey: "g1" })!;
  drive(chat, runtime(bridge)); await settle(); await settle();
  assert.equal(intentSupport(), "yes");
  const cmd = log.find((e) => e.type === "command")!;
  assert.equal(cmd.value?.context?.courseId, "uw:220");
  const r = chat.exchanges[0]!.result;
  assert.equal(r?.kind, "grounded");
  assert.deepEqual(r?.kind === "grounded" && [r.citations[0]!.quote, r.dropped], ["A seam is a place", 1]);
});

test("router: a due list for a course core resolved uses that exact course from saved data; an unincluded ref is refused", async () => {
  resetChats(); resetIntentSupport();
  const bridge = routerBridge(() => ran("agenda.due", { course: bioRef, date: { from: "2026-09-27", to: "2026-10-03", label: "this week" } }, { source: "due", range: { from: "2026-09-27", to: "2026-10-03", label: "this week" }, items: [] }), () => ({ action: "agenda.due", hint: "What's due this week · BIOLOGY 120" }));
  const { chat } = startChat({ prompt: "what's due in bio this week", origin: origin(), idempotencyKey: "rd" })!;
  drive(chat, runtime(bridge)); await settle(); await settle();
  const r = chat.exchanges[0]!.result;
  assert.deepEqual(r?.kind === "due" && [r.scopeLabel, r.rows.map((x) => x.id)], ["BIOLOGY 120 · Biology", ["bio1"]]);
  assert.equal(chat.course?.key, "uw:120");
  assert.equal(chat.origin.scope.kind === "course" && chat.origin.scope.course.key, "uw:220");
  resetChats(); resetIntentSupport();
  const other = routerBridge(() => ran("agenda.due", { course: { ...bioRef, ref: "other:220", accountScope: "other", courseId: "220", code: "COMPSCI 220" } }), () => ({ action: "agenda.due", hint: null }));
  const c2 = startChat({ prompt: "what's due in other 220", origin: origin(), idempotencyKey: "rd2" })!.chat;
  drive(c2, runtime(other)); await settle(); await settle();
  assert.equal(c2.exchanges[0]!.result?.kind === "course" && c2.exchanges[0]!.result.reason, "unknown");
});

test("router: a command that changes things is named, never run; a code miss never reaches the model fallback", async () => {
  resetChats(); resetIntentSupport();
  const log: { type?: string }[] = [];
  const bridge = routerBridge(() => { throw new Error("must not run"); }, (text) => text.startsWith("add") ? { action: "notes.append", hint: "Add to today's notes" } : { action: null, hint: null }, log as unknown[]);
  const { chat } = startChat({ prompt: "add seams to my notes", origin: origin(), idempotencyKey: "w" })!;
  drive(chat, runtime(bridge)); await settle(); await settle();
  assert.deepEqual(chat.exchanges[0]!.result, { kind: "action", action: "notes.append", hint: "Add to today's notes" });
  continueChat(chat.id, "seams vs mocks", "w2");
  drive(chat, runtime(bridge)); await settle(); await settle();
  assert.equal(log.filter((e) => e.type === "command").length, 0, "no run is sent for a write or a miss");
  assert.equal(chat.exchanges[1]!.result?.kind, "choose", "a miss uses the on-device path");
});

test("router: clarify maps to permitted courses with account labels; unavailable offers retry and the on-device path, not setup", async () => {
  resetChats(); resetIntentSupport();
  const both = [...included, chatCourse(cards[1]!)];
  const clarify = routerBridge(() => ({ status: "clarify", question: 'Which course did you mean by "cs 220"?', candidates: [{ action: "agenda.due", args: { course: "COMPSCI 220" }, label: "What's due · COMPSCI 220" }, { action: "notes.new", args: { course: "BIOLOGY 120" }, label: "New note" }], path: "code", latencyMs: 1, tokens: { in: 0, cached: 0, out: 0 } }), () => ({ action: "agenda.due", hint: null }));
  const home = chatScopeForPage({ page: "today", cards: [...cards, bioCard], sources });
  const { chat } = startChat({ prompt: "what's due in cs 220", origin: { ...origin(home), label: "Home" }, idempotencyKey: "c" })!;
  drive(chat, runtime(clarify, both)); await settle(); await settle();
  const x = chat.exchanges[0]!;
  assert.deepEqual(x.result?.kind === "clarify" && x.result.options.map((o) => o.label), ["COMPSCI 220 · Software Design (uw)", "COMPSCI 220 · Other 220 (other)"]);
  if (x.result?.kind !== "clarify") return;
  chooseCourse(chat, x, x.result.options[1]!.course);
  drive(chat, runtime(clarify, both)); await settle(); await settle();
  const after = chat.exchanges[0]!.result as { kind: string; rows?: { id: string }[] };
  assert.deepEqual(after.kind === "due" && after.rows!.map((r) => r.id), ["b1"]);

  resetChats(); resetIntentSupport();
  const reason = "Answering needs your AI: choose Claude or Codex in Settings and sign in. Search still works without it.";
  const none = routerBridge(() => ({ status: "unavailable", reason, path: "none", latencyMs: 1, tokens: { in: 0, cached: 0, out: 0 } }), () => ({ action: "ask", hint: null }));
  const c2 = startChat({ prompt: "What is a seam?", origin: origin(), idempotencyKey: "u" })!.chat;
  drive(c2, runtime(none)); await settle(); await settle();
  const y = c2.exchanges[0]!;
  assert.deepEqual(y.result, { kind: "unavailable", reason });
  answerLocally(c2, y);
  drive(c2, runtime(none)); await settle(); await settle();
  assert.equal(y.result?.kind, "choose", "the explicit on-device path searches saved items");
});

test("router: an old schema is detected once and a raw IPC blob becomes one sentence with inspectable detail", async () => {
  resetChats(); resetIntentSupport();
  const old = { query: (async (q: { view: string }) => { if (q.view === "intent.preview") throw new Error("Invalid discriminator value. Expected 'summary' | 'resources'"); return { view: "resources", items: [] }; }) as unknown as ChatBridge["query"], execute: (async () => ({})) as unknown as ChatBridge["execute"] };
  const { chat } = startChat({ prompt: "What is a seam?", origin: origin(), idempotencyKey: "o" })!;
  drive(chat, runtime(old)); await settle(); await settle();
  assert.equal(intentSupport(), "no");
  assert.equal(chat.exchanges[0]!.result?.kind, "choose");

  resetChats(); resetIntentSupport();
  const blob = "Error invoking remote method 'magic:execute': ZodError: [\n  { \"code\": \"invalid_union\" } ]";
  const broken = routerBridge(() => { throw new Error(blob); }, () => ({ action: "ask", hint: null }));
  const c2 = startChat({ prompt: "What is a seam?", origin: origin(), idempotencyKey: "b" })!.chat;
  drive(c2, runtime(broken)); await settle(); await settle();
  assert.deepEqual(c2.exchanges[0]!.error, { text: "Magic could not finish this request. Try again.", detail: blob, setup: null });
});


test("long input stays in the draft instead of becoming an accepted truncated request", () => {
  resetChats();
  const tooLong = "x".repeat(2001);
  assert.match(chatPromptError(tooLong)!, /2,000/);
  assert.equal(startChat({ prompt: tooLong, origin: origin(), idempotencyKey: "long" }), null);
  const accepted = startChat({ prompt: "x".repeat(1990) + " BIOLOGY", origin: origin(), idempotencyKey: "fits" })!;
  assert.equal(accepted.chat.exchanges[0]!.prompt.endsWith(" BIOLOGY"), true);
  assert.equal(continueChat(accepted.chat.id, tooLong, "long-follow"), false);
  assert.equal(accepted.chat.exchanges.length, 1);
});

test("router never executes a truncated message that omits a trailing correction", async () => {
  resetIntentSupport();
  let calls = 0;
  const bridge = { query: async () => { calls++; }, execute: async () => { calls++; } } as unknown as ChatBridge;
  const prompt = "what is due ".repeat(50) + "actually in BIOLOGY 120";
  assert.equal(await previewIntent(bridge, prompt, "uw:220"), null);
  await assert.rejects(() => runIntent(bridge, prompt, "uw:220"), /too long/);
  assert.equal(calls, 0);
});


test("a removed origin cannot send a command or read an item; an explicit included course still wins", async () => {
  resetChats(); resetIntentSupport();
  let calls = 0;
  const bridge = { query: async () => { calls++; throw new Error("must not read"); }, execute: async () => { calls++; throw new Error("must not run"); } } as unknown as ChatBridge;
  const chat = startChat({ prompt: "what's due this week", origin: origin(), idempotencyKey: "revoked" })!.chat;
  drive(chat, runtime(bridge, [chatCourse(bioCard)])); await settle();
  assert.equal(chat.exchanges[0]!.state, "failed");
  assert.match(chat.exchanges[0]!.error!.text, /no longer included/);
  assert.equal(calls, 0);
  continueChat(chat.id, "what's due in BIOLOGY 120 this week", "permitted-new-target");
  drive(chat, runtime({}, [chatCourse(bioCard)])); await settle();
  const result = chat.exchanges[1]!.result;
  assert.deepEqual(result?.kind === "due" && result.rows.map(r => r.id), ["bio1"]);
});


test("router infrastructure failures end the exchange without a second fallback query", async () => {
  for (const message of [
    "Error invoking remote method magic:query: Local workspace request timed out.",
    "intent.preview request cancelled",
    "intent.preview authorization expired; sign in again",
  ]) {
    resetChats(); resetIntentSupport();
    const queries: string[] = [];
    let executions = 0;
    const bridge = {
      query: async (q: {view: string}) => { queries.push(q.view); throw new Error(message); },
      execute: async () => { executions++; return {}; },
    } as unknown as ChatBridge;
    const {chat} = startChat({prompt: "What is a seam?", origin: origin(), idempotencyKey: message})!;
    drive(chat, runtime(bridge)); await settle(); await settle();
    assert.deepEqual(queries, ["intent.preview"]);
    assert.equal(executions, 0);
    assert.equal(chat.exchanges[0]!.state, "failed");
    assert.equal(chat.exchanges[0]!.error?.detail ?? chat.exchanges[0]!.error?.text, message);
    assert.equal(intentSupport(), "unknown");
  }
});
