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

// Live stress test, 2026-09-27 (evals/break-live): every sentence the claim check flagged was correct.
// These are those shapes; the failure itself must still be caught.
test("B1 live: codes, labels, heading dates and shown arithmetic pass; contradictions still don't", () => {
  const moved = "the midterm has moved to Thursday, October 16, in B10 Ingraham Hall";
  assert.ok(claimsMatch("The midterm is now on Thursday, October 16, in B10 Ingraham Hall.", moved), "a room code is not the name B");
  assert.ok(!claimsMatch("The midterm is in B12 Ingraham Hall.", moved), "a different room code");
  const hw = "Announcement: I've extended Homework 4 by two days because Canvas was down; it is now due Sunday, October 5 at 11:59 PM.";
  assert.ok(claimsMatch("So Homework 4 is now due Sunday, October 5 at 11:59 PM.", "it is now due Sunday, October 5 at 11:59 PM", { passages: hw }), "a label just outside the quote");
  assert.ok(!claimsMatch("So Homework 5 is now due Sunday, October 5 at 11:59 PM.", "it is now due Sunday, October 5 at 11:59 PM", { passages: hw }));
  const vote = "Announcement (Sep 20): After the class vote, the final project is now worth 40% and participation is worth 5%.";
  assert.ok(claimsMatch("A class vote announced on Sep 20 changed the final project weight to 40%.", "the final project is now worth 40%", { passages: vote }), "a heading date when the quote states none");
  assert.ok(!claimsMatch("The midterm is on October 21.", "The midterm exam is on October 14.", { passages: "The midterm exam is on October 14. Review is October 21." }), "a quoted date still wins over the passage");
  const hwq = "There are 8 homework assignments, each worth 25 points. The lowest homework score is dropped.";
  assert.ok(claimsMatch("The lowest is dropped, so 8 − 1 = 7 count, and 7 × 25 = 175 points.", hwq), "arithmetic written out and re-done");
  assert.ok(!claimsMatch("So 7 × 25 = 185 points.", hwq), "wrong arithmetic");
  assert.ok(!claimsMatch("The category is worth 175 points.", hwq), "an unexplained number");
  assert.ok(claimsMatch("That makes 72 hours.", "Each late day extends a deadline by 24 hours.", { known: ["3"], passages: "You have 3 late days." }) === false, "72 with no calculation shown");
  assert.ok(claimsMatch("Using all 3 gives 3 × 24 = 72 hours.", "You have 3 late days in total. Each late day extends a deadline by 24 hours."));
  const dates = "The proposal is due October 6. The final report is due December 8.";
  assert.ok(claimsMatch("From October 6 to December 8 is 63 days.", dates), "days between two named dates");
  assert.ok(!claimsMatch("From October 6 to December 8 is 70 days.", dates));
  const sections = "302 meets Thursday 9:55 AM in 1261 Sterling Hall with Omar Haddad. 303 meets Thursday 1:20 PM in 2241 Chamberlin with Priya Nair.";
  assert.ok(!claimsMatch("Priya Nair runs the section in 1261 Sterling Hall.", "302 meets Thursday 9:55 AM in 1261 Sterling Hall with Omar Haddad.", { passages: sections }), "a neighbour's name");
});

test("B1 live, second run: punctuation in labels, a label word from the passage, and shown date arithmetic", () => {
  assert.ok(claimsMatch("The MATH 222 Midterm 1 is on Wednesday, October 8, from 5:45 to 7:15 PM.", "MATH 222: Midterm 1 is Wednesday, October 8, 5:45 to 7:15 PM."));
  assert.ok(!claimsMatch("The MATH 222 Midterm 2 is on Wednesday, October 8.", "MATH 222: Midterm 1 is Wednesday, October 8, 5:45 to 7:15 PM."));
  const sections = "Discussion sections: 302 meets Thursday 9:55 AM in 1261 Sterling Hall with Omar Haddad. 303 meets Thursday 1:20 PM in 2241 Chamberlin with Priya Nair.";
  assert.ok(claimsMatch("Section 303 also meets on Thursday, at 1:20 PM in 2241 Chamberlin, run by Priya Nair.", "303 meets Thursday 1:20 PM in 2241 Chamberlin with Priya Nair", { passages: sections }));
  assert.ok(!claimsMatch("Section 302 meets at 1:20 PM.", "303 meets Thursday 1:20 PM in 2241 Chamberlin with Priya Nair", { passages: sections }));
  const lab = "Lab 3 runs the week of October 13";
  assert.ok(claimsMatch("The next session falls the week of October 20 (October 13 + 7 days).", lab));
  assert.ok(!claimsMatch("The report is due the week of October 27 (October 13 + 7 days).", lab), "wrong date arithmetic");
  assert.ok(!claimsMatch("The report is due the week of October 20.", lab), "an unexplained date");
});
