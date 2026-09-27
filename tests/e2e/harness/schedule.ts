/**
 * A synthetic class schedule for the notes flows: one course and timed lecture and discussion
 * events dated from today (America/Chicago), so the rolling window always holds them. Imported
 * through the `import` command as its own source; nothing here is real coursework.
 */
export const NOTES_COURSE = { courseId: "notes-201", courseName: "Notes 201 · Synthetic", accountScope: "synthetic" } as const;

export interface ScheduledSession {
  key: string;
  title: string;
  /** Days from today. */
  day: number;
}
export const DEFAULT_SESSIONS: ScheduledSession[] = [
  { key: "lec-1", title: "Lecture 1: Claims", day: 1 },
  { key: "lec-2", title: "Lecture 2: Evidence", day: 2 },
  { key: "dis-1", title: "Discussion: Warrants", day: 3 },
];

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
function at(dayOffset: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}
const base = (externalId: string, kind: string, title: string) => ({
  courseId: NOTES_COURSE.courseId,
  courseName: NOTES_COURSE.courseName,
  text: "",
  deadlines: [] as unknown[],
  points: null,
  submitted: null,
  policy: { mode: "coaching", evidence: "Synthetic course: AI may explain concepts." },
  externalId,
  kind,
  title,
  url: `https://example.org/notes-201/${externalId}`,
});

/** 15:00Z is 10:00 in Chicago during daylight time and 09:00 in standard time: always a daytime class. */
export function scheduleBatch(sessions: ScheduledSession[] = DEFAULT_SESSIONS) {
  return {
    source: { id: "e2e-notes-schedule", label: "Synthetic schedule", kind: "fixture", accountScope: NOTES_COURSE.accountScope, courseId: NOTES_COURSE.courseId, scope: "calendar" },
    observedAt: iso(new Date()),
    complete: true,
    status: "ok",
    resources: [
      { ...base("course", "course", NOTES_COURSE.courseName) },
      ...sessions.map((s) => {
        const start = at(s.day, 15);
        const end = new Date(start.getTime() + 75 * 60_000);
        return {
          ...base(s.key, "event", `${NOTES_COURSE.courseName.split(" · ")[0]} · ${s.title}`),
          deadlines: [{ value: iso(start), kind: "event", quote: `DTSTART: ${iso(start)}`, authority: "structured", scopeConfirmed: true }],
          calendar: { uid: `${s.key}@example.org`, start: iso(start), end: iso(end), allDay: false, timezone: "America/Chicago" },
        };
      }),
    ],
  };
}
