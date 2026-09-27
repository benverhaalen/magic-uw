// Break card measurements, parameterized by implementation so the same synthetic cases can be run
// against the code before and after each fix. Fake model output only; no network, no live model.
import type { MailTriageJudgment, MailKind, ResourceChange, ResourceView, SourceHealth } from "@magic/contracts";
import type { buildNotifications as BuildNotifications } from "../packages/domain/src/notifications";
import { resolveDeadline } from "../packages/domain/src/index";
import type { checkAnswer as CheckAnswer } from "../packages/core/src/intent/ask";
import type { decideByCode as DecideByCode, HostSignals } from "../packages/core/src/site-triage";
import type { SiteStore } from "../packages/core/src/site-recipes";
import { categorizeMail, type MailContext } from "../packages/connectors/src/graph";
import { askCases, linkCases, mailCases, STAFF } from "./break-cases";

export const N = 60;
export interface Rate {
  k: number;
  n: number;
}

// ---------------------------------------------------------------- B1
export function measureB1(check: typeof CheckAnswer): { wrongShown: Rate; rightRejected: Rate } {
  const meta = new Map([["p1", { resourceId: "r1", title: "Syllabus", url: "https://canvas.example.edu/courses/1/assignments/syllabus" }]]);
  const run = (passage: string, quote: string, sentence: string) =>
    check({ found: true, sentences: [{ text: sentence, citations: [{ sourceId: "p1", quote }] }] }, [{ sourceId: "p1", text: passage }], meta, () => passage).text.includes(sentence);
  const cases = askCases(N);
  return {
    wrongShown: { k: cases.filter((c) => run(c.passage, c.quote, c.wrong)).length, n: N },
    rightRejected: { k: cases.filter((c) => !run(c.passage, c.quote, c.right)).length, n: N },
  };
}

// ---------------------------------------------------------------- B2 and B3
const NOW = "2026-10-05T15:00:00.000Z";
const at = (hours: number) => new Date(Date.parse(NOW) + hours * 3600000).toISOString();
export const mailContext: MailContext = {
  courses: [{ courseId: "564", accountScope: "uw", courseName: "Database Systems", courseCode: "COMP SCI 564", staffEmails: [...STAFF] }],
};
function view(id: string, over: Partial<ResourceView>): ResourceView {
  const base = {
    id, externalId: `x-${id}`, kind: "assignment" as const, courseId: "564", courseName: "Database Systems", title: `Item ${id}`,
    url: `https://canvas.example.edu/courses/564/items/${id}`, text: "", deadlines: [], points: null, submitted: null,
    policy: { mode: "unknown" as const, evidence: "" }, sourceId: "src-564", contentHash: "h", version: 1,
    observedAt: at(-1), capturedAt: at(-1), deleted: false, completed: false, kindLabel: null, ...over,
  };
  return { ...base, deadline: resolveDeadline(base.deadlines) } as ResourceView;
}
const project = view("a1", { title: "Project 2", dueAt: at(30), deadlines: [{ value: at(30), kind: "due", quote: "Project 2 is due", authority: "structured", scopeConfirmed: true }] });
function mailView(id: string, m: { fromAddress: string; fromName: string; subject: string; preview: string }): ResourceView {
  const match = categorizeMail({ fromAddress: m.fromAddress, fromName: m.fromName, subject: m.subject, preview: m.preview }, mailContext);
  return view(id, {
    kind: "message", courseId: "outlook-mail", courseName: "Outlook mail", sourceId: "src-mail", title: m.subject, text: m.preview, createdAt: at(-3),
    mail: {
      messageId: `msg-${id}`, folder: "inbox", fromName: m.fromName, fromAddress: m.fromAddress, receivedAt: at(-3), preview: m.preview, isRead: false,
      category: match.category, categoryReason: match.reason, ...(match.courseId ? { courseId: match.courseId } : {}),
    },
  } as Partial<ResourceView>);
}
const source = (id: string, courseId: string): SourceHealth => ({
  id, label: id, kind: "canvas", accountScope: "uw", courseId, scope: "course", status: "ok", lastAttemptAt: at(-1), lastSuccessAt: at(-1), complete: true, resourceCount: 1,
});
function feed(build: typeof BuildNotifications, mails: ResourceView[], mailTriage: Record<string, MailTriageJudgment> = {}) {
  const changes: ResourceChange[] = mails.map((m, i) => ({
    id: `c${i}`, resourceId: m.id, sourceId: "src-mail", accountScope: "uw", courseId: "outlook-mail", scope: "inbox", readId: "read-2",
    observedAt: at(-2), type: "new", oldValues: {}, newValues: {},
  }));
  return build({
    changes, resources: [...mails, project], sources: [source("src-564", "564"), source("src-mail", "outlook-mail")], baselineReadIds: ["read-1"],
    included: () => true, triage: {}, mailTriage, triageStatus: { status: "on", reason: "Ready." }, state: { readIds: [], dismissedIds: [] }, now: NOW, timeZone: "America/Chicago",
  }).items.filter((n) => n.reason === "email");
}
/** A fake Jev judgment: a strong mail kind that affects Project 2, due in 30 hours. */
export function fakeJev(kind: MailKind = "deadline_or_action_required"): MailTriageJudgment {
  const kinds: MailKind[] = ["interview_or_job", "deadline_or_action_required", "schedule_change_or_cancellation", "advisor_or_academic_standing", "campus_event", "club_or_org_update", "course_related", "newsletter_or_promotion", "other"];
  return {
    result: { kind, kindProbabilities: Object.fromEntries(kinds.map((k) => [k, k === kind ? 0.9 : 0.0125])) as Record<MailKind, number>, actionRequired: 0.9, affects: { a0: 0.9 }, model: "fake-jev", questionVersion: "mail.triage.v1" },
    upcoming: [{ key: "a0", resourceId: "a1", title: "Project 2" }],
  };
}
/** B2: outside senders whose subject names the course; staff mail kept for recall. */
export function measureB2(build: typeof BuildNotifications) {
  const cases = mailCases(2 * N);
  const items = cases.map((c, i) => ({ c, n: feed(build, [mailView(`m${i}`, c)])[0] }));
  const outside = items.filter((x) => !x.c.staff), staff = items.filter((x) => x.c.staff);
  return {
    outsideAsStaff: { k: outside.filter((x) => x.n?.detail?.startsWith("Course staff")).length, n: outside.length },
    outsideUrgent: { k: outside.filter((x) => x.n?.level === "urgent").length, n: outside.length },
    staffUrgent: { k: staff.filter((x) => x.n?.level === "urgent" && x.n.detail?.startsWith("Course staff")).length, n: staff.length },
  };
}
/** B3: unknown senders (no course code, no list, no office) that a fake Jev reads as a deadline due soon. */
export function measureB3(build: typeof BuildNotifications) {
  const subjects = ["Quick question about this week", "Reminder", "Following up", "Heads up for Friday", "Checking in", "Your study plan"];
  const outside = Array.from({ length: N }, (_, i) => ({ fromAddress: `person${i}@mail.example.com`, fromName: `Sender ${i}`, subject: subjects[i % subjects.length]!, preview: "Wanted to share a few notes before the weekend." }));
  const unknownUrgent = outside.filter((m, i) => feed(build, [mailView(`u${i}`, m)], { [`u${i}`]: fakeJev() })[0]?.level === "urgent").length;
  const staffMail = Array.from({ length: N }, (_, i) => ({ fromAddress: STAFF[i % STAFF.length]!, fromName: "Course staff", subject: subjects[i % subjects.length]!, preview: "Wanted to share a few notes before the weekend." }));
  const staffUrgent = staffMail.filter((m, i) => feed(build, [mailView(`s${i}`, m)], { [`s${i}`]: fakeJev() })[0]?.level === "urgent").length;
  return { unknownUrgent: { k: unknownUrgent, n: N }, staffUrgent: { k: staffUrgent, n: N } };
}

// ---------------------------------------------------------------- B4
type HostSignalsFn = (store: SiteStore, course: { accountScope: string; courseId: string }) => HostSignals[];
/** A two-method fake of the store hostSignals reads: Canvas sources and their resources. */
export function linkStore(url: string, surface: "discussion" | "module" | "syllabus"): SiteStore {
  const scope = surface === "discussion" ? "discussions" : surface === "module" ? "module-items:1" : "syllabus";
  const src = { id: `canvas-${scope}`, label: scope, kind: "canvas", accountScope: "uw", courseId: "564", scope, status: "ok", complete: true, resourceCount: 1 };
  const base = { id: "r1", sourceId: src.id, courseId: "564", deleted: false, links: [url] };
  const resource =
    surface === "discussion"
      ? { ...base, kind: "message", externalId: "d1", title: "Study group", url: "https://canvas.example.edu/courses/564/discussion_topics/7" }
      : surface === "module"
        ? { ...base, kind: "material", externalId: "m1", title: "Study notes", url: "https://canvas.example.edu/courses/564/modules/items/9", links: [], moduleItem: { type: "ExternalUrl", title: "Study notes", externalUrl: url } }
        : { ...base, kind: "material", externalId: "syllabus", title: "Syllabus", url: "https://canvas.example.edu/courses/564/assignments/syllabus" };
  return { sources: () => [src], resources: () => [resource] } as unknown as SiteStore;
}
/** B4: hosts naming the course number, linked only from a discussion, versus from course content. */
export function measureB4(signals: HostSignalsFn, decide: typeof DecideByCode) {
  const id = { numbers: ["564"], surnames: ["hopperx"] };
  const cases = linkCases(2 * N);
  const decisionOf = (c: (typeof cases)[number]) => {
    const [s] = signals(linkStore(c.url, c.surface), { accountScope: "uw", courseId: "564" });
    const d = decide(s!, id);
    return "decision" in d ? d.decision : "ambiguous";
  };
  const discussion = cases.filter((c) => c.surface === "discussion"), content = cases.filter((c) => c.surface !== "discussion");
  return {
    discussionSynced: { k: discussion.filter((c) => decisionOf(c) === "sync").length, n: discussion.length },
    contentSynced: { k: content.filter((c) => decisionOf(c) === "sync").length, n: content.length },
  };
}
