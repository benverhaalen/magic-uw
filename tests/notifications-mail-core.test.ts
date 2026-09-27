/**
 * Email notifications through the real store → core path with synthetic Outlook mail:
 * the first mail read is a baseline; later mail is triaged by a counting fake Jev only when it
 * is unread, not a Canvas notification, and in a triaged category; Jev never sees a sender name
 * or address; receipts name the email purpose.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureBatchSchema,
  defaultPrivacy,
  MAIL_TRIAGE_QUESTION_VERSION,
  OUTLOOK_MAIL_COURSE_ID,
  type CaptureBatch,
  type MailTriageResult,
  type MailTriageState,
  type PrivacyPreferences,
} from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import fixture from "../fixtures/course.json";

const NOW = new Date("2026-09-27T15:00:00Z");
const sample = captureBatchSchema.parse(fixture);
const everything: PrivacyPreferences = {
  ...defaultPrivacy,
  mode: "selective_cloud",
  jevEnabled: true,
  hostedProvider: "claude",
  shareCourseText: true,
  shareCommunications: true,
};
const grant = (recipient: "uw" | "jev") => ({
  type: "consent" as const,
  value: { action: "grant" as const, recipient, disclosureVersion: CONSENT_DISCLOSURE_VERSION },
});
const source = {
  id: "mail:outlook:synthetic:inbox",
  label: "Outlook mail",
  kind: "mail" as const,
  accountScope: "synthetic-account",
  courseId: OUTLOOK_MAIL_COURSE_ID,
  scope: "inbox",
};
function email(
  id: string,
  subject: string,
  preview: string,
  category: "course" | "advisor" | "org" | "admin" | "meeting" | "general",
  extra: Record<string, unknown> = {},
  receivedAt = "2026-09-27T14:00:00.000Z",
) {
  const { links, ...mailExtra } = extra as { links?: unknown };
  return {
    externalId: `mail:${id}`,
    kind: "message" as const,
    courseId: OUTLOOK_MAIL_COURSE_ID,
    courseName: "Outlook mail",
    title: subject,
    url: "https://outlook.office.com/mail/",
    text: preview,
    createdAt: receivedAt,
    updatedAt: receivedAt,
    deadlines: [],
    policy: { mode: "unknown" as const, evidence: "" },
    ...(links ? { links } : {}),
    mail: {
      messageId: `msg-${id}`,
      folder: "Inbox",
      fromName: "Pat Example",
      fromAddress: "pat.example@wisc.edu",
      receivedAt,
      preview,
      category,
      categoryReason: `Synthetic ${category}`,
      isRead: false,
      ...mailExtra,
    },
  };
}
function capture(resources: unknown[], observedAt: string, readId: string): CaptureBatch {
  return captureBatchSchema.parse({ source, observedAt, complete: true, status: "ok", readId, resources });
}
const old = email("old", "Welcome to the semester", "Glad to have you.", "admin", {}, "2026-09-26T10:00:00.000Z");
const later = [
  old,
  email("advisor", "Advising appointment", "Please book a time before registration opens.", "advisor"),
  email("canvas", "Assignment graded: Essay", "Your instructor graded Essay.", "course", {
    categoryReason: "Canvas notification links CS 220",
    links: [{ url: "https://canvas.wisc.edu/courses/220/assignments/1", rel: "canvas-item" }],
  }),
  email("read", "Registrar reminder", "Registration opens Monday.", "admin", { isRead: true }),
  email("general", "Next steps", "We'd like to invite you to a second-round conversation with our team.", "general"),
  email("club", "Badger Herald weekly", "This week's issue is out.", "org"),
  email("cancel", "Canceled: Office hours", "This meeting was canceled.", "meeting", { meetingMessageType: "meetingCancelled" }),
];

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "magic-notify-mail-"));
  const store = createStore(join(directory, "workspace.sqlite"));
  const calls: MailTriageState[] = [];
  const answer = (kind: MailTriageResult["kind"]): MailTriageResult => ({
    kind,
    kindProbabilities: {
      interview_or_job: kind === "interview_or_job" ? 0.92 : 0.01,
      deadline_or_action_required: 0.01,
      schedule_change_or_cancellation: 0.01,
      advisor_or_academic_standing: 0.01,
      campus_event: 0.01,
      club_or_org_update: kind === "club_or_org_update" ? 0.92 : 0.01,
      course_related: 0.01,
      newsletter_or_promotion: 0.01,
      other: 0.01,
    },
    actionRequired: 0.2,
    affects: {},
    model: "jev-1.13.0",
    questionVersion: MAIL_TRIAGE_QUESTION_VERSION,
  });
  const core = createCore(store, {
    fixture: sample,
    now: () => NOW,
    timeZone: "America/Chicago",
    gateway: {
      async evaluate() {
        throw new Error("Not used in this test");
      },
      async mailTriage(state) {
        calls.push(state);
        return answer(state.role === "student organization or mailing list" ? "club_or_org_update" : "interview_or_job");
      },
    },
  });
  return {
    store,
    core,
    calls,
    async close() {
      await core.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("only unread, non-Canvas, triaged-category new mail goes to Jev, with no sender identity", async () => {
  const w = workspace();
  try {
    w.store.setPrivacy(everything);
    await w.core.execute(grant("uw"));
    await w.core.execute(grant("jev"));
    w.store.ingest(capture([old], "2026-09-27T09:00:00Z", "mail-read-1"));
    w.store.ingest(capture(later, "2026-09-27T14:30:00Z", "mail-read-2"));
    w.core.wake();
    await w.core.settled();
    // general + club; not advisor (code-important), Canvas notification, read, or meeting.
    assert.deepEqual(w.calls.map((s) => s.subject).sort(), ["Badger Herald weekly", "Next steps"]);
    for (const state of w.calls) {
      assert.deepEqual(Object.keys(state).sort().filter((k) => k !== "course"), ["preview", "role", "subject", "upcoming"]);
      const text = JSON.stringify(state);
      assert.ok(!text.includes("Pat Example") && !text.includes("pat.example"), text);
    }
    const receipts = w.store.receipts().filter((r) => r.purpose === "Sort email importance");
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every((r) => r.status === "sent" && r.categories.includes("communications")));
    // Second wake: judgments are cached.
    w.core.wake();
    await w.core.settled();
    assert.equal(w.calls.length, 2);

    const feed = w.core.snapshot().notifications!;
    const titles = feed.items.map((n) => n.title);
    assert.ok(!titles.includes("Welcome to the semester"), "baseline mail stays quiet");
    assert.ok(!titles.includes("Assignment graded: Essay"), "Canvas notification mail is de-duplicated");
    const general = feed.items.find((n) => n.title === "Next steps");
    assert.ok(general && general.level === "important", JSON.stringify(feed.items));
    const read = feed.items.find((n) => n.title === "Registrar reminder");
    assert.ok(!read || read.level === "info", "read mail never counts toward the badge");
  } finally {
    await w.close();
  }
});

test("with Jev off, mail is listed by code rules and nothing is sent", async () => {
  const w = workspace();
  try {
    w.store.ingest(capture([old], "2026-09-27T09:00:00Z", "mail-read-1"));
    w.store.ingest(capture(later, "2026-09-27T14:30:00Z", "mail-read-2"));
    w.core.wake();
    await w.core.settled();
    assert.equal(w.calls.length, 0);
    const feed = w.core.snapshot().notifications!;
    assert.equal(feed.triage.status, "off");
    const advisor = feed.items.find((n) => n.title === "Advising appointment");
    assert.ok(advisor && advisor.level === "important" && advisor.from === "Pat Example", JSON.stringify(feed.items));
  } finally {
    await w.close();
  }
});
