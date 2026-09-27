import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chmodSync, existsSync, statSync } from "node:fs";

// node-pty 1.1.0's published Unix helper can arrive without its executable bit.
// Repair only the installed package's known helper, never a user-supplied path.
if (process.platform !== "win32") {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("node-pty/package.json"));
  for (const directory of [join("prebuilds", `${process.platform}-${process.arch}`), "build/Release"]) {
    const helper = join(root, directory, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, statSync(helper).mode | 0o111);
  }
}
