// Break card B1: a grounded answer's quote was checked, its sentence was not. A scripted fake model
// cites a real quote but states a different date, number, name, weekday or room. Synthetic cases only.
import test from "node:test";
import assert from "node:assert/strict";
import { checkAnswer, claimsMatch } from "../packages/core/src/intent/ask";
import { askCases, pct } from "./break-cases";

const N = 60;
const meta = new Map([["p1", { resourceId: "r1", title: "Syllabus", url: "https://canvas.example.edu/courses/1/assignments/syllabus" }]]);
/** The scripted fake model: one sentence citing the real quote. */
function answer(passage: string, quote: string, sentence: string) {
  return checkAnswer({ found: true, sentences: [{ text: sentence, citations: [{ sourceId: "p1", quote }] }] }, [{ sourceId: "p1", text: passage }], meta, () => passage);
}
const shown = (text: string, sentence: string) => text.includes(sentence.trim());

test("B1: a sentence that contradicts its real quote is never shown; the quote is shown instead", () => {
  const cases = askCases(N);
  let wrongShown = 0;
  for (const c of cases) {
    const out = answer(c.passage, c.quote, c.wrong);
    assert.equal(out.citations.length, 1, "the quote itself is real and still cited");
    if (shown(out.text, c.wrong)) wrongShown++;
    else assert.ok(out.text.includes(c.quote), `falls back to the quote: ${c.wrong}`);
  }
  console.log(`B1 mismatched sentences shown (after): ${pct(wrongShown, N)}`);
  assert.equal(wrongShown, 0);
});

test("B1: correct paraphrases still pass (false rejects)", () => {
  const cases = askCases(N);
  let rejected = 0;
  for (const c of cases) if (!shown(answer(c.passage, c.quote, c.right).text, c.right)) rejected++;
  console.log(`B1 correct sentences rejected (after): ${pct(rejected, N)}`);
  assert.equal(rejected, 0);
});

test("B1: the claim check reads dates, numbers and names the way a student would", () => {
  assert.ok(claimsMatch("Your midterm is on Oct 14.", "The midterm exam is on October 14 in 1240 Humanities."));
  assert.ok(!claimsMatch("Your midterm is on Oct 21.", "The midterm exam is on October 14 in 1240 Humanities."));
  assert.ok(!claimsMatch("It is on November 14.", "The midterm exam is on October 14."));
  assert.ok(claimsMatch("Priya Raman holds office hours.", "Office hours are held by Priya Raman on Tuesdays."));
  assert.ok(!claimsMatch("Office hours are with Daniel Ortiz.", "Office hours are held by Priya Raman on Tuesdays."));
  assert.ok(claimsMatch("It counts for 1,200 points.", "The project is worth 1200 points."));
  assert.ok(!claimsMatch("Sections meet on Fridays.", "Discussion sections meet every Thursday at 2:30 pm."));
  assert.ok(claimsMatch("The exam covers chapters one to four.", "The exam covers chapters one to four."));
});
