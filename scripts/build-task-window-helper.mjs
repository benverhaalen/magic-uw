// owner: task-workspace. Compiles the task-window helper beside main.cjs on macOS,
// where the main process finds it with __dirname. Elsewhere task windows report
// that the helper is missing and the workspace falls back to ordinary links.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

if (process.platform === "darwin") {
  execFileSync("xcrun", [
    "swiftc", "-O",
    join("apps", "desktop", "native", "task-window-helper.swift"),
    "-o", join("apps", "desktop", "dist", "task-window-helper"),
  ], { stdio: "inherit" });
}
