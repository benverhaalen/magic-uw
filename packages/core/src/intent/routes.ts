/**
 * The routing table: who answers each command-bar action and each ask kind, decided once from what
 * we measured, not guessed per request. One source of truth: the router reads it (a `code` route
 * never acquires the student's client; a `model` route goes to the course's warm interactive
 * session), and `tests/intent-routes.test.ts` fails when an action or ask kind has no row or a row
 * names no evidence.
 *
 * - `code`: exact facts (dates, IDs, grades, search, navigation). 0 tokens, never the pool.
 * - `jev`: typed judgments only (message triage, assignment kind), batched in the background.
 * - `model`: the student's own AI where language must be read or written (explain, exam questions,
 *   generation). `pass` is the quick tier (Sonnet 5 / GPT-6 Sol / Gemini 3.5 Flash), `strong` the
 *   escalation. `interactive` runs on the warm per-course session; `background` on the pack pool.
 *
 * "Semester model row N" is the per-action table in `docs/semester-model.md` on
 * `bench/semester-model` (lines 36–47): each row's path and calls per use were measured end to end
 * through the worker's code path with the fake CLI.
 */
export type RouteKind = "code" | "jev" | "model";
export type RouteTier = "pass" | "strong";
export type RouteLane = "interactive" | "background";

export type Route =
  | { route: "code"; evidence: string }
  | { route: "jev" | "model"; tier: RouteTier; lane: RouteLane; evidence: string };

/** Every registered command action (built-ins, adapters and the notes lane's actions). */
export const ACTION_ROUTES = {
  // Navigation and lookups: exact facts from the store.
  "page.open": { route: "code", evidence: "intent/page-action.ts: a fixed page map; no model in run()" },
  "course.open": { route: "code", evidence: "intent/actions.ts openCourse: navigates to a code-resolved course" },
  "assignment.open": { route: "code", evidence: "intent/actions.ts openAssignment: host.workspace verb open on a code-resolved ID" },
  "agenda.due": { route: "code", evidence: "semester model row 1 (what's due: code, 0 calls, 0 tokens); intent/actions.ts agenda" },
  "changes.since": { route: "code", evidence: "semester model row 2 (what changed: code, 0 calls); intent/adapters/changes.ts" },
  "materials.search": { route: "code", evidence: "semester model row 6 (find the slides: code, 0 calls); store.searchPassages" },
  "grades.whatif": { route: "code", evidence: "semester model row 8 (the model answered it wrong; code computes it since 8c89817); intent/adapters/grades.ts" },
  "grades.gpa": { route: "code", evidence: "8c89817 wires the GPA what-if to the calculator; intent/adapters/grades.ts" },
  "calendar.proposeEvent": { route: "code", evidence: "intent/adapters/outlook.ts: code parses date and time; the student confirms before a write" },
  "mail.search": { route: "code", evidence: "intent/adapters/outlook.ts: host.query mail search, a read" },
  "guide.view": { route: "code", evidence: "intent/adapters/guides.ts: host.query view guide reads a stored guide" },
  "analytics.course": { route: "code", evidence: "intent/adapters/analytics.ts: practice analytics computed from stored attempts" },
  "analytics.assignment": { route: "code", evidence: "intent/adapters/analytics.ts" },
  "analytics.agendaHints": { route: "code", evidence: "intent/adapters/analytics.ts" },
  "assignment.references": { route: "code", evidence: "intent/adapters/pipeline.ts: the material pipeline's stored links" },
  "course.overview": { route: "code", evidence: "intent/adapters/pipeline.ts: the pipeline's stored course view" },
  // Practice serves checked questions already generated (semester model rows 4 and 5: "then code").
  "practice.quiz": { route: "code", evidence: "semester model row 4 (quiz: model once per topic at generation, then code)" },
  "practice.flashcards": { route: "code", evidence: "semester model row 5 (cards: model once per topic at generation, then code)" },
  "practice.learn": { route: "code", evidence: "semester model rows 4-5: a Learn round serves stored checked items" },
  // Notes: store operations; `fillFrom` writes through the notes service's own generation runner.
  "notes.open": { route: "code", evidence: "packages/notes/src/actions.ts notes.open: a store op" },
  "notes.append": { route: "code", evidence: "packages/notes/src/actions.ts notes.append: appends the student's text" },
  "notes.new": { route: "code", evidence: "packages/notes/src/actions.ts notes.new: notes.create" },
  "notes.setTemplate": { route: "code", evidence: "packages/notes/src/actions.ts notes.setTemplate" },
  "notes.fillFrom": { route: "model", tier: "pass", lane: "background", evidence: "packages/notes/src/actions.ts notes.fill: generation through the notes runner (worker.ts, 'fill from slides')" },
  // The student's AI.
  "pack.generate": { route: "model", tier: "pass", lane: "background", evidence: "semester model rows 4-5 (1,316 / 1,092 prompt tokens per generation); pack-handler.ts background pool" },
  ask: { route: "model", tier: "pass", lane: "interactive", evidence: "semester model rows 3 and 7 (explain: 1,607 warm; exam: 1,161 warm), one call each" },
} as const satisfies Record<string, Route>;

/** What a grounded ask is about; code picks the kind (ask.ts `refersBack`, `assessmentFacts`). */
export type AskKind = "explain" | "exam" | "followUp" | "allCourses" | "notInMaterials";
export const ASK_ROUTES = {
  explain: { route: "model", tier: "pass", lane: "interactive", evidence: "semester model row 3: model, 1 call, 1,607 prompt tokens warm" },
  exam: { route: "model", tier: "pass", lane: "interactive", evidence: "semester model row 7: model, 1 call, 1,161 warm; code supplies the facts (ask.ts assessmentFacts)" },
  followUp: { route: "model", tier: "pass", lane: "interactive", evidence: "intent-pool-cost: a back-reference carries only the last exchange (ask.ts refersBack)" },
  allCourses: { route: "model", tier: "pass", lane: "interactive", evidence: "ask.ts groundedAsk: scope all has no course prefix, the catalogue alone" },
  notInMaterials: { route: "code", evidence: "ask.ts coverage gate: no passage or fact, no call (semester model row 9)" },
} as const satisfies Record<AskKind, Route>;

/** Decisions outside the command bar, listed so the table covers every place the app picks. */
export const BACKGROUND_ROUTES = {
  classifyUnplaced: { route: "model", tier: "pass", lane: "interactive", evidence: "intent/router.ts classify: only an utterance code can't place (semester model row 10: 1,936 warm)" },
  messageTriage: { route: "jev", tier: "pass", lane: "background", evidence: "notifications.ts: Jev triages new announcements and email; code rules decide the rest" },
  assignmentKind: { route: "jev", tier: "pass", lane: "background", evidence: "jobs/enrich.ts assignment.kind.v1; code answers unambiguous kinds first (queries.ts codeAssignmentKind)" },
  siteTriage: { route: "code", evidence: "site-triage.ts: known rules link or read by code; Jev only where a rule allows" },
  generation: { route: "model", tier: "pass", lane: "background", evidence: "pack-handler.ts: packs run on the background pool, turns kept per batch" },
} as const satisfies Record<string, Route>;

export type ActionName = keyof typeof ACTION_ROUTES;

/** The route for an action, or null for an unlisted one (the completeness test keeps this empty). */
export function routeOf(action: string): Route | null {
  return (ACTION_ROUTES as Record<string, Route>)[action] ?? null;
}
