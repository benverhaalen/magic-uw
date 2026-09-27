/**
 * The baseline's task text. One prompt for every client and model; nothing in it describes how our
 * system works. It gives what a competent person would be told: the exact schema, the scope, the
 * definitions the scorer uses, the tools that exist, and that the REST API may be used through the
 * signed-in browser page.
 */
import { TARGET_SQL } from "./schema";

export interface PromptContext {
  origin: string;
  /** The day "current term" is judged on, as the scorer judges it. */
  today: string;
  dbFile: string;
  tools: string;
}

export function ingestionPrompt(ctx: PromptContext): string {
  return `Populate a SQLite database with a student's Canvas coursework, completely and accurately. This is read-only work.

Canvas: ${ctx.origin}
A browser that is already signed in to this Canvas account is available through your browser tools. Do not sign out, submit, post, reply, take or preview quizzes, or launch external tools; the network blocks writes, and any attempt is logged. You may read the Canvas web pages, and you may also use the Canvas REST API (${ctx.origin}/api/v1/...) from inside the signed-in page, for example by running fetch() in the page; it returns JSON and paginates with Link headers (per_page=100 is allowed). The page shows times in America/Chicago; the API gives UTC.

Database: ./${ctx.dbFile} in your working folder. It already exists with the schema below; do not change the schema.
${ctx.tools}

What to put in it:
- courses: every course Canvas lists for this student, current and past. is_current = 1 only for courses in the academic term in session today (${ctx.today}), judged by the term's start and end dates (or by the term's name when it has no dates); 0 for past or future terms, courses whose access is restricted by date, and sites that are not term courses (orientation, sandboxes, organizations).
- For current courses only:
  - modules and module_items: every module and every item in it.
  - assignment_groups: every group; weight is the percent of the final grade when the course weights its groups, otherwise NULL.
  - assignments: every assignment, including graded quizzes and graded discussions, with due_at in UTC ISO 8601 (for example 2026-10-03T04:59:00Z, NULL when there is no due date) and points_possible exactly as Canvas has them.
  - pages: every page the student can open, with its body as plain text.
  - files: every file the student can reach, including files reachable only through modules or links when the Files tab is hidden, with the document's text extracted (PDF, DOCX, PPTX and text files).
  - syllabus: the course's syllabus as plain text: from the Syllabus tab when it holds the syllabus itself; otherwise from the syllabus page or the syllabus file it points to (source = 'syllabus_body', 'page' or 'file').
- Use Canvas ids exactly as Canvas gives them (stored as text).

Schema:
${TARGET_SQL}

When the database is complete and correct, reply with one line giving the row count of each table.`;
}

/** The retry: the same task, continued once when an attempt stopped before the database was complete. */
export function continuePrompt(ctx: PromptContext): string {
  return `${ingestionPrompt(ctx)}

Note: a previous attempt at this task stopped before it finished. The database already holds its rows. Check what is missing or wrong and continue until the database is complete and correct.`;
}

/** The repeat sync: the database exists; bring it up to date with Canvas as it is now. */
export function repeatPrompt(ctx: PromptContext): string {
  return `${ingestionPrompt(ctx)}

Note: the database already holds a complete copy made earlier. Canvas may have changed since then. Bring the database up to date with Canvas as it is now (add, change and remove rows as needed).`;
}

export type TaskCondition = "browser" | "ours";

export function taskPrompt(ctx: { origin: string; condition: TaskCondition; question: string; today: string }): string {
  const access =
    ctx.condition === "browser"
      ? `Canvas: ${ctx.origin}. A browser that is already signed in to the student's Canvas account is available through your browser tools. You may read the Canvas pages and use the Canvas REST API (${ctx.origin}/api/v1/...) from inside the signed-in page (for example with fetch()). Read only: do not submit, post, take quizzes or launch external tools.`
      : `The student's Canvas coursework is available through the "magic" tools: a local, read-only copy of their courses (assignments with due dates, modules, pages, files with extracted text, syllabus). Read only.`;
  return `Answer a question about a university student's current Canvas courses. Today is ${ctx.today}. Times are America/Chicago unless given in UTC.

${access}

Question: ${ctx.question}

Reply with only a JSON object that matches the required schema. Use Canvas ids where the schema asks for ids.`;
}
