import { captureBatchSchema, type Store } from "@magic/contracts";

/**
 * Explicit synthetic preview data for the notifications bell; never used by the desktop or a
 * live refresh. A first read is the baseline (no alerts); a second read changes a due date,
 * adds an assignment, releases a grade and posts an exam announcement. Times are relative to
 * now so the code rules' 48-hour and 3-day windows apply.
 */
export function seedNotificationFixture(store: Store, now = Date.now()) {
  const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
  const source = {
    id: "synthetic-notify",
    label: "Notifications · synthetic",
    kind: "canvas" as const,
    accountScope: "synthetic-notify",
    courseId: "220",
    scope: "course",
  };
  const base = { courseId: "220", courseName: "CS 220 · Synthetic", policy: { mode: "unknown" as const, evidence: "" } };
  const due = (value: string) => [{ value, kind: "due" as const, quote: `due_at: ${value}`, authority: "structured" as const, scopeConfirmed: true }];
  const assignment = (id: string, title: string, dueAt: string, extra: Record<string, unknown> = {}) => ({
    ...base, externalId: id, kind: "assignment" as const, title,
    url: `https://canvas.example.edu/courses/220/assignments/${id}`,
    text: `${title}. Synthetic assignment.`, deadlines: due(dueAt), points: 10, submitted: false, ...extra,
  });
  const exercise = assignment("1", "Interface exercise", at(96));
  const lab = assignment("2", "Testing lab", at(-30), { submitted: true, submission: { workflowState: "submitted", score: null } });
  const capture = (resources: unknown[], observedAt: string, readId: string) =>
    captureBatchSchema.parse({ source, observedAt, complete: true, status: "ok", readId, resources });

  store.ingest(capture([exercise, lab], at(-2), "synthetic-read-1"));
  store.ingest(capture([
    { ...exercise, deadlines: due(at(26)) },
    { ...lab, submission: { workflowState: "graded", score: 9, grade: "9" } },
    assignment("3", "API design memo", at(60)),
    {
      ...base, externalId: "m-1", kind: "message" as const, title: "Midterm room change",
      url: "https://canvas.example.edu/courses/220/discussion_topics/1",
      text: "The midterm on Thursday moves to Room 204. Bring your student ID.",
    },
  ], at(-0.2), "synthetic-read-2"));
}
