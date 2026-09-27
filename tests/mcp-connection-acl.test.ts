import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restrictToCurrentUser, verifyRestrictedToCurrentUser } from "../apps/desktop/src/mcp-connection-acl.ts";

test(
  "Windows: the connection file's ACL is restricted to the current user, and verifies as such",
  { skip: process.platform !== "win32" && "icacls is a Windows-only tool" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-acl-"));
    const file = join(dir, "connection.json");
    await writeFile(file, "{}");
    await restrictToCurrentUser(file);
    assert.equal(await verifyRestrictedToCurrentUser(file), true);
  },
);

test("non-Windows: both functions are no-ops that report success", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "mcp-acl-"));
  const file = join(dir, "connection.json");
  await writeFile(file, "{}");
  await restrictToCurrentUser(file);
  assert.equal(await verifyRestrictedToCurrentUser(file), true);
});
