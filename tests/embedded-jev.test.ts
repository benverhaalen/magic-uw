import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEmbeddedJev } from "../apps/desktop/src/embedded-jev";

test("a build without an embedded key starts nothing", async () => {
  assert.equal(await startEmbeddedJev(mkdtempSync(join(tmpdir(), "magic-jev-"))), null);
});

test("an embedded key serves the ordinary gateway on loopback only, with its own local store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-jev-"));
  // A placeholder, never a real credential; enrollment does not contact TypeSafe.
  const jev = await startEmbeddedJev(dir, "placeholder-not-a-key");
  assert.ok(jev);
  try {
    const url = new URL(jev.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.ok(Number(url.port) > 0);
    const health = await fetch(`${jev.url}/health`);
    assert.equal(health.status, 200);
    const enrolled = await fetch(`${jev.url}/v1/devices`, { method: "POST" });
    assert.equal(enrolled.status, 201);
    const body = (await enrolled.json()) as Record<string, unknown>;
    assert.equal(typeof body.token, "string");
    assert.doesNotMatch(JSON.stringify(body), /placeholder-not-a-key/);
  } finally {
    await jev.close();
  }
});
