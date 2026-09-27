import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commandSchema,
  consentRecordSchema,
  defaultPrivacy,
  mcpGrantSchema,
  privacySchema,
} from "../packages/contracts/src/index";
import {
  cadenceTable,
  createRefreshCoordinator,
} from "../packages/core/src/refresh";

const stored = {
  mode: "selective_cloud",
  jevEnabled: true,
  hostedProvider: "chatgpt",
  shareCourseText: true,
  shareStudentWork: false,
  shareGrades: false,
};

test("stored preferences from before T05d still parse, chatgpt included", () => {
  assert.deepEqual(privacySchema.parse(stored), stored);
  assert.equal(privacySchema.parse(defaultPrivacy).alwaysPreview, false);
  const privacy = commandSchema.parse({ type: "privacy", value: stored });
  assert.equal(privacy.type, "privacy");
});

test("codex and openrouter are accepted as providers and recipients", () => {
  for (const provider of ["codex", "openrouter"] as const) {
    assert.equal(
      privacySchema.parse({ ...stored, hostedProvider: provider }).hostedProvider,
      provider,
    );
    assert.equal(
      commandSchema.parse({
        type: "privacy",
        value: { ...stored, hostedProvider: provider, alwaysPreview: true },
      }).type,
      "privacy",
    );
    assert.equal(
      commandSchema.parse({ type: "context", id: "r1", recipient: provider })
        .type,
      "context",
    );
    assert.equal(
      mcpGrantSchema.parse({
        id: "g1",
        label: "Client",
        recipient: provider,
        enabled: true,
        courses: [],
        categories: [],
      }).recipient,
      provider,
    );
  }
});

test("an unknown stored provider is ignored (reads as none); the privacy command refuses it", () => {
  const parsed = privacySchema.parse({ ...stored, hostedProvider: "future-ai" });
  assert.equal(parsed.hostedProvider, "none");
  assert.equal(
    commandSchema.safeParse({
      type: "privacy",
      value: { ...stored, hostedProvider: "future-ai" },
    }).success,
    false,
  );
});

test("consent and preview contracts parse strictly", () => {
  const record = {
    recipient: "uw",
    disclosureVersion: "2026-09-27.1",
    grantedAt: "2026-09-27T10:00:00-05:00",
  };
  assert.deepEqual(consentRecordSchema.parse(record), record);
  assert.equal(
    consentRecordSchema.safeParse({ ...record, extra: 1 }).success,
    false,
  );
  assert.equal(
    consentRecordSchema.safeParse({ ...record, recipient: "local" }).success,
    false,
  );
  const grant = commandSchema.parse({
    type: "consent",
    value: { action: "grant", recipient: "openrouter", disclosureVersion: "v1" },
  });
  assert.equal(grant.type, "consent");
  assert.equal(
    commandSchema.parse({
      type: "consent",
      value: { action: "revoke", recipient: "jev" },
    }).type,
    "consent",
  );
  // The command never carries the time: code stamps it.
  assert.equal(
    commandSchema.safeParse({
      type: "consent",
      value: {
        action: "grant",
        recipient: "jev",
        disclosureVersion: "v1",
        grantedAt: record.grantedAt,
      },
    }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({
      type: "consent",
      value: { action: "grant", recipient: "jev" },
    }).success,
    false,
  );
  const ack = commandSchema.parse({
    type: "preview.ack",
    value: { id: "p1", payloadHash: "a".repeat(64), decision: "decline" },
  });
  assert.equal(ack.type, "preview.ack");
  assert.equal(
    commandSchema.safeParse({
      type: "preview.ack",
      value: { id: "p1", payloadHash: "short", decision: "send" },
    }).success,
    false,
  );
});

test("the cadence table marks every signed-in read class and only feeds run away", () => {
  assert.equal(cadenceTable.feeds.signedIn, false);
  assert.equal(cadenceTable.canvas.signedIn, true);
  assert.equal(cadenceTable.external.signedIn, true);
});

function harness() {
  let time = new Date(2026, 8, 26, 12);
  const calls = { feeds: 0, probe: 0, full: 0, external: 0 };
  const coordinator = createRefreshCoordinator({
    settings: () => ({
      enabled: true,
      intervalMinutes: 10,
      jitterFraction: 0.2,
      quietStartHour: 1,
      quietEndHour: 6,
    }),
    now: () => time,
    random: () => 0.5,
    hasSources: () => true,
    feeds: async () => {
      calls.feeds++;
      return { changed: false };
    },
    probe: async () => {
      calls.probe++;
      return { needsSignIn: false, signature: "same" };
    },
    full: async () => {
      calls.full++;
      return { needsSignIn: false, signature: "same" };
    },
    external: async () => {
      calls.external++;
    },
    record: () => {},
  });
  return {
    coordinator,
    calls,
    advance(ms: number) {
      time = new Date(time.getTime() + ms);
    },
  };
}

test("present: a tick runs as today", async () => {
  const { coordinator, calls, advance } = harness();
  coordinator.presence(true);
  assert.equal((await coordinator.tick())?.action, "refreshed");
  assert.deepEqual(calls, { feeds: 1, probe: 1, full: 1, external: 1 });
  advance(600_000);
  assert.equal((await coordinator.tick())?.action, "unchanged");
  assert.deepEqual(calls, { feeds: 2, probe: 2, full: 1, external: 2 });
  await coordinator.stop();
});

test("away: a tick runs feeds and no signed-in read; on return, one catch-up", async () => {
  const { coordinator, calls, advance } = harness();
  await coordinator.tick();
  assert.deepEqual(calls, { feeds: 1, probe: 1, full: 1, external: 1 });
  coordinator.presence(false);
  advance(600_000);
  const away = await coordinator.tick();
  assert.equal(away?.action, "feeds_only");
  assert.equal(away?.needsSignIn, false);
  advance(600_000);
  await coordinator.tick();
  assert.deepEqual(
    calls,
    { feeds: 3, probe: 1, full: 1, external: 1 },
    "feeds keep their cadence; Canvas, GitLab and the crawl wait",
  );
  // Returning well before the next interval still earns one immediate catch-up.
  advance(60_000);
  coordinator.presence(true);
  assert.equal((await coordinator.tick())?.action, "unchanged");
  assert.deepEqual(calls, { feeds: 4, probe: 2, full: 1, external: 2 });
  // Only one: the next tick waits for the normal interval again.
  advance(60_000);
  assert.equal(await coordinator.tick(), undefined);
  coordinator.presence(true);
  assert.equal(await coordinator.tick(), undefined);
  assert.deepEqual(calls, { feeds: 4, probe: 2, full: 1, external: 2 });
  await coordinator.stop();
});

test("away with nothing held earns no catch-up; manual refresh ignores presence", async () => {
  const { coordinator, calls, advance } = harness();
  await coordinator.tick();
  coordinator.presence(false);
  advance(60_000);
  coordinator.presence(true);
  assert.equal(await coordinator.tick(), undefined);
  coordinator.presence(false);
  assert.equal((await coordinator.tick("manual"))?.action, "refreshed");
  assert.deepEqual(calls, { feeds: 2, probe: 1, full: 2, external: 2 });
  await coordinator.stop();
});
