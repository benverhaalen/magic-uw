import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRefreshCoordinator,
  inQuietHours,
} from "../packages/core/src/refresh";

test("quiet windows include overnight ranges and allow an explicit disabled window", () => {
  assert.equal(inQuietHours(2, 1, 6), true);
  assert.equal(inQuietHours(6, 1, 6), false);
  assert.equal(inQuietHours(0, 22, 6), true);
  assert.equal(inQuietHours(12, 1, 1), false);
});
test("unchanged activity avoids heavy work; feeds and public refresh continue during auth pause", async () => {
  let time = new Date(2026, 8, 26, 12),
    full = 0,
    feeds = 0,
    external = 0,
    probes = 0,
    expired = false;
  const runs: unknown[] = [];
  const c = createRefreshCoordinator({
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
      feeds++;
      return { changed: false };
    },
    probe: async () => {
      probes++;
      return { needsSignIn: expired, signature: "unchanged" };
    },
    full: async () => {
      full++;
      return { needsSignIn: expired, signature: "unchanged" };
    },
    external: async () => {
      external++;
    },
    record: (run) => {
      runs.push(run);
    },
  });
  await c.tick();
  assert.equal(full, 1);
  time = new Date(time.getTime() + 600_000);
  assert.equal((await c.tick())?.action, "unchanged");
  assert.equal(full, 1);
  expired = true;
  time = new Date(time.getTime() + 600_000);
  assert.equal((await c.tick())?.needsSignIn, true);
  time = new Date(time.getTime() + 600_000);
  assert.equal((await c.tick())?.action, "feeds_only");
  assert.equal(probes, 3);
  assert.equal(feeds, 4);
  assert.equal(external, 4);
  time = new Date(time.getTime() + 600_000);
  await c.tick();
  assert.equal(probes, 3);
  time = new Date(time.getTime() + 600_000);
  await c.tick();
  assert.equal(
    probes,
    4,
    "retry occurs after three intervals, not a rolling deadline",
  );
  expired = false;
  c.reconnected();
  await c.tick("manual");
  assert.equal(full, 2);
  assert.equal(runs.length, 7);
  await c.stop();
});
test("suspend aborts work and resume does not wake or immediately ping; manual bypasses quiet hours", async () => {
  let time = new Date(2026, 8, 26, 2),
    called = 0;
  const c = createRefreshCoordinator({
    settings: () => ({
      enabled: true,
      intervalMinutes: 10,
      jitterFraction: 0,
      quietStartHour: 1,
      quietEndHour: 6,
    }),
    now: () => time,
    hasSources: () => true,
    feeds: async () => ({ changed: false }),
    probe: async () => ({ needsSignIn: false }),
    full: async () => {
      called++;
      return { needsSignIn: false };
    },
    external: async () => {},
    record: () => {},
  });
  await c.tick();
  assert.equal(called, 0);
  await c.tick("manual");
  assert.equal(called, 1);
  c.suspend();
  await c.tick("manual");
  assert.equal(called, 1);
  time = new Date(2026, 8, 26, 12);
  c.resume();
  await c.tick();
  assert.equal(called, 1);
  await c.stop();
});

test("an incomplete full read cannot establish the unchanged-summary shortcut", async () => {
  let time = new Date(2026, 8, 26, 12),
    full = 0;
  const coordinator = createRefreshCoordinator({
    settings: () => ({
      enabled: true,
      intervalMinutes: 10,
      jitterFraction: 0,
      quietStartHour: 0,
      quietEndHour: 0,
    }),
    now: () => time,
    hasSources: () => true,
    feeds: async () => ({ changed: false }),
    probe: async () => ({ needsSignIn: false, signature: "same" }),
    full: async () => {
      full++;
      return { needsSignIn: false, complete: full > 1, signature: "same" };
    },
    external: async () => {},
    record: () => {},
  });
  await coordinator.tick();
  time = new Date(time.getTime() + 600000);
  await coordinator.tick();
  assert.equal(full, 2);
  time = new Date(time.getTime() + 600000);
  await coordinator.tick();
  assert.equal(full, 2);
  await coordinator.stop();
});
