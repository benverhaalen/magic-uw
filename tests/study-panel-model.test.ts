// owner: study frontend. The study panel's pure decisions: honest actions, topic focus and outcomes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  focusTopics,
  guideForAccount,
  guideStatusText,
  packNotice,
  resultsSummary,
  studyActions,
  topicReason,
} from "../apps/desktop/src/renderer/study/model";
import type { GuideQueryResult, PackOutcome, PracticePathData, TopicStateView } from "../apps/desktop/src/renderer/study/types";

const topic = (conceptId: string, state: TopicStateView["state"], practiceItems = 1): TopicStateView => ({
  conceptId,
  label: conceptId,
  moduleId: null,
  moduleLabel: null,
  state,
  stateLabel: state,
  reasons: [],
  counts: { answers: 0, correct: 0, cardReviews: 0, selfRatings: 0 },
  practiceItems,
});
const path = (over: Partial<PracticePathData> = {}): PracticePathData => ({
  courseId: "C1",
  availability: "current",
  reason: "Ready",
  ready: true,
  questions: 6,
  cards: { total: 4, dueToday: 4 },
  modules: [],
  unsectionedTopicIds: [],
  topics: [],
  mastered: { count: 0, of: 0 },
  openSessions: [],
  ...over,
});
const guide = (over: Partial<GuideQueryResult>): GuideQueryResult => ({
  view: "guide",
  op: "guide.view",
  status: "ready",
  kind: "guide",
  courseRef: "a:C1",
  artifactId: "g1",
  stale: false,
  changedSources: [],
  message: null,
  modelCalls: 0,
  guide: null,
  ...over,
});
const base = { courseLabel: "CS 310", restricted: false, guideScopeLabel: "this module's saved materials" };
const outcome = (over: Partial<PackOutcome>): PackOutcome => ({
  status: "done",
  message: "6 questions ready.",
  pack: "quiz",
  cached: false,
  counts: { generated: 8, accepted: 6, dropped: 2 },
  receiptIds: [],
  ...over,
});

test("ready practice offers practice and due cards, never a make action", () => {
  const ids = studyActions({ ...base, path: { state: "ok", data: path() }, guide: null }).map((a) => a.id);
  assert.deepEqual(ids, ["practice", "cards"]);
});

test("an empty pool offers making practice; unknown path state offers nothing to make", () => {
  const empty = path({ ready: false, questions: 0, cards: { total: 0, dueToday: 0 } });
  const actions = studyActions({ ...base, path: { state: "unavailable", message: "No practice items yet.", data: empty }, guide: null });
  assert.deepEqual(actions.map((a) => a.id), ["make-practice"]);
  assert.equal(studyActions({ ...base, path: { state: "failed", message: "x" }, guide: null }).length, 0);
  assert.equal(studyActions({ ...base, path: null, guide: null }).length, 0);
});

test("a restricted course never offers generation", () => {
  const empty = path({ ready: false, questions: 0, cards: { total: 0, dueToday: 0 } });
  const actions = studyActions({
    ...base,
    restricted: true,
    path: { state: "unavailable", message: "none", data: empty },
    guide: { state: "ok", data: guide({ status: "missing" }) },
  });
  assert.deepEqual(actions, []);
});

test("stale course material pauses practice with the backend's reason", () => {
  const [practice] = studyActions({ ...base, path: { state: "ok", data: path({ availability: "stale", reason: "The course changed." }) }, guide: null });
  assert.equal(practice?.disabled, "The course changed.");
});

test("no cards due is shown as information, not as a done state", () => {
  const cards = studyActions({ ...base, path: { state: "ok", data: path({ cards: { total: 3, dueToday: 0 } }) }, guide: null }).find((a) => a.id === "cards");
  assert.equal(cards?.title, "No cards due today");
  assert.ok(cards?.disabled);
});

test("guide tile reflects ready, stale and missing states; unconnected shows nothing", () => {
  const read = (g: GuideQueryResult) => studyActions({ ...base, path: null, guide: { state: "ok", data: g } });
  assert.equal(read(guide({ status: "ready" }))[0]?.id, "guide");
  assert.match(read(guide({ status: "stale", stale: true, changedSources: [{ resourceId: "r", title: "L1", change: "changed" }] }))[0]!.detail, /1 source changed/);
  assert.equal(read(guide({ status: "missing" }))[0]?.id, "make-guide");
  assert.equal(studyActions({ ...base, path: null, guide: { state: "unconnected" } }).length, 0);
  assert.equal(guideStatusText({ state: "unconnected" }), null);
  assert.equal(guideStatusText({ state: "ok", data: guide({ status: "blocked", message: "Restricted." }) }), "Restricted.");
});

test("topics: weakest first, practice-reachable before unreachable, capped", () => {
  const ordered = focusTopics([topic("a", "solid"), topic("b", "not_seen", 0), topic("c", "iffy"), topic("d", "not_seen", 2), topic("e", "getting_there")], 4);
  assert.deepEqual(ordered.map((t) => t.conceptId), ["c", "e", "d", "b"]);
});

test("topic reasons never imply readiness without evidence", () => {
  assert.equal(topicReason(topic("x", "not_seen", 0)), "No checked practice covers this topic yet.");
  assert.equal(topicReason(topic("x", "not_seen", 3)), "No practice answers yet.");
  assert.equal(topicReason({ ...topic("x", "iffy"), reasons: [{ text: "Missed 2 of 3.", clearsWhen: "" }] }), "Missed 2 of 3.");
});

test("pack outcomes: blocked says nothing was sent; zero accepted is not success; unknown pack is unconnected", () => {
  assert.match(packNotice(outcome({ status: "blocked", message: "Preview required." })).text, /^Nothing was sent\. Preview required\./);
  assert.equal(packNotice(outcome({ status: "blocked", message: "x" })).refresh, false);
  assert.match(packNotice(outcome({ counts: { generated: 4, accepted: 0, dropped: 4 } })).text, /No practice passed the source checks/);
  assert.equal(packNotice(outcome({})).text, "6 questions ready.");
  assert.match(packNotice(outcome({ status: "unknown_pack", pack: "guide", message: "There's no guide pack." })).text, /not connected in this build/);
  assert.equal(packNotice(outcome({ status: "no_client", message: "Connect your AI first." })).text, "Connect your AI first.");
});

test("results summary keeps unscored answers separate and makes no grade claim", () => {
  const text = resultsSummary({ sessionId: "s", mode: "learn", complete: true, answered: 5, correct: 3, unscored: 1, skipped: 1, topics: [], studyNext: [] });
  assert.equal(text, "You answered 5, 3 matched the checked answer, 1 could not be checked and was kept unscored, 1 skipped.");
  assert.doesNotMatch(text, /%|\bgrade|\bscore/i);
});

test("a guide from another account for the same course id is never shown and blocks generation", () => {
  const mine = guideForAccount({ state: "ok", data: guide({ courseRef: "a:C1" }) }, "a", "C1");
  assert.equal(mine.state, "ok");
  const other = guideForAccount({ state: "ok", data: guide({ courseRef: "b:C1" }) }, "a", "C1");
  assert.equal(other.state, "unavailable");
  assert.equal(guideForAccount({ state: "ok", data: guide({ courseRef: "a:C1" }) }, undefined, "C1").state, "unavailable");
  // Empty course answers carry no guide, so there is nothing to mix.
  assert.equal(guideForAccount({ state: "ok", data: guide({ status: "empty", courseRef: null }) }, "a", "C1").state, "ok");
  const empty = path({ ready: false, questions: 0, cards: { total: 0, dueToday: 0 } });
  const actions = studyActions({ ...base, otherAccount: true, path: { state: "unavailable", message: "none", data: empty }, guide: other });
  assert.deepEqual(actions, []);
  assert.match(guideStatusText(other) ?? "", /another connected account/);
});

test("a material page anchors course practice only on a confirmed assignment of the same course and account", async () => {
  const { findCourseAnchor } = await import("../apps/desktop/src/renderer/study/api");
  const asked: unknown[] = [];
  let items: { id: string; kind: string; courseId: string }[] = [];
  (globalThis as { window?: unknown }).window = {
    magic: {
      query: async (request: unknown) => {
        asked.push(request);
        return { view: "resources", items, total: items.length };
      },
    },
  };
  assert.equal(await findCourseAnchor("C1", undefined), null, "unknown account never borrows an anchor");
  assert.equal(asked.length, 0);
  items = [{ id: "A-other", kind: "assignment", courseId: "C2" }];
  assert.equal(await findCourseAnchor("C1", "acct"), null, "another course's assignment is rejected");
  items = [{ id: "M1", kind: "page", courseId: "C1" }];
  assert.equal(await findCourseAnchor("C1", "acct"), null, "a material is never used as an anchor");
  items = [{ id: "A1", kind: "assignment", courseId: "C1" }];
  assert.equal(await findCourseAnchor("C1", "acct"), "A1");
  assert.deepEqual(asked.at(-1), { view: "resources", courseId: "C1", accountScope: "acct", kinds: ["assignment"], limit: 1 });
  delete (globalThis as { window?: unknown }).window;
});

test("an unanchored material page offers only making practice from this material", () => {
  const actions = studyActions({ ...base, path: null, guide: null, anchored: false });
  assert.deepEqual(actions.map((a) => a.id), ["make-practice"]);
  assert.match(actions[0]!.detail, /this material/);
});
