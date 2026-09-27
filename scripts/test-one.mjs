#!/usr/bin/env node
// Run a single test file with tsx --test, resolving tsx from the workspace so
// it works on Windows without relying on a global install or PATH shim.
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const target = process.argv[2];

if (!target) {
  console.error(
    "Usage: node scripts/test-one.mjs <path-to-test-file>\nMissing required <path-to-test-file> argument.",
  );
  process.exit(2);
}

const resolvedTarget = resolve(process.cwd(), target);

if (!existsSync(resolvedTarget)) {
  console.error(`Test file not found: ${target} (resolved to ${resolvedTarget})`);
  process.exit(2);
}

const isWindows = process.platform === "win32";
const tsxBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  isWindows ? "tsx.cmd" : "tsx",
);

const command = existsSync(tsxBin) ? tsxBin : "tsx";
const args = ["--test", resolvedTarget];

// Strip NODE_TEST_CONTEXT: when this script is itself invoked from inside a
// node:test run (e.g. tests/harness.test.ts spawning test-one.mjs), Node
// propagates that env var to child processes, and the child's own node:test
// runner then treats itself as a nested/recursive run and skips executing
// any tests, exiting 0 without ever running the target file.
const { NODE_TEST_CONTEXT, ...childEnv } = process.env;

const child = spawn(command, args, {
  stdio: "inherit",
  shell: isWindows,
  env: childEnv,
});

child.on("error", (error) => {
  console.error(`Failed to run tsx: ${error.message}`);
  process.exit(2);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 1);
});
