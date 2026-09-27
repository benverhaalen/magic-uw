import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore, SCHEMA_VERSION } from "@magic/storage";
import { deriveInstallKeys, open, seal } from "../packages/core/src/privacy/at-rest";
import { verifyAndDropBackup } from "../packages/storage/src/privacy-v14";

const at = "2026-09-26T12:00:00Z";
const PREVIEW = "CANARYPREVIEW Quentin, your advising hold clears Friday";
const GIST = "CANARYGIST advising hold";
const NOTE = "CANARYNOTEBODY lecture notes on recursion";
const DARS = "CANARYDARS degree audit";
const keyA = deriveInstallKeys(Buffer.alloc(32, 7)).atRest;
const keyB = deriveInstallKeys(Buffer.alloc(32, 9)).atRest;

const SENDER = "CANARYSENDER Ottoline", LIFE_GIST = "CANARYLIFEGIST advising reminder";
function seedLife(store: ReturnType<typeof createStore>) {
  store.ingest({ source: { id: "feeds", label: "Campus feeds", kind: "web", accountScope: "acct", courseId: "_life", scope: "news" }, observedAt: at, status: "ok", complete: true, resources: [] });
  store.putLifeItem({ id: "li", sourceId: "feeds", area: "mail", courseId: null, sender: SENDER, title: "Advising", date: at, labels: [], link: "https://news.example.test/a", duplicateOf: null, gist: LIFE_GIST });
}
function seed(store: ReturnType<typeof createStore>) {
  store.ingest({
    source: { id: "mail", kind: "mail", label: "Outlook mail", accountScope: "acct", courseId: "outlook-mail", scope: "graph_mail" },
    observedAt: at, status: "ok", complete: true,
    resources: [{
      externalId: "mail:1", kind: "message", courseId: "outlook-mail", courseName: "Outlook mail", title: "Advising appointment",
      text: GIST, url: "https://outlook.office.com/mail/", deadlines: [],
      mail: { messageId: "m1", folder: "inbox", fromName: "Quentin Zabrowski", fromAddress: "qzab@wisc.edu", receivedAt: at, preview: PREVIEW, gist: GIST, category: "advisor", categoryReason: "Sender is an advisor." },
    }],
  });
  store.ingest({
    source: { id: "notes", kind: "notes", label: "OneNote", accountScope: "acct", courseId: "unmapped", scope: "graph_notes" },
    observedAt: at, status: "ok", complete: true,
    resources: [{
      externalId: "note:1", kind: "material", courseId: "unmapped", courseName: "Notes", title: "Week 3", text: NOTE,
      url: "https://onenote.com/p/1", deadlines: [], notes: { sourceSubtype: "onenote", itemId: "pg1" },
    }],
  });
  store.ingestPlanning({
    schemaVersion: 1, id: "primary", accountScope: "academic", source: "uw_enroll", scope: { kind: "degree_plan", key: "primary" },
    sourceUrl: "https://enroll.wisc.edu/", observedAt: at, status: "complete", completeness: "complete", diagnostics: [],
    records: [{ kind: "course_history", id: DARS, courseKey: "uw:266:101", termCode: "1264", grade: "AB", credits: 3, state: "completed", gpaEligible: null,
      provenance: { scope: { kind: "degree_plan", key: "primary" }, sourceUrl: "https://enroll.wisc.edu/", observedAt: at } }],
  });
}
/** Every byte of the database, its WAL and shared memory, as latin1 text for a plain search. */
const raw = (file: string) => ["", "-wal"].map((s) => { try { return readFileSync(file + s).toString("latin1"); } catch { return ""; } }).join("");
/** The stored resource payloads only (notes stay in the passage index by design: headings and terms). */
function payloads(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT payload FROM resource_versions").all().map((r) => Buffer.from(r.payload as Uint8Array).toString("latin1")).join("");
  } finally {
    db.close();
  }
}

test("AES-256-GCM seal: round trip, tamper and wrong-column detection", () => {
  const sealed = seal(keyA, "secret", "a");
  assert.equal(open(keyA, sealed, "a").toString(), "secret");
  assert.throws(() => open(keyA, sealed, "b"));
  assert.throws(() => open(keyB, sealed, "a"));
  const bytes = Buffer.from(sealed.slice(5), "base64");
  bytes[bytes.length - 1]! ^= 1;
  assert.throws(() => open(keyA, `enc1:${bytes.toString("base64")}`, "a"));
});

test("mail, notes and planning payloads are sealed on write, open in memory, and mail search covers subject and category only", () => {
  const dir = mkdtempSync(join(tmpdir(), "privacy-at-rest-"));
  const file = join(dir, "db.sqlite");
  try {
    const store = createStore(file);
    store.setAtRestKey(keyA);
    seed(store);
    const mail = store.resources().find((r) => r.kind === "message")!;
    assert.equal(mail.mail!.preview, PREVIEW);
    assert.equal(mail.mail!.fromAddress, "qzab@wisc.edu");
    assert.equal(mail.text, GIST);
    assert.equal(store.resources().find((r) => r.notes)!.text, NOTE);
    assert.equal(store.planningRecords()[0]!.id, DARS);
    const search = (query: string) => store.searchPassages({ query, courses: [{ accountScope: "acct", courseId: "outlook-mail" }], k: 5 }).hits.length;
    assert.equal(search("advising appointment"), 1, "subject is searchable");
    assert.equal(search("advisor"), 1, "category is searchable");
    assert.equal(search("CANARYPREVIEW"), 0, "the preview is not in the index");
    store.close();
    const bytes = raw(file);
    for (const canary of ["CANARYPREVIEW", "CANARYGIST", "CANARYDARS", "qzab@wisc.edu", "Quentin Zabrowski"])
      assert.ok(!bytes.includes(canary), `${canary} is not in the database file in plaintext`);
    assert.ok(!payloads(file).includes("CANARYNOTEBODY"), "the notes body is sealed in its payload");
    const again = createStore(file);
    again.setAtRestKey(keyA);
    assert.equal(again.resources().find((r) => r.kind === "message")!.mail!.preview, PREVIEW, "reopens with the same key");
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lazy migration: rows written before the key arrive are sealed on the first key; another key reads the clear part only", () => {
  const dir = mkdtempSync(join(tmpdir(), "privacy-lazy-"));
  const file = join(dir, "db.sqlite");
  try {
    const store = createStore(file);
    seed(store);
    assert.ok(raw(file).includes("CANARYDARS"), "without a key the rows are plaintext");
    const first = store.setAtRestKey(keyA);
    assert.ok(first.sealed >= 4, `sealed ${first.sealed}`);
    assert.equal(store.setAtRestKey(keyA).sealed, 0, "idempotent: nothing left to seal");
    store.close();
    const bytes = raw(file);
    for (const canary of ["CANARYPREVIEW", "CANARYGIST", "CANARYDARS"]) assert.ok(!bytes.includes(canary), canary);
    assert.ok(!payloads(file).includes("CANARYNOTEBODY"));
    const other = createStore(file);
    const result = other.setAtRestKey(keyB);
    assert.equal(result.keyMatches, false);
    const mail = other.resources().find((r) => r.kind === "message")!;
    assert.equal(mail.title, "Advising appointment");
    assert.equal(mail.mail!.preview, "");
    assert.equal(other.planningRecords().length, 0, "sealed planning records that cannot be opened are skipped");
    other.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration v14 is additive and idempotent from v9; receipts keep protection counts; purge destroys the key", () => {
  const dir = mkdtempSync(join(tmpdir(), "privacy-v14-"));
  const file = join(dir, "db.sqlite");
  try {
    createStore(file).close();
    const db = new DatabaseSync(file);
    // The chain: main's v12 and v13, then this branch's v14 (applied from v13).
    db.exec("ALTER TABLE receipts DROP COLUMN protection; PRAGMA user_version = 13;");
    db.close();
    const first = createStore(file);
    assert.equal(first.backupCheck()?.status, "deleted", "the verified pre-v14 backup is deleted");
    assert.equal(first.migrationBackup(), null);
    first.close();
    createStore(file).close();
    const check = new DatabaseSync(file, { readOnly: true });
    assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, SCHEMA_VERSION);
    assert.ok(check.prepare("PRAGMA table_info(receipts)").all().some((c) => c.name === "protection"));
    check.close();
    const store = createStore(file);
    store.setAtRestKey(keyA);
    seed(store);
    const mail = store.resources().find((r) => r.kind === "message")!;
    store.addReceipt({ id: "r1", recipient: "claude", purpose: "p", categories: ["communications"], resourceIds: [mail.id], characters: 10, status: "sent", createdAt: at, protection: { student_name: 3, email: 1, phone: 1 } });
    assert.deepEqual(store.receipts()[0]!.protection, { student_name: 3, email: 1, phone: 1 });
    store.purge();
    assert.equal(store.atRestStats().keyed, false, "purge drops the key from memory");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("life_items sender and gist are sealed on write and by the lazy pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "privacy-life-"));
  const file = join(dir, "db.sqlite");
  try {
    const store = createStore(file);
    seedLife(store);
    assert.ok(raw(file).includes("CANARYLIFEGIST"), "plaintext before the key");
    store.setAtRestKey(keyA);
    assert.deepEqual(store.lifeItems("mail").map((l) => [l.sender, l.gist]), [[SENDER, LIFE_GIST]]);
    store.putLifeItem({ ...store.lifeItems("mail")[0]!, id: "li2" });
    store.close();
    const bytes = raw(file);
    for (const canary of ["CANARYSENDER", "CANARYLIFEGIST"]) assert.ok(!bytes.includes(canary), canary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a backup whose row counts do not match is kept, with the reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "privacy-backup-"));
  const file = join(dir, "db.sqlite"), backup = join(dir, "db.sqlite.pre-v14.bak");
  try {
    const store = createStore(file);
    seed(store);
    store.close();
    const copy = new DatabaseSync(file);
    copy.exec(`VACUUM INTO '${backup.replaceAll("\\", "/")}'`);
    copy.close();
    const extra = new DatabaseSync(backup);
    extra.exec("INSERT INTO preferences VALUES ('extra', 'row')");
    extra.close();
    const db = new DatabaseSync(file);
    const kept = verifyAndDropBackup(db, backup, 13);
    assert.equal(kept.status, "kept");
    assert.match((kept as { reason: string }).reason, /row count of preferences/);
    assert.ok(existsSync(backup), "a failed check keeps the backup");
    const fixed = new DatabaseSync(backup);
    fixed.exec("DELETE FROM preferences WHERE key = 'extra'");
    fixed.close();
    assert.equal(verifyAndDropBackup(db, backup, 13).status, "deleted");
    assert.equal(existsSync(backup), false);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
