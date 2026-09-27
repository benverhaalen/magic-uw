// owner: calendar-import. Compiles the Google Calendar import helper beside main.cjs on
// macOS, where the main process finds it with __dirname. Elsewhere the export reports that
// the helper is missing and offers only the short manual path.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

if (process.platform === "darwin") {
  execFileSync("xcrun", [
    "swiftc", "-O",
    join("apps", "desktop", "native", "calendar-import-helper.swift"),
    "-o", join("apps", "desktop", "dist", "calendar-import-helper"),
  ], { stdio: "inherit" });
}
