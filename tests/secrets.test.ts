import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSecretVault } from "../apps/desktop/src/secrets";

test("vault persists only encrypted bytes, serializes concurrent updates and fails closed without OS encryption", async () => {
  const dir = await mkdtemp(join(tmpdir(), "magic-vault-test-"));
  try {
    // Fake encryption tests the boundary; Electron safeStorage supplies real OS-backed encryption.
    const encryption = {
      available: () => true,
      encrypt: (s: string) => Buffer.from(s).map((b) => b ^ 0x55),
      decrypt: (b: Uint8Array) =>
        Buffer.from(b)
          .map((v) => v ^ 0x55)
          .toString(),
    };
    const path = join(dir, "secrets.enc"),
      vault = createSecretVault(path, encryption);
    await Promise.all([
      vault.set("feed:a", "synthetic-calendar-secret"),
      vault.set("feed:b", "other-synthetic-secret"),
    ]);
    assert.equal((await vault.list("feed:")).length, 2);
    assert.equal(
      (await readFile(path)).includes(Buffer.from("synthetic-calendar-secret")),
      false,
    );
    await vault.deletePrefix("feed:a");
    assert.equal(await vault.get("feed:a"), undefined);
    await assert.rejects(
      createSecretVault(path, { ...encryption, available: () => false }).get(
        "feed:b",
      ),
      /unavailable/,
    );
    await vault.clear();
    assert.deepEqual(await vault.list("feed:"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
