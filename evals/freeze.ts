// N29: freeze and verify evaluation case files (benchmarking rule 1).
//   tsx evals/freeze.ts --write  <dir>   writes <dir>/FROZEN.sha256
//   tsx evals/freeze.ts --verify <dir>   exits non-zero on any changed, missing or extra file
// Line endings are normalised to LF before hashing, so a Windows checkout verifies.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST = "FROZEN.sha256";

export function hashFile(path: string): string {
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function caseFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

export function manifest(dir: string): string {
  return caseFiles(dir)
    .map((f) => `${hashFile(join(dir, f))}  ${f}\n`)
    .join("");
}

export function verify(dir: string): string[] {
  const problems: string[] = [];
  let recorded: Map<string, string>;
  try {
    recorded = new Map(
      readFileSync(join(dir, MANIFEST), "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [hash, file] = line.split(/\s+/, 2);
          return [file!, hash!] as const;
        }),
    );
  } catch {
    return [`${MANIFEST} is missing in ${dir}`];
  }
  const present = caseFiles(dir);
  for (const f of present) {
    const want = recorded.get(f);
    if (!want) problems.push(`${f} is not in the frozen manifest`);
    else if (want !== hashFile(join(dir, f))) problems.push(`${f} changed since it was frozen`);
  }
  for (const f of recorded.keys()) if (!present.includes(f)) problems.push(`${f} is in the manifest but missing`);
  return problems;
}

function main(argv: string[]): number {
  const [mode, dir] = argv;
  if (!dir || (mode !== "--verify" && mode !== "--write")) {
    console.error("usage: tsx evals/freeze.ts --verify|--write <case-dir>");
    return 2;
  }
  if (mode === "--write") {
    writeFileSync(join(dir, MANIFEST), manifest(dir));
    console.log(`froze ${caseFiles(dir).length} case files in ${dir}`);
    return 0;
  }
  const problems = verify(dir);
  for (const p of problems) console.error(`FROZEN mismatch: ${p}`);
  if (!problems.length) console.log(`verified ${caseFiles(dir).length} case files in ${dir}`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && /freeze\.ts$/.test(process.argv[1])) process.exit(main(process.argv.slice(2)));
