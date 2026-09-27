import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testsDir, "..");

const runNode = (args: string[]) =>
  spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });

test("test-one fails for a missing test file", () => {
  const result = runNode([
    "scripts/test-one.mjs",
    "tests/does-not-exist.test.ts",
  ]);
  assert.notEqual(result.status, 0);
});

test("test-one runs an existing test file and passes its exit code through", () => {
  const passing = mkdtempSync(join(tmpdir(), "magic-harness-pass-"));
  const passingFile = join(passing, "passing.test.ts");
  writeFileSync(
    passingFile,
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'test("synthetic pass", () => { assert.equal(1, 1); });',
      "",
    ].join("\n"),
  );

  try {
    const result = runNode(["scripts/test-one.mjs", passingFile]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(passing, { recursive: true, force: true });
  }

  const failing = mkdtempSync(join(tmpdir(), "magic-harness-fail-"));
  const failingFile = join(failing, "failing.test.ts");
  writeFileSync(
    failingFile,
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'test("synthetic fail", () => { assert.equal(1, 2); });',
      "",
    ].join("\n"),
  );

  try {
    const result = runNode(["scripts/test-one.mjs", failingFile]);
    assert.notEqual(result.status, 0);
  } finally {
    rmSync(failing, { recursive: true, force: true });
  }
});

const writeTemp = (name: string, content: string) => {
  const dir = mkdtempSync(join(tmpdir(), "magic-probes-"));
  const file = join(dir, name);
  writeFileSync(file, content);
  return { dir, file };
};

const goodProbesContent = [
  "## E1",
  "Notes about E1.",
  "",
  "Verdict (2026-09-26): confirmed.",
  "",
  "## K1",
  "Notes about K1.",
  "",
  "**Verdict (2026-09-26):** confirmed.",
  "",
  "## MD1",
  "Notes about MD1.",
  "",
  "Verdict (2026-09-26): confirmed.",
  "",
  "## S1",
  "Notes about S1.",
  "",
  "Verdict (2026-09-26): confirmed.",
  "",
  "## RP1",
  "Notes about RP1.",
  "",
  "Verdict (2026-09-26): confirmed.",
  "",
  "## RP2",
  "Notes about RP2.",
  "",
  "Verdict (2026-09-26): confirmed.",
  "",
  "## RP3",
  "Notes about RP3.",
  "",
  "Verdict (2026-09-26): confirmed.",
  "",
].join("\n");

test("check-probes passes a synthetic good file", () => {
  const { dir, file } = writeTemp("good.md", goodProbesContent);
  try {
    const result = runNode(["scripts/check-probes.mjs", file]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-probes fails a synthetic file missing a verdict", () => {
  const missingVerdict = goodProbesContent.replace(
    "Verdict (2026-09-26): confirmed.\n\n## K1",
    "## K1",
  );
  const { dir, file } = writeTemp("missing-verdict.md", missingVerdict);
  try {
    const result = runNode(["scripts/check-probes.mjs", file]);
    assert.notEqual(result.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-probes fails a synthetic file containing an email address", () => {
  const withEmail = goodProbesContent.replace(
    "Notes about E1.",
    "Notes about E1. Contact synthetic-test-user@example.com for details.",
  );
  const { dir, file } = writeTemp("with-email.md", withEmail);
  try {
    const result = runNode(["scripts/check-probes.mjs", file]);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /synthetic-test-user@example\.com/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-probes fails a synthetic file containing a token", () => {
  const syntheticToken = "sk-" + "a".repeat(40);
  const withToken = goodProbesContent.replace(
    "Notes about S1.",
    `Notes about S1. Example token: ${syntheticToken}`,
  );
  const { dir, file } = writeTemp("with-token.md", withToken);
  try {
    const result = runNode(["scripts/check-probes.mjs", file]);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, new RegExp(syntheticToken));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package.json declares the magic:perf script; magic:acceptance was removed with its missing script", () => {
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  );
  assert.equal(pkg.scripts["magic:acceptance"], undefined);
  assert.equal(pkg.scripts["magic:perf"], "tsx evals/perf/run.ts");
});

test("tsconfig has all eleven path aliases", () => {
  const tsconfig = JSON.parse(
    readFileSync(join(repoRoot, "tsconfig.json"), "utf8"),
  );
  const paths = tsconfig.compilerOptions.paths;
  const expected = [
    "@magic/contracts",
    "@magic/domain",
    "@magic/core",
    "@magic/storage",
    "@magic/connectors",
    "@magic/ai",
    "@magic/learning",
    "@magic/runner",
    "@magic/packs",
    "@magic/retrieval",
    "@magic/agent-api",
  ];
  assert.equal(Object.keys(paths).length, 11);
  for (const alias of expected) {
    assert.ok(paths[alias], `missing alias ${alias}`);
  }
});
