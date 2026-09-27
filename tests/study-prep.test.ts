// owner: study-prep. Study prepper end to end on a synthetic signals course with maths content:
// the `study.prep` query's shape (0 tokens), scope filtering, the combined pack through the
// (fake) student client, TeX in generated prose with plain verbatim quotes, the per-kind cache
// and its content-hash freshness, prompt reuse across kinds, progress, and the scoped ask.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { defaultPrivacy, queryRequestSchema, studyPrepKinds, studyPrepPackName, type StudyPrepResult } from "@magic/contracts";
import { createClaudeBackend, type CliCommand } from "../packages/runner/src/index";
import { createPackRuntime, strictSchemaIssues } from "../packages/packs/core/src/index";
import { createPackHandler } from "../packages/core/src/pack-handler";
import { studyPrepQuery } from "../packages/core/src/study-prep/query";
import type { StudyPrepRunResult } from "../packages/core/src/study-prep/generate";
import { MATH_RULE, prepAsk, prepContext, studyPrepPack, studyPrepOutputSchema, type PrepInput } from "../packages/packs/study-prep/src/index";
import { z } from "zod";
import { materialsBatch, NOW, passageId, signalsFixture, TEXTS } from "./study-prep-fixture";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
type Ok = Extract<StudyPrepResult, { status: "ok" }>;

const Q = {
  dtft: "The DTFT of a sequence x[n] is X(e^(jw)) = sum over all n of x[n] e^(-jwn).",
  periodic: "The DTFT is periodic in w with period 2*pi.",
  response: "The frequency response of an LTI system is the DTFT of its impulse response h[n].",
  nyquist: "A signal band-limited to B Hz can be recovered from its samples when the sampling rate fs is greater than 2B.",
  aliasing: "Sampling below the Nyquist rate causes aliasing: high frequencies appear as low ones.",
  period: "A 3 kHz tone sampled at 8 kHz has a sampling period of 1/8000 s, which is 0.000125 s.",
  rate: "The Nyquist rate is 2B = 8 kHz.",
};
const block = (sourceId: string, topic: string, text: string, quote: string, over: Record<string, unknown> = {}) => ({
  kind: "point", topic, heading: null, text, expression: null, result: null, date: null, cells: null, sourceId, quote, ...over,
});
const guidePart = (p: Record<string, string>) => ({
  title: "Midterm 2 study guide",
  sections: [
    {
      title: "The DTFT",
      topics: ["DTFT"],
      columns: null,
      blocks: [
        block(p.dtft!, "DTFT", "The DTFT of $x[n]$: $$X(e^{j\\omega}) = \\sum_{n=-\\infty}^{\\infty} x[n]\\,e^{-j\\omega n}$$", Q.dtft, { kind: "definition", heading: "DTFT" }),
        block(p.dtft!, "DTFT", "$X(e^{j\\omega})$ is periodic in $\\omega$ with period $2\\pi$.", Q.periodic),
        // A quote rewritten as TeX isn't in the passage: code drops the block.
        block(p.dtft!, "DTFT", "Periodicity.", "$X(e^{j\\omega})$ is periodic in $\\omega$ with period $2\\pi$."),
      ],
    },
    {
      title: "Sampling",
      topics: ["Sampling theorem"],
      columns: null,
      blocks: [
        block(p.sampling!, "Sampling theorem", "Recovery needs $f_s > 2B$.", Q.nyquist),
        block(p.sampling!, "Sampling theorem", "The sampling period is $T_s = 1/f_s$.", Q.period, { kind: "example", expression: "1/8000", result: "0.000125" }),
      ],
    },
  ],
});
const quizPart = (p: Record<string, string>) => ({
  items: [
    {
      kind: "mc",
      stem: "Which expression is the DTFT of $x[n]$?",
      options: [
        { text: "$\\sum_{n} x[n] e^{-j\\omega n}$", correct: true },
        { text: "$\\sum_{n} x[n] e^{j\\omega n}$", correct: false },
        { text: "$\\int x(t) e^{-j\\omega t}\\,dt$", correct: false },
        { text: "$x[n] * h[n]$", correct: false },
      ],
      statementIsTrue: null,
      numeric: null,
      explanation: "The lecture defines $X(e^{j\\omega}) = \\sum_n x[n] e^{-j\\omega n}$.",
      topics: ["DTFT"],
      section: "Module 3: The Discrete-Time Fourier Transform",
      bloom: "remember",
      sourceId: p.dtft!,
      quote: Q.dtft,
    },
    {
      kind: "tf",
      stem: "Sampling below the Nyquist rate causes aliasing.",
      options: [],
      statementIsTrue: true,
      numeric: null,
      explanation: "High frequencies appear as low ones when $f_s < 2B$.",
      topics: ["Aliasing"],
      section: "Module 4: Sampling",
      bloom: "understand",
      sourceId: p.sampling!,
      quote: Q.aliasing,
    },
    {
      kind: "numeric",
      stem: "What is the Nyquist rate of a signal band-limited to $B = 4$ kHz?",
      options: [],
      statementIsTrue: null,
      numeric: { value: 8, unit: "kHz", formula: "2 * 4" },
      explanation: "$f_N = 2B = 8$ kHz.",
      topics: ["Sampling theorem"],
      section: "Module 4: Sampling",
      bloom: "apply",
      sourceId: p.solutions!,
      quote: Q.rate,
    },
  ],
});
const cardsPart = (p: Record<string, string>) => ({
  cards: [
    { kind: "term", front: "Nyquist rate", back: "$2B$: twice the highest frequency $B$", topics: ["Sampling theorem"], section: "Module 4: Sampling", sourceId: p.sampling!, quote: Q.nyquist },
    { kind: "cloze", front: Q.periodic, back: "2*pi", topics: ["DTFT"], section: "Module 3: The Discrete-Time Fourier Transform", sourceId: p.dtft!, quote: Q.periodic },
    { kind: "term", front: "Aliasing", back: "High frequencies appear as low ones when $f_s < 2B$", topics: ["Aliasing"], section: "Module 4: Sampling", sourceId: p.sampling!, quote: Q.aliasing },
  ],
});
const output = (p: Record<string, string>, kinds: ("guide" | "quiz" | "cards")[]) => ({
  output: { guide: kinds.includes("guide") ? guidePart(p) : null, quiz: kinds.includes("quiz") ? quizPart(p) : null, cards: kinds.includes("cards") ? cardsPart(p) : null },
});

async function setup(responses: (p: Record<string, string>) => unknown[]) {
  const f = signalsFixture(createStore(":memory:"));
  const store = f.store;
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  const p = { dtft: passageId(store, f.ids.dtft!), sampling: passageId(store, f.ids.sampling!), solutions: passageId(store, f.ids.solutions!) };
  const dir = await mkdtemp(join(tmpdir(), "study-prep-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const log = join(dir, "log.jsonl");
  const env = { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify(responses(p)) };
  const runner = createPackRuntime(createClaudeBackend({ command: fake, workDir, env }), { dailyBackgroundTokens: 1_000_000 }).runner;
  const handler = createPackHandler({ store, runner: () => runner, now: () => NOW });
  const core = createCore(store, { fixture: materialsBatch(), seams: { pack: handler.pack } });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const lines = async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[]; stdin?: string }) : []);
  const calls = async () => (await lines()).filter((l) => l.argv).length;
  const prompts = async () => (await lines()).filter((l) => l.argv).map((l) => l.stdin ?? "");
  const query = (extra: Record<string, unknown> = {}) => {
    const request = queryRequestSchema.parse({ view: "study.prep", courseId: "SIG203", assessmentId: "a-mid2", ...extra });
    return studyPrepQuery(store, request as Extract<typeof request, { view: "study.prep" }>, NOW.toISOString());
  };
  const generate = async (kinds: ("guide" | "quiz" | "cards")[], scope: Record<string, unknown> = {}) =>
    (await core.execute({ type: "pack", pack: studyPrepPackName(kinds), scope: { courseId: "SIG203", assessmentId: "a-mid2", ...scope } })).pack as StudyPrepRunResult;
  return { ...f, core, handler, p, calls, prompts, query, generate };
}

test("the pack name carries the kinds in a fixed order; other names aren't study-prep packs", () => {
  assert.equal(studyPrepPackName(["cards", "guide"]), "study-prep-guide-cards");
  assert.deepEqual(studyPrepKinds("study-prep-quiz-guide"), ["guide", "quiz"]);
  assert.equal(studyPrepKinds("study-prep-essay"), null);
  assert.equal(studyPrepKinds("quiz"), null);
});

test("study.prep: the assessment, its coverage as sources, filter chips, a code-built overview and missing materials, at 0 tokens", async () => {
  const g = await setup(() => [{}]);
  try {
    const r = g.query();
    assert.equal(r.status, "ok");
    const ok = r as Ok;
    assert.equal(ok.modelCalls, 0);
    assert.equal(ok.assessment.title, "Midterm 2");
    assert.equal(ok.assessment.date, "2026-10-15");
    assert.equal(ok.assessment.daysAway, 10);
    assert.equal(ok.assessment.where, "held in Room 1100 Synthetic Hall", "the syllabus line naming Midterm 2 wins over 'in class'");
    const titles = ok.sources.map((s) => s.title);
    assert.deepEqual(titles, ["Lecture 7: The DTFT", "Lecture 9: Sampling", "Homework 5", "Midterm 2 Practice Exam", "Midterm 2 Practice Exam Solutions"]);
    assert.ok(!titles.includes("Lecture 1: Complex Exponentials"), "Module 1 is outside the stated scope");
    assert.ok(!titles.includes("Homework 6"), "open homework is never a study source");
    assert.ok(!titles.includes("Syllabus"), "the syllabus is the prompt prefix, not a source");
    assert.deepEqual(ok.sources.map((s) => s.role), ["lecture", "lecture", "homework", "practice_exam", "solutions"]);
    assert.ok(ok.sources.every((s) => s.checked && s.reason && s.passages === 1));
    assert.equal(ok.scope.all, true);
    const kinds = ok.scopeItems.map((i) => `${i.kind}:${i.title}`);
    assert.ok(kinds.includes("module:Module 3: The Discrete-Time Fourier Transform"));
    assert.ok(kinds.includes("topic:Aliasing"));
    assert.ok(kinds.includes("assignment:Homework 5"));
    assert.ok(!kinds.some((k) => k.includes("Euler")), "out-of-scope topics aren't chips");
    assert.equal(ok.overview.covered[0]!.text, "Midterm 2 covers Modules 3 and 4.");
    assert.equal(ok.overview.covered[0]!.source?.title, "Syllabus");
    assert.deepEqual(ok.overview.modules, ["Module 3: The Discrete-Time Fourier Transform", "Module 4: Sampling"]);
    assert.ok(ok.overview.keyTerms.some((t) => t.kind === "formula" && t.value.startsWith("X(e^(jw))")));
    const dtft = g.store.resource(g.ids.dtft!)!;
    const term = ok.overview.keyTerms.find((t) => t.value === "frequency response")!;
    assert.equal(dtft.text.slice(term.source.start!, term.source.end!), "frequency response", "every key term points at its span");
    assert.deepEqual(ok.overview.dates.map((d) => d.date), ["2026-09-24", "2026-10-15"]);
    for (const k of ["guide", "quiz", "cards"] as const) assert.equal(ok.materials[k].status, "missing");
    assert.ok(ok.anchorIds.length > 0);
    assert.equal(await g.calls(), 0);

    const list = studyPrepQuery(g.store, { view: "study.prep", courseId: "SIG203" }, NOW.toISOString());
    assert.equal(list.status, "list");
    if (list.status === "list") assert.deepEqual(list.upcoming.map((a) => a.title), ["Midterm 2"], "past exams aren't listed");
    assert.equal(g.query({ assessmentId: "nope" }).status, "missing");
  } finally {
    g.store.close();
  }
});

test("scope filtering: ticked sources and topics narrow the selection, unknown ids are dropped, and each selection has its own hash", async () => {
  const g = await setup(() => [{}]);
  try {
    const all = g.query() as Ok;
    const one = g.query({ resourceIds: [g.ids.sampling!, "not-a-source", g.ids.euler!] }) as Ok;
    assert.equal(one.scope.all, false);
    assert.deepEqual(one.scope.resourceIds, [g.ids.sampling]);
    assert.deepEqual(one.sources.filter((s) => s.checked).map((s) => s.title), ["Lecture 9: Sampling"]);
    assert.equal(one.sources.length, all.sources.length, "unticked sources stay listed");
    assert.notEqual(one.scope.hash, all.scope.hash);
    const everything = g.query({ resourceIds: all.sources.map((s) => s.resourceId) }) as Ok;
    assert.equal(everything.scope.all, true);
    assert.equal(everything.scope.hash, all.scope.hash, "ticking every source is 'All coverage'");
    const topic = g.query({ topicIds: [g.topics.aliasing!, g.topics.euler!] }) as Ok;
    assert.deepEqual(topic.scope.topicIds, [g.topics.aliasing], "a topic outside the scope is dropped");
    assert.notEqual(topic.scope.hash, all.scope.hash);
    const chip = all.scopeItems.find((i) => i.kind === "module" && i.title.startsWith("Module 4"))!;
    assert.deepEqual(chip.resourceIds, [g.ids.sampling]);
  } finally {
    g.store.close();
  }
});

test("the study-prep pack: strict schema, TeX rule in the prompt, and a kind-independent prefix before `## Write`", () => {
  assert.deepEqual(strictSchemaIssues(z.toJSONSchema(studyPrepOutputSchema, { io: "output" })), []);
  const input: PrepInput = { kinds: ["guide"], counts: { quiz: 10, cards: 12 }, scope: "Midterm: Midterm 2", materials: ["Lecture 7"], sections: [], topics: ["DTFT"], focus: [], facts: [] };
  const one = studyPrepPack.template(input);
  const three = studyPrepPack.template({ ...input, kinds: ["guide", "quiz", "cards"] });
  assert.ok(one.includes(MATH_RULE) && MATH_RULE.includes("$$") && MATH_RULE.includes("never rewritten as TeX"));
  assert.equal(one.slice(0, one.indexOf("## Write")), three.slice(0, three.indexOf("## Write")));
  assert.equal(prepContext(input), prepContext({ ...input, kinds: ["cards"] }));
  assert.match(prepAsk(input), /Set `quiz` and `cards` to null/);
  assert.ok(!prepAsk({ ...input, kinds: ["guide", "quiz", "cards"] }).includes("to null"));
});

test("one call makes all three kinds: TeX survives in prose, quotes are checked verbatim, items and cards are stored, and the query shows them", async () => {
  const g = await setup((p) => [output(p, ["guide", "quiz", "cards"])]);
  try {
    const r = await g.generate(["guide", "quiz", "cards"]);
    assert.equal(r.status, "done", r.message);
    assert.equal(await g.calls(), 1, "one call for three kinds");
    assert.equal(r.cached, false);
    assert.deepEqual(r.counts.guide, { generated: 5, accepted: 4, dropped: 1 });
    assert.ok(r.drops.some((d) => d.kind === "guide" && /quote/.test(d.reason)), "the TeX-ified quote is dropped by code");
    assert.equal(r.counts.quiz?.accepted, 3, JSON.stringify(r.drops));
    assert.equal(r.counts.cards?.accepted, 3, JSON.stringify(r.drops));
    assert.ok(g.store.receipts().some((x) => x.recipient === "claude" && x.status === "sent" && /Midterm 2/.test(x.purpose)));
    const [prompt] = await g.prompts();
    assert.ok(prompt!.includes("TeX") && prompt!.includes(TEXTS.dtft.split("\n")[1]!), "the passages and the TeX rule were sent");
    assert.ok(!prompt!.includes("Euler's formula states"), "only the ticked sources' passages are sent");

    const q = g.query() as Ok;
    assert.equal(q.materials.guide.status, "ready");
    assert.equal(q.materials.guide.count, 2);
    const def = q.materials.guide.guide!.sections[0]!.blocks[0]!;
    assert.ok(def.text.includes("$$X(e^{j\\omega}) = \\sum_{n=-\\infty}^{\\infty}"), "display TeX is kept as written");
    const dtft = g.store.resource(g.ids.dtft!)!;
    assert.equal(dtft.text.slice(def.source.start!, def.source.end!), Q.dtft, "the quote is placed in its source");
    const example = q.materials.guide.guide!.sections[1]!.blocks.find((b) => b.kind === "example")!;
    assert.equal(example.computed, "0.000125");
    assert.equal(q.materials.quiz.status, "ready");
    assert.deepEqual(q.materials.quiz.quiz!.map((i) => i.kind), ["mc", "tf", "numeric"]);
    const mc = q.materials.quiz.quiz![0]!;
    assert.ok(mc.options!.some((o) => o.id === mc.key), "the key is one of the options");
    assert.ok(mc.stem.includes("$x[n]$"));
    assert.equal(q.materials.quiz.quiz![2]!.key, 8);
    assert.equal(q.materials.cards.status, "ready");
    assert.equal(q.materials.cards.cards!.length, 3);
    const cloze = q.materials.cards.cards!.find((c) => c.kind === "cloze")!;
    assert.ok(cloze.front.includes("_____") && cloze.back === "2*pi");
    assert.ok(q.materials.cards.cards!.filter((c) => c.kind === "card").every((c) => c.cardId?.startsWith("card-") && c.due), "each term card is an FSRS card");
    assert.equal(cloze.cardId, null, "a cloze card is a recall item, not an FSRS card");
    assert.ok(q.materials.cards.cards!.every((c) => c.source.quote && c.source.resourceId));
  } finally {
    g.store.close();
  }
});

test("cache: a repeat is free, a kind made together is current alone, and a changed source makes it stale until regenerated", async () => {
  const g = await setup((p) => [output(p, ["guide", "quiz", "cards"]), output(p, ["quiz"])]);
  try {
    assert.equal((await g.generate(["guide", "quiz", "cards"])).status, "done");
    assert.equal(await g.calls(), 1);
    const again = await g.generate(["guide", "quiz", "cards"]);
    assert.equal(again.status, "done");
    assert.equal(again.cached, true);
    assert.deepEqual(again.tokens, { in: 0, cached: 0, out: 0 });
    assert.deepEqual(again.current, ["guide", "quiz", "cards"]);
    const alone = await g.generate(["quiz"]);
    assert.deepEqual(alone.current, ["quiz"]);
    assert.equal(await g.calls(), 1, "no call for material that is current");

    // The DTFT lecture changes: everything made from it is stale, and says which source changed.
    g.store.ingest(materialsBatch({ dtft: `${TEXTS.dtft}\nThe inverse DTFT recovers x[n] from X(e^(jw)).` }, new Date(NOW.getTime() + 60_000).toISOString()));
    const stale = g.query() as Ok;
    assert.equal(stale.materials.quiz.status, "stale");
    assert.deepEqual(stale.materials.quiz.changed, ["Lecture 7: The DTFT"]);
    assert.equal(stale.materials.quiz.quiz!.length > 0, true, "stale material stays visible");
    const redo = await g.generate(["quiz"]);
    assert.equal(redo.status, "done", redo.message);
    assert.equal(redo.cached, false);
    assert.equal(await g.calls(), 2, "a changed content hash is the only thing that regenerates");
    assert.equal((g.query() as Ok).materials.quiz.status, "ready");
    assert.equal((g.query() as Ok).materials.guide.status, "stale", "kinds not regenerated stay stale");
  } finally {
    g.store.close();
  }
});

test("prompt reuse: separate kinds send the same passages and a byte-identical prefix; measured prompt size for one kind vs all three", async () => {
  const g = await setup((p) => [output(p, ["guide"]), output(p, ["quiz"]), output(p, ["cards"])]);
  try {
    const guide = await g.generate(["guide"]);
    const quiz = await g.generate(["quiz"]);
    const cards = await g.generate(["cards"]);
    for (const r of [guide, quiz, cards]) assert.equal(r.status, "done", r.message);
    assert.equal(guide.prompt!.reusedPassages, false);
    assert.equal(quiz.prompt!.reusedPassages, true, "the second kind reuses the stored passage set");
    const prompts = await g.prompts();
    assert.equal(prompts.length, 3);
    const head = (s: string) => s.slice(0, s.indexOf("## Write"));
    assert.equal(head(prompts[1]!), head(prompts[0]!), "everything before `## Write` is byte-identical across kinds");
    assert.equal(head(prompts[2]!), head(prompts[0]!));

    const combined = await setup((p) => [output(p, ["guide", "quiz", "cards"])]);
    try {
      const all = await combined.generate(["guide", "quiz", "cards"]);
      assert.equal(all.status, "done", all.message);
      const [allPrompt] = await combined.prompts();
      const est = (s: string) => Math.ceil(s.length / 4);
      const separate = prompts.reduce((n, s) => n + est(s), 0);
      // Whole prompt (system prefix + input) as the handler assembled it, and the input alone as the fake CLI received it on stdin.
      const whole = { guideOnly: guide.prompt!.tokensEst, quizOnly: quiz.prompt!.tokensEst, cardsOnly: cards.prompt!.tokensEst, allThreeCombined: all.prompt!.tokensEst };
      const wholeSeparate = whole.guideOnly + whole.quizOnly + whole.cardsOnly;
      console.log(
        `STUDY-PREP-PROMPT ${JSON.stringify({ tokensEstimate: "chars/4", whole: { ...whole, threeSeparate: wholeSeparate }, stdinOnly: { guideOnly: est(prompts[0]!), quizOnly: est(prompts[1]!), cardsOnly: est(prompts[2]!), threeSeparate: separate, allThreeCombined: est(allPrompt!) }, passages: all.prompt!.passages, prefixChars: all.prompt!.prefixChars })}`,
      );
      assert.ok(est(allPrompt!) < separate / 2, "one combined call sends well under half the input tokens of three separate calls");
      assert.ok(whole.allThreeCombined < wholeSeparate / 2, "and well under half the whole prompt");
    } finally {
      combined.store.close();
    }
  } finally {
    g.store.close();
  }
});

test("progress: the query reads `generating` while the call runs, then `ready`", async () => {
  const g = await setup((p) => [{ ...output(p, ["cards"]), sleepMs: 1500 }]);
  try {
    const running = g.generate(["cards"]);
    let seen = false;
    for (let i = 0; i < 60 && !seen; i++) {
      await new Promise((r) => setTimeout(r, 50));
      seen = (g.query() as Ok).materials.cards.status === "generating";
    }
    assert.ok(seen, "generating was visible while the call ran");
    assert.equal((await running).status, "done");
    assert.equal((g.query() as Ok).materials.cards.status, "ready");
  } finally {
    g.store.close();
  }
});

test("no client: nothing is sent, the kind reads failed with the reason, and a restricted course generates nothing", async () => {
  const f = signalsFixture(createStore(":memory:"));
  try {
    const handler = createPackHandler({ store: f.store, runner: () => null, now: () => NOW });
    const r = (await handler.pack(studyPrepPackName(["guide"]), { courseId: "SIG203", assessmentId: "a-mid2" }, new AbortController().signal)) as StudyPrepRunResult;
    assert.equal(r.status, "no_client");
    const q = studyPrepQuery(f.store, { view: "study.prep", courseId: "SIG203", assessmentId: "a-mid2" }, NOW.toISOString()) as Ok;
    assert.equal(q.materials.guide.status, "failed");
    assert.match(q.materials.guide.message ?? "", /Connect your AI/);
    const none = (await handler.pack(studyPrepPackName(["quiz"]), { courseId: "SIG203", assessmentId: "a-mid2", resourceIds: ["not-a-source"] }, new AbortController().signal)) as StudyPrepRunResult;
    assert.equal(none.status, "empty");
  } finally {
    f.store.close();
  }
});

test("notebook.ask over the ticked sources: a question outside them answers 'Not in your materials' with no call", async () => {
  const g = await setup(() => [{}]);
  try {
    const r = await g.handler.studyPrep.ask(
      { courseId: "SIG203", question: "What is the DTFT of a sequence?", scope: { assessmentId: "a-mid2", resourceIds: [g.ids.sampling!] } },
      new AbortController().signal,
    );
    assert.equal(r.status, "ok");
    assert.equal((r.data as { notFound: boolean }).notFound, true);
    assert.equal(await g.calls(), 0);
  } finally {
    g.store.close();
  }
});
