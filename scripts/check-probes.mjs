#!/usr/bin/env node
// Validates a probes markdown file: required sections, verdict lines, and the
// absence of emails/token-like secrets. Never prints the matched secret text,
// only its kind and line number.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED_SECTIONS = ["E1", "K1", "MD1", "S1", "RP1", "RP2", "RP3"];

const targetArg = process.argv[2] ?? "research/probes-2026-09-27.md";
const targetPath = resolve(process.cwd(), targetArg);

const problems = [];

if (!existsSync(targetPath)) {
  console.error(`Probes file not found: ${targetArg} (resolved to ${targetPath})`);
  process.exit(1);
}

const content = readFileSync(targetPath, "utf8");
const lines = content.split(/\r\n|\r|\n/);

// Locate each "## <ID>" heading (ID possibly followed by more text on the
// same line, e.g. "## E1: something").
const headingPattern = /^##\s+(\S+)(?:\s|:|$)/;
const sectionStartLine = new Map();

lines.forEach((line, idx) => {
  const match = headingPattern.exec(line);
  if (match) {
    const id = match[1].replace(/:$/, "");
    if (REQUIRED_SECTIONS.includes(id) && !sectionStartLine.has(id)) {
      sectionStartLine.set(id, idx);
    }
  }
});

for (const id of REQUIRED_SECTIONS) {
  if (!sectionStartLine.has(id)) {
    problems.push(`Missing required section: "## ${id}"`);
  }
}

// For each present required section, find the extent (up to the next "## "
// heading or end of file) and check for a verdict line.
const verdictPattern = /^\*{0,2}Verdict \(\d{4}-\d{2}-\d{2}\):\*{0,2}/;
const allHeadingIndexes = [];
lines.forEach((line, idx) => {
  if (/^##\s+/.test(line)) {
    allHeadingIndexes.push(idx);
  }
});

for (const [id, startIdx] of sectionStartLine) {
  const nextHeadingIdx = allHeadingIndexes.find((idx) => idx > startIdx);
  const endIdx = nextHeadingIdx === undefined ? lines.length : nextHeadingIdx;
  const sectionLines = lines.slice(startIdx, endIdx);
  const hasVerdict = sectionLines.some((line) => verdictPattern.test(line.trim()));
  if (!hasVerdict) {
    problems.push(
      `Section "## ${id}" (starting at line ${startIdx + 1}) is missing a "Verdict (YYYY-MM-DD):" line`,
    );
  }
}

// Secret / PII scanning. Report kind + line number only, never the match text.
const emailPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const bearerPattern = /Bearer\s+\S+/;
const jwtPattern = /\beyJ[A-Za-z0-9_-]{10,}\b/;
const apiKeyPattern = /\b(sk-|ghp_|gho_)[A-Za-z0-9]{10,}\b/;
const longHexOrBase64UrlPattern = /\b[A-Za-z0-9_-]{32,}\b/;

const isPlausibleHexOrBase64 = (candidate) => {
  // Skip words that are just long identifiers with no secret-like entropy
  // shape by requiring the run to actually match hex or base64url charset
  // beyond common words; the regex already restricts to [A-Za-z0-9_-]{32,}.
  return /^[A-Fa-f0-9]{32,}$/.test(candidate) || /^[A-Za-z0-9_-]{32,}$/.test(candidate);
};

lines.forEach((line, idx) => {
  const lineNo = idx + 1;

  if (emailPattern.test(line)) {
    problems.push(`Line ${lineNo}: contains an email address`);
  }

  if (bearerPattern.test(line)) {
    problems.push(`Line ${lineNo}: contains a Bearer token`);
  }

  if (jwtPattern.test(line)) {
    problems.push(`Line ${lineNo}: contains a JWT-like token`);
  }

  if (apiKeyPattern.test(line)) {
    problems.push(`Line ${lineNo}: contains an API-key-like token`);
  }

  const longMatch = longHexOrBase64UrlPattern.exec(line);
  if (longMatch && isPlausibleHexOrBase64(longMatch[0])) {
    problems.push(`Line ${lineNo}: contains a long hex/base64url-like string`);
  }
});

if (problems.length > 0) {
  console.error(`Problems found in ${targetArg}:`);
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  process.exit(1);
}

process.exit(0);
