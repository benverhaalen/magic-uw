// Break card, live: the student's own Claude Code answers grounded questions through the app's real
// ask pack (the same system prompt, schema and instant-mode client path the worker uses), on
// synthetic course pages built to stress the failure: an update that supersedes a syllabus fact,
// neighbouring numbers, a derived answer, similar names and weekdays. Code then counts how often a
// sentence states a date, number, weekday or name that its own cited quote doesn't contain
// (`claimsMatch`), which is what the student saw with a working citation before the fix, and what
// `checkAnswer` shows after it. Synthetic pages only; no course data. Run:
//   pnpm exec tsx evals/break-live/run.ts [repeats=3] [concurrency=4]
// It writes evals/break-live/results.json (raw answers, per-sentence verdicts, usage).
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeBackend, createCodexBackend, createModelRunner } from "../../packages/runner/src/index";
import { buildPrompt, type CourseFrame } from "../../packages/packs/core/src/index";
import { askPack } from "../../packages/packs/intent/src/index";
import { coursePackCatalogue } from "../../packages/core/src/course-facts/prefix";
import { checkAnswer, claimsMatch } from "../../packages/core/src/intent/ask";
import { clientBackend } from "../../apps/desktop/src/clients/health";

type Case = { id: string; family: string; question: string; passages: string[] };
const CASES: Case[] = [
  // Updates that supersede a syllabus fact.
  { id: "u1", family: "update", question: "When and where is the midterm?", passages: ["Syllabus: The midterm exam is on October 14 in 1240 Humanities, 7:15 to 9:15 PM.", "Announcement (Oct 2): Because of the room conflict, the midterm has moved to Thursday, October 16, in B10 Ingraham Hall. The time is unchanged."] },
  { id: "u2", family: "update", question: "When is Homework 4 due?", passages: ["Schedule: Homework 4 is due Friday, October 3 at 11:59 PM on Canvas.", "Announcement: I've extended Homework 4 by two days because Canvas was down; it is now due Sunday, October 5 at 11:59 PM."] },
  { id: "u3", family: "update", question: "Where are Professor Lin's office hours this week?", passages: ["Syllabus: Office hours: Professor Lin, Tuesdays 2 to 3 PM in 5376 Computer Sciences.", "Announcement: This week only, Professor Lin's office hours are on Wednesday from 3 to 4 PM in 1325 Computer Sciences."] },
  { id: "u4", family: "update", question: "How much is the final project worth?", passages: ["Syllabus: Grading: homework 30%, midterm 25%, final project 45%.", "Announcement (Sep 20): After the class vote, the final project is now worth 40% and participation is worth 5%."] },
  // Neighbouring numbers and names.
  { id: "n1", family: "neighbour", question: "What percentage of the grade is the midterm?", passages: ["Grading: Weekly quizzes 15%. Problem sets 20%. Midterm 1 25%. Midterm 2 25%. Final exam 15%."] },
  { id: "n2", family: "neighbour", question: "How many late days do I get, and what happens after that?", passages: ["Late policy: You have 4 free late days for the semester, at most 2 on any one assignment. After that, each late day costs 10% of the assignment's points."] },
  { id: "n3", family: "neighbour", question: "Who runs the Thursday discussion section and where?", passages: ["Discussion sections: 301 meets Tuesday 9:55 AM in 1257 Sterling Hall with Maya Chen. 302 meets Thursday 9:55 AM in 1261 Sterling Hall with Omar Haddad. 303 meets Thursday 1:20 PM in 2241 Chamberlin with Priya Nair."] },
  { id: "n4", family: "neighbour", question: "When is the quiz on chapter 6?", passages: ["Quiz schedule: Chapter 5 quiz on September 26. Chapter 6 quiz on October 3. Chapter 7 quiz on October 10. Each quiz opens at 8 AM and closes at 11:59 PM."] },
  // Answers that need a derivation.
  { id: "d1", family: "derived", question: "How many points is the whole homework category worth?", passages: ["Homework: There are 8 homework assignments, each worth 25 points. The lowest homework score is dropped."] },
  { id: "d2", family: "derived", question: "How many days do I have between the project proposal and the final report?", passages: ["Project: The proposal is due October 6. The final report is due December 8."] },
  { id: "d3", family: "derived", question: "If I use all my late days on one assignment, how late can I turn it in?", passages: ["Late policy: You have 3 late days in total. Each late day extends a deadline by 24 hours. Late days can't be used on the final exam."] },
  { id: "d4", family: "derived", question: "How many lectures are left after October 15 if lectures run Monday, Wednesday and Friday until December 10?", passages: ["Schedule: Lectures meet Monday, Wednesday and Friday. The last lecture is December 10. There is no class November 26 or November 28 (Thanksgiving)."] },
  // Weekdays, relative dates and times.
  { id: "w1", family: "weekday", question: "What day of the week is the exam review session?", passages: ["Exam review: The review session is on December 11 at 6 PM in 1100 Grainger Hall, led by the TAs."] },
  { id: "w2", family: "weekday", question: "When is the reading response due?", passages: ["Reading responses are due the night before each Tuesday lecture, by 10 PM, starting in week 3."] },
  { id: "w3", family: "weekday", question: "When does the lab report for Lab 3 have to be submitted?", passages: ["Labs: Each lab report is due one week after your lab session, at the start of your next session. Lab 3 runs the week of October 13."] },
  { id: "w4", family: "weekday", question: "What time does the final exam start and end?", passages: ["Final exam: Sunday, December 14, 12:25 PM to 2:25 PM. Location to be announced on Canvas."] },
  // Mixed: two courses' facts in one set of passages.
  { id: "m1", family: "mixed", question: "When is the MATH 222 midterm?", passages: ["MATH 222: Midterm 1 is Wednesday, October 8, 5:45 to 7:15 PM.", "CS 400: Midterm 1 is Tuesday, October 7, 7:30 to 9:30 PM."] },
  { id: "m2", family: "mixed", question: "Which room is the Chemistry 103 lecture in?", passages: ["CHEM 103 lecture: Monday, Wednesday, Friday 11 AM in 1351 Chemistry.", "CHEM 104 lecture: Tuesday, Thursday 11 AM in 1315 Chemistry."] },
  { id: "m3", family: "mixed", question: "Who grades my essays, and how fast?", passages: ["Grading: Essays are graded by your section TA, Jordan Park, within 10 days.", "Grading: Exams are graded by Professor Alvarez within 7 days."] },
  { id: "m4", family: "mixed", question: "What is the attendance policy for lecture and for lab?", passages: ["Lecture attendance is not recorded, but iClicker questions count for 5% of the grade.", "Lab attendance is required. More than 2 unexcused lab absences lowers your final grade by one letter."] },
];

const here = dirname(fileURLToPath(import.meta.url));
const repeats = Number(process.argv[2] ?? 3);
const concurrency = Number(process.argv[3] ?? 4);

const userData = await mkdtemp(join(tmpdir(), "magic-break-live-"));
const built = await clientBackend("claude", { userData }, { claude: createClaudeBackend, codex: createCodexBackend }, async () => null);
if (!built) throw new Error("Claude Code is not available in instant mode on this machine.");
const runner = createModelRunner({ backend: built.backend });

const frame: CourseFrame = {
  courseId: "synthetic",
  course: "Synthetic course",
  skeleton: "Course: SYN 101: Synthetic course",
  policy: "Course AI policy: explanations and study help are allowed. Task mode: explain.",
  brief: coursePackCatalogue(),
};

type Sentence = { text: string; quotes: string; checked: boolean; claimsInAnyPassage: boolean };
type Row = { id: string; family: string; repeat: number; found?: boolean; sentences?: Sentence[]; shownAfter?: string; replacedAfter?: number; model?: string; usage?: unknown; latencyMs?: number; error?: string };
const only = process.env.ONLY?.split(","); const jobs = CASES.filter((c) => !only || only.includes(c.id)).flatMap((c) => Array.from({ length: repeats }, (_, r) => ({ c, r })));
const rows: Row[] = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const { c, r } = jobs[next++]!;
    const passages = c.passages.map((text, i) => ({ sourceId: `p${i + 1}`, text }));
    const prompt = buildPrompt(askPack, frame, { question: c.question }, passages);
    try {
      const res = await runner.run({ pack: { id: askPack.id, version: askPack.version }, systemPrompt: prompt.systemPrompt, input: prompt.input, schema: askPack.schema, tier: askPack.tier, budget: askPack.budget });
      const all = c.passages.join("\n");
      const sentences: Sentence[] = res.output.sentences.map((s) => {
        const quotes = s.citations.map((q) => q.quote).join(" ");
        return { text: s.text, quotes, checked: claimsMatch(s.text, quotes), claimsInAnyPassage: claimsMatch(s.text, all) };
      });
      const meta = new Map(passages.map((p) => [p.sourceId, { resourceId: p.sourceId, title: "Synthetic", url: "https://canvas.example.edu/synthetic" }]));
      const after = checkAnswer(res.output, passages, meta as never, (id) => passages.find((p) => p.sourceId === id)?.text ?? null);
      rows.push({ id: c.id, family: c.family, repeat: r, found: res.output.found, sentences, shownAfter: after.text, replacedAfter: sentences.filter((s) => !s.checked).length, model: res.model, usage: res.usage, latencyMs: res.latencyMs });
      process.stdout.write(`${c.id}#${r} ${sentences.filter((s) => !s.checked).length}/${sentences.length} mismatched\n`);
    } catch (error) {
      rows.push({ id: c.id, family: c.family, repeat: r, error: String((error as Error).message ?? error) });
      process.stdout.write(`${c.id}#${r} error ${(error as Error).message}\n`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
rows.sort((a, b) => a.id.localeCompare(b.id) || a.repeat - b.repeat);
await writeFile(join(here, "results.json"), `${JSON.stringify({ date: new Date().toISOString(), client: "claude (instant mode)", repeats, rows }, null, 2)}\n`);
const ok = rows.filter((r) => r.sentences);
const sentences = ok.flatMap((r) => r.sentences!);
const bad = sentences.filter((s) => !s.checked);
console.log(`answers ${ok.length}/${rows.length} (errors ${rows.length - ok.length}); sentences ${sentences.length}; mismatched ${bad.length}; answers with a mismatch ${ok.filter((r) => r.sentences!.some((s) => !s.checked)).length}; mismatched but true of another passage ${bad.filter((s) => s.claimsInAnyPassage).length}`);
