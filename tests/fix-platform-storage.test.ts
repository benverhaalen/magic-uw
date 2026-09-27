// Unread append tables stop growing; receipts are indexed and keep 90 days of detail plus counts;
// the migration is additive and idempotent; purge leaves no content row and runs with FKs off.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore, readerReceiptLogPath, SCHEMA_VERSION } from "@magic/storage";
import type { EgressReceipt, ResourceInput } from "@magic/contracts";
import { purgeHostData } from "../apps/desktop/src/purge-host";

const day = 86_400_000;
const clock = new Date("2026-09-27T12:00:00.000Z");
const iso = (offsetDays: number) => new Date(clock.getTime() + offsetDays * day).toISOString();
const item = (externalId: string, text = "Enzymes lower activation energy."): ResourceInput => ({
  externalId,
  kind: "assignment",
  courseId: "c",
  courseName: "Biochemistry",
  title: `Problem set ${externalId}`,
  url: `https://canvas.example.test/courses/1/assignments/${externalId}`,
  text,
  deadlines: [],
  policy: { mode: "unknown", evidence: "" },
  points: null,
  submitted: false,
});
const batch = (minute: number, resources: ResourceInput[]) => ({
  source: { id: "s", label: "Assignments", kind: "canvas" as const, accountScope: "a", courseId: "c", scope: "assignments" },
  observedAt: new Date(clock.getTime() + minute * 60_000).toISOString(),
  status: "ok" as const,
  complete: true,
  resources,
});
const count = (file: string, table: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()!.n);
  } finally {
    db.close();
  }
};
const receipt = (id: string, resourceId: string, createdAt: string): EgressReceipt => ({
  id,
  recipient: "local",
  purpose: "MCP search",
  categories: ["course_text"],
  resourceIds: [resourceId],
  characters: 100,
  status: "sent",
  createdAt,
});

test("observations and source_observations stay empty across repeated syncs (nothing reads them)", () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-append-"));
  const file = join(dir, "w.sqlite");
  const store = createStore(file, { now: () => clock });
  try {
    store.ingest(batch(0, [item("1"), item("2")]));
    store.ingest(batch(1, [item("1", "Changed text.")]));
    store.ingest(batch(2, [item("1", "Changed text.")]));
    assert.equal(store.resources().length, 1);
    assert.ok(Object.keys(store.resources()[0]!.fieldLastSeen ?? {}).length > 0, "the latest per-field state is kept");
    assert.equal(count(file, "observations"), 0);
    assert.equal(count(file, "source_observations"), 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("receipts: an index on created_at, and past 90 days only per-day counts remain", () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-receipts-"));
  const file = join(dir, "w.sqlite");
  let now = clock;
  const store = createStore(file, { now: () => now });
  try {
    store.ingest(batch(0, [item("1")]));
    const id = store.resources()[0]!.id;
    store.addReceipt(receipt("old-1", id, iso(-120)));
    store.addReceipt(receipt("old-2", id, iso(-120)));
    store.addReceipt(receipt("old-3", id, iso(-100)));
    assert.equal(store.receipts().length, 2, "the first receipt swept at once; the next sweep waits a day");
    now = new Date(clock.getTime() + 2 * day); // the sweep runs with a receipt, at most once a day
    store.addReceipt(receipt("new-1", id, iso(-5)));
    assert.deepEqual(store.receipts().map((r) => r.id), ["new-1"]);
    assert.deepEqual(
      store.receiptCounts().map((c) => [c.day, c.receipts, c.characters]),
      [
        [iso(-120).slice(0, 10), 2, 200],
        [iso(-100).slice(0, 10), 1, 100],
      ],
    );
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const plan = db
        .prepare("EXPLAIN QUERY PLAN SELECT * FROM receipts WHERE created_at < ?")
        .all("2026-01-01")
        .map((r) => String(r.detail))
        .join(" ");
      assert.match(plan, /receipts_created/);
    } finally {
      db.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the receipts migration is additive and idempotent: re-running it changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-migrate-"));
  const file = join(dir, "w.sqlite");
  createStore(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`); // as if only the steps before this one had run: it runs again
  raw.close();
  const again = createStore(file);
  again.close();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(Number(db.prepare("PRAGMA user_version").get()!.user_version), SCHEMA_VERSION);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'receipts_created'").get());
  } finally {
    db.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

test("purge leaves no content row in any table, re-enables foreign keys and removes the reader's log", () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-purge-"));
  const file = join(dir, "w.sqlite");
  const store = createStore(file, { now: () => clock });
  try {
    store.ingest(batch(0, Array.from({ length: 20 }, (_, i) => item(String(i)))));
    const id = store.resources()[0]!.id;
    store.setCompleted(id, true);
    store.addReceipt(receipt("old", id, iso(-200))); // swept at once into the counts
    store.addReceipt(receipt("r", id, iso(0)));
    assert.equal(store.receiptCounts().length, 1);
    store.setMcpGrant({
      id: "g",
      label: "t",
      recipient: "local",
      enabled: true,
      courses: [],
      categories: ["course_text"],
      tokenHash: "0".repeat(64),
    });
    writeFileSync(readerReceiptLogPath(file), "{}\n");
    store.purge();
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           AND name NOT GLOB '*_config' AND name NOT GLOB '*_data' AND name NOT GLOB '*_idx'
           AND name NOT GLOB '*_docsize' AND name NOT GLOB '*_content'`,
        )
        .all()
        .map((r) => String(r.name));
      assert.ok(tables.includes("passage_fts") && tables.includes("receipts"));
      for (const table of tables)
        assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()!.n), 0, table);
    } finally {
      db.close();
    }
    assert.equal(existsSync(readerReceiptLogPath(file)), false);
    assert.deepEqual(store.receiptCounts(), [], "the counts go with the preferences");
    // Foreign keys are back on after the purge: removing a source cascades to its resources again.
    store.ingest(batch(10, [item("x")]));
    assert.equal(store.resources().length, 1);
    store.removeSource("s");
    assert.equal(store.resources().length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the host purge clears both sessions' storage and HTTP cache, and every app-owned folder", async () => {
  const calls: string[] = [];
  const session = (name: string) => ({
    clearStorageData: async () => void calls.push(`${name}:storage`),
    clearCache: async () => void calls.push(`${name}:cache`),
  });
  await purgeHostData({
    sessions: [session("student"), session("gitlab")],
    folders: ["/data/clients", "/data/documents", "/data/mcp"],
    remove: async (path) => void calls.push(`rm:${path}`),
    also: [Promise.resolve(calls.push("planning"))],
  });
  assert.deepEqual(new Set(calls), new Set([
    "student:storage", "student:cache", "gitlab:storage", "gitlab:cache",
    "rm:/data/clients", "rm:/data/documents", "rm:/data/mcp", "planning",
  ]));
});
