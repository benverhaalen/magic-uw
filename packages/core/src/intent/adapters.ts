/**
 * The registered actions, in code-path priority order (the first pattern that matches wins).
 * Other lanes' features on main (Outlook #12, study guides #10, practice analytics #11, the
 * material pipeline #13) are wired as actions in `adapters/`, one file per source. The notes
 * lane's plain-object `notesActions` (#16) come in through `adapters/notes.ts` when the worker
 * passes the module and its seam, and go first: their patterns are the most specific.
 */
import { openPage } from "./page-action";
import { agenda, flashcardsDue, generate, learnRound, openAssignment, openCourse, quizMe, search, ask } from "./actions";
import { analyticsAssignment, analyticsCourse, analyticsNext } from "./adapters/analytics";
import { guideView } from "./adapters/guides";
import { calendarPropose, mailSearch } from "./adapters/outlook";
import { assignmentReferences, courseOverview } from "./adapters/pipeline";
import type { AnyAction } from "./registry";

export { fromNotes, type NotesSeam } from "./adapters/notes";

export function defaultActions(first: AnyAction[] = []): AnyAction[] {
  return [
    ...first,
    openPage,
    generate,
    flashcardsDue,
    learnRound,
    quizMe,
    agenda,
    calendarPropose,
    mailSearch,
    guideView,
    analyticsAssignment,
    analyticsCourse,
    analyticsNext,
    assignmentReferences,
    courseOverview,
    openCourse,
    openAssignment,
    search,
    ask,
  ];
}
