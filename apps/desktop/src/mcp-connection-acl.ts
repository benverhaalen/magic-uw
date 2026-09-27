import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Windows has no `0o077` file-mode check (`stat` never reports NTFS ACLs that way), so the MCP
 * connection file's ACL is restricted explicitly here at export time (main.ts) and re-checked
 * on every read (mcp-server.ts), since the file holds a bearer token.
 */
export async function restrictToCurrentUser(path: string): Promise<void> {
  if (process.platform !== "win32") return;
  const username = userInfo().username;
  await execFileAsync("icacls", [path, "/inheritance:r", "/grant:r", `${username}:(R,W)`]);
}

/**
 * Verifies no principal other than the current user has an ACE on the file. Returns `true`
 * when verified, or when `icacls` couldn't be run (a warning is logged; this never blocks a
 * host lacking the tool, only weakens the guarantee for that run).
 */
export async function verifyRestrictedToCurrentUser(path: string): Promise<boolean> {
  if (process.platform !== "win32") return true;
  const username = userInfo().username.toLowerCase();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("icacls", [path]));
  } catch {
    console.warn("icacls is unavailable; the MCP connection file's permissions could not be verified.");
    return true;
  }
  const body = stdout.startsWith(path) ? stdout.slice(path.length) : stdout;
  const others = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(":("))
    .map((line) => line.slice(0, line.indexOf(":(")).trim().toLowerCase())
    .filter((principal) => principal !== username && !principal.endsWith(`\\${username}`));
  return others.length === 0;
}
