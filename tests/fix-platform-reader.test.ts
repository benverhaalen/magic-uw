// The course bank is a read-only reader: it never writes, migrates or backs up the database, and
// its receipts round-trip through an append-only log the app imports on its next open.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createStore, readerReceiptLogPath, ReaderSchemaError, SCHEMA_VERSION } from "@magic/storage";
import { defaultPrivacy, type ResourceInput } from "@magic/contracts";
import { createMcpService } from "../packages/core/src/mcp";
import { restrictToCurrentUser } from "../apps/desktop/src/mcp-connection-acl";

const at = "2099-01-01T12:00:00.000Z";
const item = (externalId: string, text: string): ResourceInput => ({
  externalId,
  kind: "material",
  courseId: "course",
  courseName: "Biology 101",
  title: `Reading ${externalId}`,
  url: `https://canvas.example.test/courses/1/pages/${externalId}`,
  text,
  deadlines: [],
  policy: { mode: "unknown", evidence: "" },
  points: null,
  submitted: false,
});
function seed(dir: string, file = join(dir, "workspace.sqlite")) {
  const store = createStore(file);
  const token = randomBytes(32).toString("hex");
  store.setMcpGrant({
    id: "client",
    label: "Test",
    recipient: "local",
    enabled: true,
    courses: [{ accountScope: "account", courseId: "course" }],
    categories: ["course_text"],
    tokenHash: createHash("sha256").update(token).digest("hex"),
  });
  store.ingest({
    source: { id: "s", label: "Pages", kind: "canvas", accountScope: "account", courseId: "course", scope: "pages" },
    observedAt: at,
    status: "ok",
    complete: true,
    resources: [item("a", "Osmosis moves water across a membrane."), item("b", "Mitosis divides a cell.")],
  });
  return { store, token, file };
}
const version = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number(db.prepare("PRAGMA user_version").get()!.user_version);
  } finally {
    db.close();
  }
};

test("the reader opens read-only: every write fails in SQLite, and reads still work", () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-reader-"));
  const { store, file } = seed(dir);
  store.close();
  const reader = createStore(file, { readOnly: true });
  try {
    assert.equal(reader.resources().length, 2);
    assert.equal(reader.searchPassages({ query: "osmosis" }).hits.length, 1);
    assert.throws(() => reader.setPrivacy({ ...defaultPrivacy }), /readonly|read-only/i);
    assert.throws(() => reader.setCompleted(reader.resources()[0]!.id, true), /readonly|read-only/i);
    assert.throws(
      () =>
        reader.ingest({
          source: { id: "x", label: "x", kind: "canvas", accountScope: "a", courseId: "c", scope: "pages" },
          observedAt: at,
          status: "ok",
          complete: true,
          resources: [],
        }),
      /readonly|read-only/i,
    );
  } finally {
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the reader never migrates or backs up: an older schema is refused with a clear message", () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-reader-old-"));
  const { store, file } = seed(dir);
  store.close();
  const raw = new DatabaseSync(file);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
  raw.close();
  try {
    assert.throws(() => createStore(file, { readOnly: true }), (error: unknown) => {
      assert.ok(error instanceof ReaderSchemaError);
      assert.match((error as Error).message, /Open My Magic UW once/);
      return true;
    });
    assert.equal(version(file), SCHEMA_VERSION - 1, "no migration step ran");
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".bak")), [], "no VACUUM INTO backup");
    assert.throws(() => createStore(join(dir, "missing.sqlite"), { readOnly: true }), ReaderSchemaError);
    assert.equal(existsSync(join(dir, "missing.sqlite")), false, "the reader never creates a database");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reader receipts round-trip through the log: nothing in the database until the app imports them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-reader-log-"));
  const { store, token, file } = seed(dir);
  store.close();
  const reader = createStore(file, { readOnly: true });
  const log = readerReceiptLogPath(file);
  const mcp = createMcpService(reader, "client", token, () => new Date(at), {
    recordReceipt: (r) => appendFileSync(log, `${JSON.stringify(r)}\n`),
  });
  try {
    assert.equal((mcp.call("search", { query: "osmosis membrane" }) as unknown[]).length, 1);
    mcp.call("get_item", { id: reader.resources()[0]!.id });
    assert.equal(reader.receipts().length, 0, "the reader wrote nothing");
    const lines = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    appendFileSync(log, "{not json\n"); // a torn line is skipped, not fatal
  } finally {
    await mcp.server.close();
    reader.close();
  }
  const app = createStore(file);
  try {
    const receipts = app.receipts();
    assert.deepEqual(receipts.map((r) => r.purpose).sort(), ["MCP get_item", "MCP search"]);
    assert.equal(existsSync(log), false);
    assert.equal(existsSync(`${log}.importing`), false);
    assert.equal(app.importReaderReceipts(), 0, "a second import finds nothing");
  } finally {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "over real stdio, a connection file without a database path serves read-only and logs its receipts",
  { timeout: 20000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "magic-reader-stdio-"));
    const { store, token, file } = seed(dir);
    mkdirSync(join(dir, "mcp"));
    const connection = join(dir, "mcp", "client.json");
    writeFileSync(connection, JSON.stringify({ clientId: "client", token }), { mode: 0o600 });
    await restrictToCurrentUser(connection);
    assert.equal(readFileSync(connection, "utf8").includes("sqlite"), false);
    const client = new Client({ name: "reader test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", resolve("apps/desktop/src/mcp-server.ts"), "--connection", connection],
      cwd: resolve("."),
      stderr: "pipe",
    });
    try {
      await client.connect(transport, { timeout: 8000 });
      const result = await client.callTool({ name: "search", arguments: { query: "mitosis" } });
      assert.notEqual(result.isError, true);
      const hits = JSON.parse((result.content as { text: string }[])[0]!.text) as { title: string }[];
      assert.deepEqual(hits.map((h) => h.title), ["Reading b"]);
      assert.equal(store.receipts().length, 0, "the reader did not write the receipts table");
      assert.equal(readFileSync(readerReceiptLogPath(file), "utf8").trim().split("\n").length, 1);
      assert.equal(store.importReaderReceipts(), 1);
      assert.equal(store.receipts()[0]!.purpose, "MCP search");
    } finally {
      await client.close();
      await transport.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
