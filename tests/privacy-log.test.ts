import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema } from "@magic/contracts";
import { logLine, redactForLog, urlClass } from "../packages/core/src/privacy/log";

const CANARIES = ["Quentin", "Zabrowski", "qzabrowski", "555-0142", "9081234567", "CANARYVERIFIER77", "Canaryhill", "03/14/2004", "4455667", "canary-page-slug"];

test("redactForLog: URLs keep host and path class only; identifiers and credentials never appear", () => {
  assert.equal(urlClass("https://canvas.wisc.edu/courses/5/files/77/download?verifier=CANARYVERIFIER77#x"), "canvas.wisc.edu/courses/:id/files/:id/download");
  assert.equal(urlClass("https://canvas.wisc.edu/courses/5/pages/canary-page-slug"), "canvas.wisc.edu/courses/:id/pages/:slug");
  assert.equal(urlClass("https://canvas.wisc.edu/courses/5/users/4455667"), "canvas.wisc.edu/courses/:id/users/:id");
  const out = JSON.stringify(
    redactForLog(
      {
        event: "fetch.failed",
        to: "https://canvas.wisc.edu/courses/5/pages/canary-page-slug?token=abc",
        error: new Error("Quentin Zabrowski <qzabrowski@wisc.edu> 608-555-0142 Student ID: 9081234567 at 1234 Canaryhill Street, DOB: 03/14/2004"),
        cookie: "session=CANARYVERIFIER77",
        nested: [{ authorization: "Bearer CANARYVERIFIER77" }],
        ok: true,
        count: 3,
      },
      { names: ["Quentin Zabrowski"] },
    ),
  );
  for (const canary of CANARIES) assert.ok(!out.includes(canary), `${canary} in ${out}`);
  assert.match(out, /"ok":true/);
  assert.match(out, /"count":3/);
});

test("the log output of a full synthetic sync carries no canary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "privacy-log-"));
  const logFile = join(dir, "trial.log");
  const text =
    "Quentin Zabrowski (qzabrowski@wisc.edu), phone (608) 555-0142, Student ID: 9081234567, lives at 1234 Canaryhill Street, DOB: 03/14/2004. " +
    "Slides https://canvas.wisc.edu/files/77/download?verifier=CANARYVERIFIER77 and https://canvas.wisc.edu/courses/5/users/4455667";
  const batch = captureBatchSchema.parse({
    source: { id: "canary", label: "Canary course", kind: "fixture", accountScope: "acct", courseId: "c", scope: "all" },
    observedAt: "2026-09-26T12:00:00Z", status: "ok", complete: true,
    resources: [
      { externalId: "p1", kind: "material", courseId: "c", courseName: "CS 400", title: "Stacks", text, url: "https://canvas.wisc.edu/courses/5/pages/canary-page-slug", deadlines: [] },
      { externalId: "a1", kind: "assignment", courseId: "c", courseName: "CS 400", title: "Lab 1", text, url: "https://canvas.wisc.edu/courses/5/assignments/1", deadlines: [], submission: { comments: [{ text, authorName: "Quentin Zabrowski" }] } },
    ],
  });
  // Everything written to the console or the process streams during the sync is captured too.
  const captured: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info, out: process.stdout.write, err: process.stderr.write };
  const grab = (...args: unknown[]) => void captured.push(args.map(String).join(" "));
  console.log = console.warn = console.error = console.info = grab;
  process.stdout.write = ((chunk: unknown) => (captured.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => (captured.push(String(chunk)), true)) as typeof process.stderr.write;
  const store = createStore(join(dir, "db.sqlite"));
  const core = createCore(store, { fixture: batch });
  try {
    await core.execute({ type: "fixture" });
    await core.settled();
    // The trial log's events for this sync, as main writes them (fetches, sign-in steps, failures).
    for (const r of store.resources()) {
      appendFileSync(logFile, logLine({ event: "fetch", service: "canvas", to: `${r.url}?verifier=CANARYVERIFIER77`, status: 200, bytes: r.text.length }));
      appendFileSync(logFile, logLine({ event: "signin.navigate", to: `${r.url}${r.url.includes("?") ? "&" : "?"}login_hint=qzabrowski@wisc.edu` }));
    }
    appendFileSync(logFile, logLine({ event: "sync.failed", error: new Error(`Could not read ${text}`) }));
  } finally {
    Object.assign(console, { log: original.log, warn: original.warn, error: original.error, info: original.info });
    process.stdout.write = original.out;
    process.stderr.write = original.err;
    await core.close();
  }
  try {
    const log = readFileSync(logFile, "utf8") + captured.join("\n");
    assert.ok(log.includes("canvas.wisc.edu/courses/:id/pages/:slug"), "the log keeps the host and path class");
    for (const canary of CANARIES) assert.ok(!log.includes(canary), `${canary} reached the log`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
