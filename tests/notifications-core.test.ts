/**
 * Notifications through the real store → core path: the first capture is a baseline, a later
 * announcement is triaged by a counting fake Jev only when privacy allows it, the request is the
 * allowlisted state, the judgment raises (never lowers) the feed item, and read/dismiss persist.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureBatchSchema,
  defaultPrivacy,
  MESSAGE_TRIAGE_QUESTION_VERSION,
  type CaptureBatch,
  type MessageTriageResult,
  type MessageTriageState,
  type PrivacyPreferences,
} from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import fixture from "../fixtures/course.json";

const NOW = new Date("2026-09-27T02:00:00Z");
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
  value: {
    action: "grant" as const,
    recipient,
    disclosureVersion: CONSENT_DISCLOSURE_VERSION,
  },
});
const source = {
  id: "canvas:course:220",
  label: "Canvas",
  kind: "canvas" as const,
  accountScope: "synthetic-account",
  courseId: "220",
  scope: "course",
};
const base = {
  courseId: "220",
  courseName: "CS 220",
  policy: { mode: "unknown" as const, evidence: "" },
};
const assignment = {
  ...base,
  externalId: "a-1",
  kind: "assignment" as const,
  title: "Interface exercise",
  url: "https://canvas.example.edu/courses/220/assignments/1",
  text: "Build the interface.",
  // Due in about 30 hours.
  deadlines: [
    {
      value: "2026-09-28T08:00:00Z",
      kind: "due" as const,
      quote: "due_at: 2026-09-28T08:00:00Z",
      authority: "structured" as const,
      scopeConfirmed: true,
    },
  ],
  points: 10,
  submitted: false,
};
const announcement = {
  ...base,
  externalId: "m-1",
  kind: "message" as const,
  title: "About the interface exercise",
  url: "https://canvas.example.edu/courses/220/discussion_topics/9",
  // Deliberately avoids the keyword rule so any raise comes from the judgment.
  text: "Please read section 4 again before you hand anything in; the checklist now includes accessibility.",
};
function capture(resources: unknown[], observedAt: string, readId: string): CaptureBatch {
  return captureBatchSchema.parse({
    source,
    observedAt,
    complete: true,
    status: "ok",
    readId,
    resources,
  });
}

function workspace(privacy?: PrivacyPreferences) {
  const directory = mkdtempSync(join(tmpdir(), "magic-notify-"));
  const store = createStore(join(directory, "workspace.sqlite"));
  const calls: MessageTriageState[] = [];
  const answer: MessageTriageResult = {
    kind: "deadline_or_schedule_change",
    kindProbabilities: {
      deadline_or_schedule_change: 0.9,
      exam_logistics: 0.02,
      action_required: 0.03,
      grade_or_feedback_released: 0.01,
      new_material_posted: 0.01,
      general_information: 0.02,
      other: 0.01,
    },
    actionRequired: 0.4,
    affects: { a0: 0.93 },
    model: "jev-1.13.0",
    questionVersion: MESSAGE_TRIAGE_QUESTION_VERSION,
  };
  const core = createCore(store, {
    fixture: sample,
    now: () => NOW,
    timeZone: "America/Chicago",
    gateway: {
      async evaluate() {
        throw new Error("Not used in this test");
      },
      async triage(state) {
        calls.push(state);
        return answer;
      },
    },
  });
  if (privacy) store.setPrivacy(privacy);
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

async function ingestBoth(w: ReturnType<typeof workspace>) {
  // First read: the baseline. Second read: a new announcement.
  w.store.ingest(capture([assignment], "2026-09-26T20:00:00Z", "read-1"));
  w.core.saved(source.id);
  await w.core.settled();
  w.store.ingest(
    capture([assignment, announcement], "2026-09-27T01:00:00Z", "read-2"),
  );
  w.core.saved(source.id);
  w.core.wake();
  await w.core.settled();
}

test("the first capture is a baseline: connecting creates no notifications", async () => {
  const w = workspace();
  try {
    w.store.ingest(capture([assignment, announcement], "2026-09-26T20:00:00Z", "read-1"));
    const feed = w.core.snapshot().notifications!;
    assert.equal(
      feed.items.filter((n) => n.resourceId).length,
      0,
      JSON.stringify(feed.items),
    );
    assert.equal(feed.unread, 0);
  } finally {
    await w.close();
  }
});

test("with Jev off, a new announcement is listed by code rules and nothing is sent", async () => {
  const w = workspace();
  try {
    await ingestBoth(w);
    assert.equal(w.calls.length, 0);
    const feed = w.core.snapshot().notifications!;
    assert.equal(feed.triage.status, "off");
    const item = feed.items.find((n) => n.resourceId?.endsWith("m-1") || n.title.includes("interface exercise"));
    assert.ok(item, JSON.stringify(feed.items));
    assert.equal(item.level, "info");
    assert.equal(item.raisedBy, undefined);
  } finally {
    await w.close();
  }
});

test("with consent, Jev receives only the allowlisted state and can raise the announcement", async () => {
  const w = workspace(everything);
  try {
    await w.core.execute(grant("uw"));
    await w.core.execute(grant("jev"));
    await ingestBoth(w);
    assert.equal(w.calls.length, 1, "one request for the one new message");
    const state = w.calls[0]!;
    assert.deepEqual(Object.keys(state).sort(), ["course", "text", "title", "upcoming"]);
    assert.equal(state.title, announcement.title);
    assert.deepEqual(
      state.upcoming.map((u) => [u.key, u.title]),
      [["a0", "Interface exercise"]],
    );
    assert.ok(!JSON.stringify(state).includes("canvas.example.edu"), "no URLs leave");
    const receipts = w.store
      .receipts()
      .filter((r) => r.purpose === "Sort announcement importance");
    assert.deepEqual(receipts.map((r) => r.status), ["sent"]);
    assert.deepEqual([...receipts[0]!.categories].sort(), ["communications", "course_text"]);

    const feed = w.core.snapshot().notifications!;
    assert.equal(feed.triage.status, "on");
    const item = feed.items.find((n) => n.raisedBy);
    assert.ok(item, JSON.stringify(feed.items));
    // Affects a task due within 72 hours → urgent; the code level (info) is kept as `from`.
    assert.equal(item.level, "urgent");
    assert.equal(item.raisedBy!.from, "info");
    assert.deepEqual(item.raisedBy!.affects, ["Interface exercise"]);

    // A second wake reuses the cached judgment instead of sending again.
    w.core.wake();
    await w.core.settled();
    assert.equal(w.calls.length, 1);

    // Turning Jev off removes its influence at once; code rules still list the announcement.
    w.store.setPrivacy({ ...everything, jevEnabled: false });
    const off = w.core.snapshot().notifications!;
    assert.equal(off.triage.status, "off");
    assert.ok(!off.items.some((n) => n.raisedBy), JSON.stringify(off.items));
  } finally {
    await w.close();
  }
});

test("read and dismiss persist, and dismissed items leave the feed", async () => {
  const w = workspace();
  try {
    await ingestBoth(w);
    const before = w.core.snapshot().notifications!;
    const target = before.items[0]!;
    await w.core.execute({ type: "notifications-read", ids: [target.id] });
    assert.equal(
      w.core.snapshot().notifications!.items.find((n) => n.id === target.id)?.read,
      true,
    );
    await w.core.execute({ type: "notification-dismiss", id: target.id });
    assert.ok(
      !w.core.snapshot().notifications!.items.some((n) => n.id === target.id),
    );
    assert.deepEqual(w.store.notificationState!().dismissedIds, [target.id]);
  } finally {
    await w.close();
  }
});

test("a failed triage stops that wake instead of sending the next message into a spent budget", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-notify-fail-"));
  const store = createStore(join(directory, "workspace.sqlite"));
  let calls = 0;
  const core = createCore(store, {
    fixture: sample,
    now: () => NOW,
    timeZone: "America/Chicago",
    gateway: {
      async evaluate() {
        throw new Error("Not used in this test");
      },
      async triage() {
        calls++;
        throw new Error("The judgment gateway could not complete this request.");
      },
    },
  });
  try {
    store.setPrivacy(everything);
    await core.execute(grant("uw"));
    await core.execute(grant("jev"));
    store.ingest(capture([assignment], "2026-09-26T20:00:00Z", "read-1"));
    store.ingest(
      capture(
        [assignment, announcement, { ...announcement, externalId: "m-2", title: "Second note" }],
        "2026-09-27T01:00:00Z",
        "read-2",
      ),
    );
    core.wake();
    await core.settled();
    assert.equal(calls, 1);
    const receipts = store
      .receipts()
      .filter((r) => r.purpose === "Sort announcement importance")
      .map((r) => r.status)
      .sort();
    assert.deepEqual(receipts, ["failed", "sent"]);
    // Both announcements are still listed by code rules; nothing is hidden by a failure.
    const feed = core.snapshot().notifications!;
    assert.equal(feed.items.filter((n) => n.reason === "announcement").length, 2);
  } finally {
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an old announcement recorded as new by a later read is not sent to Jev", async () => {
  const w = workspace(everything);
  try {
    await w.core.execute(grant("uw"));
    await w.core.execute(grant("jev"));
    w.store.ingest(capture([assignment], "2026-09-26T20:00:00Z", "read-1"));
    w.store.ingest(
      capture(
        [assignment, { ...announcement, createdAt: "2026-08-01T12:00:00Z" }],
        "2026-09-27T01:00:00Z",
        "read-2",
      ),
    );
    w.core.wake();
    await w.core.settled();
    assert.equal(w.calls.length, 0);
  } finally {
    await w.close();
  }
});
