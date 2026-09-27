// owner: study-prep. The item space end to end on the synthetic signals course: item types by code
// (≥ 90% on synthetic cases), each type's catered space from the query alone, the student's type
// correction, per-type generation with the integrity checks (practice problems never copy the
// assigned work, a practice exam never copies a past exam and its points add up, the outline never
// writes the text), links and the FSRS review scoped to exactly an item's cards, and the lists.
import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { defaultPrivacy, ITEM_SPACE, studyPrepPackName, type ItemType, type Resource, type StudyPrepKind, type StudyPrepResult } from "@magic/contracts";
import { createClaudeBackend, type CliCommand } from "../packages/runner/src/index";
import { createPackRuntime } from "../packages/packs/core/src/index";
import { createPackHandler } from "../packages/core/src/pack-handler";
import { studyPrepQuery } from "../packages/core/src/study-prep/query";
import { codeType, decideType } from "../packages/core/src/study-prep/item-type";
import { correctItemType } from "../packages/core/src/study-prep/correct";
import type { StudyPrepRunResult } from "../packages/core/src/study-prep/generate";
import { INTEGRITY_RULE, nearCopyOf } from "../packages/packs/study-prep/src/index";
import { createLearningRouter, eligibleStudySource, type StudyContext } from "../packages/learning/src/router";
import { ItemSpaceView } from "../apps/desktop/src/renderer/study-prep/ItemSpace";
import { shouldAskPrepFirst } from "../apps/desktop/src/renderer/study-prep/entries";
import { addCatalogue, CATALOGUE, materialsBatch, NOW, passageId, signalsFixture, TEXTS, READING } from "./study-prep-fixture";

(globalThis as { React?: typeof React }).React = React;
const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
type Ok = Extract<StudyPrepResult, { status: "ok" }>;
type List = Extract<StudyPrepResult, { status: "list" }>;

// ---------- Item types by code ----------
const res = (over: Partial<Resource>): Resource =>
  ({ id: "r", externalId: "r", kind: "assignment", courseId: "C", courseName: "C", title: "", url: "https://canvas.example.test/x", text: "", deadlines: [], points: 10, submitted: null, policy: { mode: "unknown", evidence: "" }, sourceId: "s", contentHash: "h", version: 1, observedAt: "", capturedAt: "", deleted: false, completed: false, ...over }) as Resource;
const CASES: [string, Partial<Resource>, ItemType][] = [
  ["Midterm 1", { submissionTypes: ["on_paper"] }, "exam"],
  ["Final Exam", { submissionTypes: ["on_paper"] }, "exam"],
  ["Exam 2 (online)", { submissionTypes: ["online_quiz"] }, "exam"],
  ["Test 3", {}, "exam"],
  ["Quiz 4", { submissionTypes: ["online_quiz"] }, "quiz"],
  ["Weekly check 5", { submissionTypes: ["online_quiz"] }, "quiz"],
  ["Reading quiz: Chapter 3", { submissionTypes: ["online_quiz"] }, "quiz"],
  ["Problem Set 2", { submissionTypes: ["online_upload"] }, "problem_set"],
  ["Homework 7", { submissionTypes: ["online_upload"] }, "problem_set"],
  ["HW 3: Convolution", { submissionTypes: ["online_upload"] }, "problem_set"],
  ["Exercises 4.1-4.9", { submissionTypes: ["online_upload"] }, "problem_set"],
  ["Worksheet: Z-transforms", { submissionTypes: ["online_upload"] }, "problem_set"],
  ["Assignment 5", { submissionTypes: ["online_upload"] }, "problem_set"],
  ["Response Paper 2", { submissionTypes: ["online_upload"] }, "essay"],
  ["Final Paper Draft", { submissionTypes: ["online_upload"] }, "essay"],
  ["Reflection 3", { submissionTypes: ["online_text_entry"] }, "essay"],
  ["Annotated Bibliography", { submissionTypes: ["online_upload"] }, "essay"],
  ["Lab 2: Filters", { submissionTypes: ["online_upload"] }, "lab"],
  ["Prelab 4", { submissionTypes: ["online_upload"] }, "lab"],
  ["Lab Report 1", { submissionTypes: ["online_upload"] }, "lab"],
  ["Final Project", { submissionTypes: ["online_upload"] }, "project"],
  ["Project Milestone 2", { submissionTypes: ["online_upload"] }, "project"],
  ["Capstone Proposal", { submissionTypes: ["online_upload"] }, "project"],
  ["Week 3 Discussion", { submissionTypes: ["discussion_topic"] }, "discussion_post"],
  ["Share your example", { submissionTypes: ["discussion_topic"] }, "discussion_post"],
  ["Forum: introductions", { submissionTypes: ["online_text_entry"] }, "discussion_post"],
  ["Group Presentation", { submissionTypes: ["on_paper"] }, "presentation"],
  ["Poster session", { submissionTypes: ["on_paper"] }, "presentation"],
  ["Attendance", { submissionTypes: ["none"], points: 0 }, "participation"],
  ["iClicker week 2", { submissionTypes: ["on_paper"] }, "participation"],
  ["Check-in", { submissionTypes: ["not_graded"] }, "participation"],
  ["In-class activity 4", { submissionTypes: ["none"], points: 0 }, "participation"],
  ["Chapter 5 notes", { kind: "material" }, "reading"],
  ["Reading: Oppenheim 2.1", { kind: "material" }, "reading"],
  ["Week 4 article", { kind: "material" }, "reading"],
  ["Lecture 12: Sampling", { kind: "material" }, "lecture"],
  ["Slides: DFT", { kind: "material" }, "lecture"],
  ["dft-overview.pptx", { kind: "material", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }, "lecture"],
  ["Syllabus", { kind: "material" }, "reading"],
  ["Deliverable 1", { submissionTypes: ["online_upload"] }, "project"],
];

test("item types by code: ≥ 90% of synthetic cases typed correctly, each with its reason", () => {
  let right = 0;
  const wrong: string[] = [];
  for (const [title, over, expect] of CASES) {
    const d = codeType({ resource: res({ title, ...over }) });
    assert.ok(d.reason.length > 0);
    if (d.type === expect) right++;
    else wrong.push(`${title}: ${d.type ?? "none"} (expected ${expect})`);
  }
  const rate = right / CASES.length;
  console.log(`ITEM-TYPES ${JSON.stringify({ cases: CASES.length, codeTyped: right, rate: +rate.toFixed(3), wrong })}`);
  assert.ok(rate >= 0.9, `${(rate * 100).toFixed(0)}%: ${wrong.join("; ")}`);
  // The course map's kind wins, then the module header decides a title that doesn't.
  assert.equal(codeType({ assessment: { kind: "paper", title: "Assignment 2" }, resource: null }).type, "essay");
  assert.equal(codeType({ resource: res({ title: "Week 5", submissionTypes: ["online_upload"] }), moduleTitle: "Labs" }).type, "lab");
  // A student's correction wins over code; the AI only fills what code can't decide.
  const code = codeType({ resource: res({ title: "Quiz 1", submissionTypes: ["online_quiz"] }) });
  assert.equal(decideType(code, { type: "exam", reason: "", basis: "student", at: "" }, "quiz").type, "exam");
  assert.equal(decideType(code, { type: "essay", reason: "", basis: "ai", at: "" }, "quiz").type, "quiz");
  assert.equal(decideType({ type: null, reason: "x", basis: "code" }, { type: "lab", reason: "titles", basis: "ai", at: "" }, "problem_set").type, "lab");
  assert.equal(decideType({ type: null, reason: "x", basis: "code" }, undefined, "problem_set").basis, "default");
});

// ---------- The catered spaces ----------
function catalogueFixture() {
  const f = signalsFixture(createStore(":memory:"));
  const ids = addCatalogue(f);
  const query = (itemId: string, extra: Record<string, unknown> = {}) => studyPrepQuery(f.store, { view: "study.prep", courseId: "SIG203", itemId, ...extra }, NOW.toISOString());
  return { ...f, cat: ids, query };
}
const noop = () => {};
const render = (data: Ok) =>
  renderToStaticMarkup(
    React.createElement(ItemSpaceView, {
      data, view: "need", setView: noop, ticked: null, setTicked: noop, chips: new Set<string>(), setChips: noop,
      selection: { resourceIds: undefined, topicIds: [] }, scope: { courseId: data.courseId, itemId: data.item.id }, pending: new Set<StudyPrepKind>(), notice: null,
      generate: noop, activate: noop, load: noop,
    }),
  );

test("every type gets its own space: the type row's sections and actions, from the query alone", () => {
  const f = catalogueFixture();
  try {
    const items: [string, ItemType, (html: string, d: Ok) => void][] = [
      ["a-mid2", "exam", (h) => { assert.match(h, /What it covers/); assert.match(h, /Midterm 2 covers Modules 3 and 4\./); assert.match(h, /Past and practice exams/); }],
      [f.cat.quiz3, "quiz", (h, d) => { assert.match(h, /Topics|Cards/); assert.ok(ITEM_SPACE.quiz.prepFirst); assert.equal(d.item.kind, "quiz"); }],
      [f.cat.ps4, "problem_set", (h, d) => { assert.match(h, /Instructions/); assert.match(h, /Using the DTFT definition/); assert.match(h, /Worked examples/); assert.match(h, /1\/8000 s/); assert.deepEqual(d.sources.map((s) => s.title).sort(), ["Lecture 7: The DTFT", "Lecture 9: Sampling"]); assert.equal(d.sources[0]!.reason, "Linked in the instructions"); }],
      [f.cat.essay, "essay", (h, d) => { assert.match(h, /2 criteria, 10 points/); assert.equal(d.sections.citationStyle?.style, "IEEE"); assert.match(h, /Reading: Chapter 2 Signals/); }],
      [f.cat.lab, "lab", (h) => { assert.match(h, /Safety and equipment/); assert.match(h, /Wear safety goggles/); }],
      [f.cat.proposal, "project", (h, d) => { assert.deepEqual(d.sections.milestones?.map((m) => m.title), ["Final Project Proposal", "Final Project Milestone 1"]); assert.match(h, /Milestones/); }],
      [f.cat.discussion, "discussion_post", (h) => { assert.match(h, /Readings/); assert.match(h, /Reading: Chapter 2 Signals/); }],
      [f.cat.talk, "presentation", (h) => { assert.match(h, /Rubric/); }],
      [f.cat.reading, "reading", (h, d) => { assert.match(h, /The material/); assert.match(h, /A discrete-time signal is a sequence x\[n\]/); assert.equal(d.item.kind, "material"); }],
      [f.ids.sampling!, "lecture", (h) => { assert.match(h, /Sampling below the Nyquist rate/); }],
      [f.cat.attendance, "participation", (h, d) => { assert.equal(d.config.actions.length, 0); assert.match(h, /When and where/); assert.doesNotMatch(h, /role="toolbar"/); }],
    ];
    const table: Record<string, string[]> = {};
    for (const [id, type, check] of items) {
      const r = f.query(id);
      assert.equal(r.status, "ok", `${type}: ${JSON.stringify(r).slice(0, 200)}`);
      const d = r as Ok;
      assert.equal(d.item.type, type, `${d.item.title}: ${d.item.typeReason}`);
      assert.equal(d.item.typeBasis, "code");
      assert.deepEqual(d.config, ITEM_SPACE[type]);
      assert.equal(d.modelCalls, 0);
      const html = render(d);
      for (const a of d.config.actions) assert.ok(html.includes(`>${a.label}<`), `${type}: the ${a.label} action`);
      check(html, d);
      table[type] = d.config.actions.map((a) => a.label);
    }
    console.log(`ITEM-SPACE-TABLE ${JSON.stringify(table)}`);
  } finally {
    f.store.close();
  }
});

test("the student's type correction wins and changes the space", () => {
  const f = catalogueFixture();
  try {
    assert.equal((f.query(f.cat.talk) as Ok).item.type, "presentation");
    const msg = correctItemType(f.store, { subject: "item_type", courseId: "SIG203", itemId: f.cat.talk, type: "essay" }, NOW.toISOString());
    assert.match(msg, /Saved/);
    const d = f.query(f.cat.talk) as Ok;
    assert.equal(d.item.type, "essay");
    assert.equal(d.item.typeBasis, "student");
    assert.deepEqual(d.config.actions.map((a) => a.label), ["Reading cards", "Outline coach", "Rubric checklist"]);
  } finally {
    f.store.close();
  }
});

// ---------- Generation per type, with the integrity checks ----------
async function setup(responses: (p: Record<string, string>) => unknown[]) {
  const f = catalogueFixture();
  const store = f.store;
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  const p = { dtft: passageId(store, f.ids.dtft!), sampling: passageId(store, f.ids.sampling!), solutions: passageId(store, f.ids.solutions!), reading: passageId(store, f.cat.reading) };
  const dir = await mkdtemp(join(tmpdir(), "item-space-"));
  await mkdir(join(dir, "work"));
  const log = join(dir, "log.jsonl");
  const env = { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify(responses(p)) };
  const runner = createPackRuntime(createClaudeBackend({ command: fake, workDir: join(dir, "work"), env }), { dailyBackgroundTokens: 1_000_000 }).runner;
  const handler = createPackHandler({ store, runner: () => runner, now: () => NOW });
  const core = createCore(store, { fixture: materialsBatch(), seams: { pack: handler.pack } });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const calls = async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[]; stdin?: string }).filter((l) => l.argv) : []);
  const generate = async (itemId: string, kinds: StudyPrepKind[]) =>
    (await core.execute({ type: "pack", pack: studyPrepPackName(kinds), scope: { courseId: "SIG203", assessmentId: itemId } })).pack as StudyPrepRunResult;
  return { ...f, p, calls, generate };
}
const empty = { guide: null, quiz: null, cards: null, exam: null, problems: null, outline: null };
const Q = {
  nyquist: "A signal band-limited to B Hz can be recovered from its samples when the sampling rate fs is greater than 2B.",
  period: "A 3 kHz tone sampled at 8 kHz has a sampling period of 1/8000 s, which is 0.000125 s.",
  dtft: "The DTFT of a sequence x[n] is X(e^(jw)) = sum over all n of x[n] e^(-jwn).",
  periodic: "The DTFT is periodic in w with period 2*pi.",
  aliasing: "Sampling below the Nyquist rate causes aliasing: high frequencies appear as low ones.",
  discrete: "A discrete-time signal is a sequence x[n] defined for integer n.",
};
const answer = (over: Record<string, unknown>) => ({ kind: "none", value: null, unit: null, formula: null, expr: null, derivation: null, variables: [], ...over });
const problem = (over: Record<string, unknown>) => ({ number: "1", section: null, points: null, format: "problem", topic: "DTFT", prompt: "", options: null, answer: answer({}), solution: "Worked.", sources: [], ...over });

test("a problem set: practice problems are verified by code, never the assigned ones, and the prompt carries the integrity rule", async () => {
  const g = await setup((p) => [
    {
      output: {
        ...empty,
        problems: {
          problems: [
            problem({ number: "1", prompt: "Find the DTFT of the shifted impulse $x[n] = \\delta[n-5]$.", answer: answer({ kind: "expression", expr: "e^(-5*j*w)", derivation: "(e^(-j*w))^5", variables: ["j", "w"] }), solution: "$X(e^{j\\omega}) = e^{-j5\\omega}$.", sources: [{ sourceId: p.dtft, quote: Q.dtft }] }),
            problem({ number: "2", prompt: "Using the DTFT definition, find X(e^(jw)) for x[n] = delta[n] + delta[n - 1].", answer: answer({ kind: "none" }), sources: [{ sourceId: p.dtft, quote: Q.dtft }] }),
            problem({ number: "3", topic: "Sampling theorem", prompt: "A 3 kHz tone is sampled at 12 kHz. What is the sampling period?", answer: answer({ kind: "numeric", value: 0.0000833333, unit: "s", formula: "1/12000" }), solution: "$T_s = 1/f_s = 1/12000$ s.", sources: [{ sourceId: p.sampling, quote: Q.period }] }),
            problem({ number: "4", topic: "Sampling theorem", prompt: "A tone is sampled at 12 kHz; give the period.", answer: answer({ kind: "numeric", value: 0.001, unit: "s", formula: "1/12000" }), sources: [{ sourceId: p.sampling, quote: Q.period }] }),
            problem({ number: "5", format: "multiple_choice", prompt: "Which rate avoids aliasing for $B = 4$ kHz?", options: [{ text: "9 kHz", correct: true }, { text: "10 kHz", correct: true }, { text: "6 kHz", correct: false }], answer: answer({ kind: "choice" }), sources: [{ sourceId: p.sampling, quote: Q.nyquist }] }),
          ],
        },
      },
    },
  ]);
  try {
    const r = await g.generate(g.cat.ps4, ["problems"]);
    assert.equal(r.status, "done", r.message);
    assert.deepEqual(r.counts.problems, { generated: 5, accepted: 2, dropped: 3 }, JSON.stringify(r.drops));
    assert.ok(r.drops.some((d) => /nearly copies Problem Set 4 \(the assigned work\)/.test(d.reason)), "the assigned problem is rejected");
    assert.ok(r.drops.some((d) => /the formula gives/.test(d.reason)), "a wrong numeric answer is rejected");
    assert.ok(r.drops.some((d) => /2 options are marked correct/.test(d.reason)), "two keys are rejected");
    const [call] = await g.calls();
    assert.ok(call!.stdin!.includes(INTEGRITY_RULE), "authored work carries the integrity rule");
    assert.ok(!call!.stdin!.includes("delta[n] + delta[n - 1]"), "the open assignment's text is never sent");
    const d = g.query(g.cat.ps4) as Ok;
    const made = d.materials.problems;
    assert.equal(made.status, "ready");
    assert.deepEqual(made.problems!.map((x) => x.verified), ["symbolic", "recomputed"]);
    assert.deepEqual(made.problems![0]!.answer, { kind: "expression", expr: "e^(-5*j*w)" });
    assert.ok(made.problems!.every((x) => x.sources.length && x.sources[0]!.start !== null));
  } finally {
    g.store.close();
  }
});

test("an exam: the practice exam mirrors the form, its points add up (retried when not), and no problem copies a past exam", async () => {
  const good = (p: Record<string, string>) => ({
    output: {
      ...empty,
      exam: {
        title: "Midterm 2 practice exam",
        minutes: 90,
        problems: [
          problem({ number: "1", points: 10, format: "numeric", topic: "Sampling theorem", prompt: "A microphone signal contains frequencies up to 6 kHz. At what minimum rate must it be sampled to avoid aliasing?", answer: answer({ kind: "numeric", value: 12, unit: "kHz", formula: "2 * 6" }), solution: "$f_s > 2B = 12$ kHz.", sources: [{ sourceId: p.sampling, quote: Q.nyquist }] }),
          problem({ number: "2", points: 10, topic: "DTFT", prompt: "Find the DTFT of the shifted impulse $\\delta[n-5]$.", answer: answer({ kind: "expression", expr: "e^(-5*j*w)", derivation: "(e^(-j*w))^5", variables: ["j", "w"] }), solution: "$e^{-j5\\omega}$", sources: [{ sourceId: p.dtft, quote: Q.dtft }] }),
          problem({ number: "3", points: 0, topic: "DTFT", prompt: "(10 points) Compute the DTFT of x[n] = delta[n - 2].", answer: answer({ kind: "none" }), sources: [{ sourceId: p.dtft, quote: Q.dtft }] }),
        ],
      },
    },
  });
  const g = await setup((p) => [
    { output: { ...empty, exam: { ...good(p).output.exam, problems: good(p).output.exam.problems.map((x) => ({ ...x, points: 15 })) } } },
    good(p),
  ]);
  try {
    const r = await g.generate("a-mid2", ["exam"]);
    assert.equal(r.status, "done", r.message);
    assert.equal((await g.calls()).length, 2, "points that don't add up to 20 are retried");
    const [first] = await g.calls();
    assert.match(first!.stdin!, /Points must add up to exactly 20/);
    assert.match(first!.stdin!, /90 minutes/);
    assert.deepEqual(r.counts.exam, { generated: 3, accepted: 2, dropped: 1 });
    assert.ok(r.drops.some((d) => /nearly copies Midterm 2 Practice Exam/.test(d.reason)));
    const exam = (g.query("a-mid2") as Ok).materials.exam.exam!;
    assert.equal(exam.totalPoints, 20);
    assert.equal(exam.minutes, 90);
    assert.match(exam.basis, /Modelled on Midterm 2 Practice Exam, 2 problems, 20 points, covers 2 of 4 topics/);
    assert.deepEqual(exam.problems.map((x) => x.verified), ["recomputed", "symbolic"]);
    // The near-copy rule: new wording is fine, the same wording with a changed number is not.
    const past = [{ label: "Past", text: TEXTS.practice }];
    assert.equal(nearCopyOf("What is the Nyquist rate of a signal band-limited to 6 kHz?", past), "Past");
    assert.equal(nearCopyOf("A microphone picks up frequencies up to 6 kHz. How fast must we sample it?", past), null);
  } finally {
    g.store.close();
  }
});

test("an essay: the outline coach asks questions and never writes the text; reading cards are linked to the essay", async () => {
  const g = await setup((p) => [
    {
      output: {
        ...empty,
        cards: { cards: [{ kind: "term", front: "Discrete-time signal", back: "A sequence $x[n]$ defined for integer $n$", topics: ["Sampling theorem"], section: "Module 4: Sampling", sourceId: p.reading, quote: Q.discrete }] },
        outline: {
          title: "Outline for your reflection",
          focus: ["Where does sampling shape something you use every day?", "Sampling is everywhere in modern life."],
          sections: [
            { heading: "An everyday example", questions: ["Which device do you describe, and what does it sample?", "What rate does it use?"], evidence: [{ hint: "How a discrete signal is defined", sourceId: p.reading, quote: Q.discrete }] },
            { heading: "In conclusion, sampling is the hidden backbone of every digital device we rely on each day", questions: ["What would change?"], evidence: [] },
          ],
        },
      },
    },
  ]);
  try {
    const r = await g.generate(g.cat.essay, ["cards", "outline"]);
    assert.equal(r.status, "done", r.message);
    assert.equal((await g.calls()).length, 1, "two actions, one request");
    const d = g.query(g.cat.essay) as Ok;
    const o = d.materials.outline.outline!;
    assert.deepEqual(o.focus, ["Where does sampling shape something you use every day?"], "a statement is dropped from the focus");
    assert.deepEqual(o.sections.map((s) => s.heading), ["An everyday example"], "a heading that reads like the text is dropped");
    assert.equal(o.sections[0]!.evidence[0]!.source.quote, Q.discrete);
    assert.equal(d.materials.cards.count, 1);
    assert.equal(d.review.cards, 1, "the card made for the essay is linked to it");
    assert.deepEqual(d.review.cardItemIds, d.materials.cards.cards!.map((c) => c.itemId));
  } finally {
    g.store.close();
  }
});

test("links: cards made for an item are reviewed in an FSRS session scoped to exactly them; the lists show what is prepared", async () => {
  const g = await setup((p) => [
    {
      output: {
        ...empty,
        cards: {
          cards: [
            { kind: "term", front: "Nyquist rate", back: "$2B$", topics: ["Sampling theorem"], section: "Module 4: Sampling", sourceId: p.sampling, quote: Q.nyquist },
            { kind: "term", front: "Aliasing", back: "High frequencies appearing as low ones", topics: ["Aliasing"], section: "Module 4: Sampling", sourceId: p.sampling, quote: Q.aliasing },
          ],
        },
      },
    },
  ]);
  try {
    const r = await g.generate(g.cat.lab, ["cards"]);
    assert.equal(r.status, "done", r.message);
    const lab = g.query(g.cat.lab) as Ok;
    assert.equal(lab.review.cards, 2);
    assert.equal(lab.review.due, 2, "never-reviewed cards are due");
    // The exam's space finds the same cards through its scope (their topics and sources are in it).
    const exam = g.query("a-mid2") as Ok;
    assert.ok(lab.review.cardItemIds.every((id) => exam.review.cardItemIds.includes(id)));

    const anchor = lab.anchorIds[0]!;
    const context = (id: string): StudyContext | null => {
      if (!lab.anchorIds.includes(id)) return null;
      const records = g.store.resources().filter((x) => !x.deleted && x.courseId === "SIG203" && eligibleStudySource(x, NOW.getTime()));
      return { resourceId: id, accountScope: "acct", courseId: "SIG203", inputHash: "in", contextHash: records.map((x) => x.contentHash).join(","), label: "SIG 203", availability: "current", reason: "Ready", resources: records.map((x) => ({ id: x.id, contentHash: x.contentHash, text: x.text, title: x.title, url: x.url, observedAt: x.observedAt, eligible: true })) };
    };
    const router = createLearningRouter({ store: g.store.learning, resolveContext: context, now: () => NOW });
    const only = lab.review.cardItemIds.slice(0, 1);
    const started = await router.handle({ op: "practice.target", courseId: "SIG203", anchorIds: [anchor], mode: "flashcards", count: 10, itemIds: only, operationId: "op-1" }, new AbortController().signal);
    assert.equal(started.status, "ok", started.message);
    const session = (started.data as { flashcards: { remaining: number; current?: { itemId: string } } }).flashcards;
    assert.equal(session.remaining, 1, "the session never widens beyond the item's cards");
    assert.equal(session.current?.itemId, only[0]);

    const course = studyPrepQuery(g.store, { view: "study.prep", courseId: "SIG203" }, NOW.toISOString()) as List;
    assert.equal(course.status, "list");
    assert.deepEqual(course.upcoming.map((u) => u.title), ["Quiz 3", "Midterm 2"]);
    assert.equal(course.assignments[g.cat.lab]!.materials.cards.status, "ready");
    assert.equal(course.assignments[g.cat.lab]!.due, 2);
    const all = studyPrepQuery(g.store, { view: "study.prep" }, NOW.toISOString()) as List;
    assert.deepEqual(all.upcoming.map((u) => `${u.courseName}: ${u.title}`), ["SIG 203 Synthetic Signals and Computation: Quiz 3", "SIG 203 Synthetic Signals and Computation: Midterm 2"]);
    assert.deepEqual(all.assignments, {}, "the global list carries no per-assignment states");
  } finally {
    g.store.close();
  }
});

test("before Canvas: only an open, unsubmitted quiz or exam asks to prep first", () => {
  const base = { courseId: "SIG203", resourceId: "q", title: "Quiz 3", url: "https://canvas.example.test/q", kind: "assignment", submissionTypes: ["online_quiz"] };
  assert.equal(shouldAskPrepFirst(base, NOW.getTime()), true);
  assert.equal(shouldAskPrepFirst({ ...base, submitted: true }, NOW.getTime()), false);
  assert.equal(shouldAskPrepFirst({ ...base, lockAt: "2026-10-01T00:00:00Z" }, NOW.getTime()), false);
  assert.equal(shouldAskPrepFirst({ ...base, title: "Homework 5", submissionTypes: ["online_upload"] }, NOW.getTime()), false);
  assert.equal(shouldAskPrepFirst({ ...base, kind: "material" }, NOW.getTime()), false);
  assert.equal(shouldAskPrepFirst({ ...base, title: "Midterm 2", submissionTypes: ["on_paper"] }, NOW.getTime()), true);
  void CATALOGUE;
  void READING;
});
