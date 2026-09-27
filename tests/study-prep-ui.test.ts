// owner: study-prep. The Study prepper UI's code parts: answer checking, the effective selection
// from ticks and chips, and the guide, quiz and cards views rendering TeX and their sources.
import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StudyPrepCard, StudyPrepGuide, StudyPrepQuizItem, StudyPrepScopeItem, StudyPrepSource } from "@magic/contracts";
import { checkAnswer, parseNumber } from "../apps/desktop/src/renderer/study-prep/quiz-check";
import { effectiveSources } from "../apps/desktop/src/renderer/study-prep/StudyPrep";
import { CardsView, GuideView, QuizView } from "../apps/desktop/src/renderer/study-prep/views";

// packages/ui compiles with the classic JSX runtime under tsx (as in tests/sources-page.test.ts).
(globalThis as { React?: typeof React }).React = React;

const source = { resourceId: "r-dtft", title: "Lecture 7: The DTFT", url: "https://canvas.example.test/x", quote: "The DTFT of a sequence x[n]", start: 0, end: 27 };

test("answers are graded by code: choices by key, numbers with tolerance and units", () => {
  const mc = { kind: "mc" as const, options: [{ id: "a", text: "$e^{-j\\omega n}$" }, { id: "b", text: "$e^{j\\omega n}$" }], key: "a", unit: null };
  assert.equal(checkAnswer(mc, { kind: "choice", optionId: "a" }).status, "right");
  const wrong = checkAnswer(mc, { kind: "choice", optionId: "b" });
  assert.equal(wrong.status, "wrong");
  assert.equal("expected" in wrong ? wrong.expected : "", "$e^{-j\\omega n}$");
  assert.equal(checkAnswer(mc, { kind: "choice", optionId: "z" }).status, "invalid");
  const num = { kind: "numeric" as const, options: null, key: 0.000125, unit: "s" };
  assert.equal(checkAnswer(num, { kind: "number", text: "1/8000" }).status, "right");
  assert.equal(checkAnswer(num, { kind: "number", text: "0.000125 s" }).status, "right");
  assert.equal(checkAnswer(num, { kind: "number", text: "1.25e-4" }).status, "right");
  assert.equal(checkAnswer(num, { kind: "number", text: "0.0002" }).status, "wrong");
  assert.equal(checkAnswer(num, { kind: "number", text: "0.000125 ms" }).status, "invalid", "a different unit is refused, not graded wrong");
  assert.deepEqual(parseNumber("abc", null), { reason: "Enter a number." });
  assert.equal(checkAnswer({ kind: "numeric", options: null, key: 8, unit: null }, { kind: "number", text: "8.05" }).status, "right", "within 1%");
});

test("the effective selection: ticked sources, narrowed by assignment and module chips; topics never narrow", () => {
  const s = (id: string): StudyPrepSource => ({ resourceId: id, title: id, url: null, role: "lecture", moduleId: null, moduleLabel: null, reason: "", checked: true, topicIds: [], assignmentIds: [], passages: 1 });
  const sources = ["a", "b", "c", "d"].map(s);
  const items: StudyPrepScopeItem[] = [
    { kind: "module", id: "m3", title: "Module 3", resourceIds: ["a", "b"] },
    { kind: "assignment", id: "hw5", title: "Homework 5", resourceIds: ["c"] },
    { kind: "topic", id: "t", title: "DTFT", resourceIds: ["a"] },
  ];
  assert.deepEqual(effectiveSources(sources, null, new Set(), items), ["a", "b", "c", "d"]);
  assert.deepEqual(effectiveSources(sources, new Set(["a", "c"]), new Set(), items), ["a", "c"]);
  assert.deepEqual(effectiveSources(sources, null, new Set(["module:m3"]), items), ["a", "b"]);
  assert.deepEqual(effectiveSources(sources, null, new Set(["module:m3", "assignment:hw5"]), items), ["a", "b", "c"]);
  assert.deepEqual(effectiveSources(sources, new Set(["b"]), new Set(["module:m3"]), items), ["b"]);
  assert.deepEqual(effectiveSources(sources, null, new Set(["topic:t"]), items), ["a", "b", "c", "d"]);
});

test("the guide renders sections, TeX and a source link that opens the resource in the app", () => {
  const guide: StudyPrepGuide = {
    title: "Midterm 2 study guide",
    sections: [
      {
        id: "s0",
        title: "The DTFT",
        topics: ["DTFT"],
        blocks: [
          { id: "s0b0", kind: "definition", topic: "DTFT", heading: "DTFT", text: "$$X(e^{j\\omega}) = \\sum_n x[n] e^{-j\\omega n}$$", expression: null, computed: null, source },
          { id: "s0b1", kind: "example", topic: "Sampling", heading: null, text: "$T_s = 1/f_s$", expression: "1/8000", computed: "0.000125", source },
        ],
      },
    ],
  };
  const html = renderToStaticMarkup(React.createElement(GuideView, { guide }));
  assert.match(html, /<details[^>]*open/);
  assert.match(html, /katex-display/);
  assert.match(html, /1\/8000 = 0\.000125/);
  assert.match(html, /href="#resource\/r-dtft"/);
  assert.match(html, /title="“The DTFT of a sequence x\[n\]” \(Lecture 7: The DTFT\)"/);
  assert.match(renderToStaticMarkup(React.createElement(GuideView, { guide: { title: "x", sections: [] } })), /Nothing in this guide passed the checks/);
});

test("the quiz shows one question at a time with TeX options; the cards deck shows the front first", () => {
  const items: StudyPrepQuizItem[] = [
    { itemId: "q1", version: 1, kind: "mc", stem: "Which is the DTFT of $x[n]$?", options: [{ id: "a", text: "$\\sum_n x[n]e^{-j\\omega n}$" }, { id: "b", text: "$\\sum_n x[n]e^{j\\omega n}$" }], key: "a", unit: null, explanation: "By definition.", topics: ["DTFT"], source },
    { itemId: "q2", version: 1, kind: "numeric", stem: "Nyquist rate for $B = 4$ kHz?", options: null, key: 8, unit: "kHz", explanation: null, topics: [], source },
  ];
  const quiz = renderToStaticMarkup(React.createElement(QuizView, { items }));
  assert.match(quiz, /1 \/ 2/);
  assert.match(quiz, /role="radiogroup"/);
  assert.equal((quiz.match(/class="katex"/g) ?? []).length, 3, "the stem and both options render TeX");
  assert.doesNotMatch(quiz, /Nyquist/, "only the current question is shown");
  assert.doesNotMatch(quiz, /By definition/, "the explanation waits for the check");
  const cards: StudyPrepCard[] = [{ cardId: "card-1", itemId: "i1", kind: "card", front: "Nyquist rate", back: "$2B$", topics: ["Sampling theorem"], due: null, source }];
  const deck = renderToStaticMarkup(React.createElement(CardsView, { cards, courseId: "SIG203", assessmentId: "a-mid2", anchorIds: ["r-dtft"] }));
  assert.match(deck, /Nyquist rate/);
  assert.doesNotMatch(deck, /katex/, "the back isn't shown until flipped");
  assert.match(deck, /aria-pressed="false"/);
});
