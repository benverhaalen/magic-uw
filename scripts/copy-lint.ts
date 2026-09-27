// P16: copy lint for the anti-dark-pattern rules (PI-26, PI-27, PI-29, IP-9;
// course-backend §L: also XP, streak and league copy, since D20 made this a
// study tool, not a game).
//
// Scans the product's own string literals, template strings and JSX text in
// .ts/.tsx files, and string values in .json files. Comments and import paths
// are not product copy. Quoted course text is exempt when it's marked as a
// quote: a `copy-lint: quote` comment on the same or the preceding line, or a
// JSON value under a "quote" key.
//
//   tsx scripts/copy-lint.ts [path ...]   (defaults to the product surfaces below)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

export const DEFAULT_PATHS = [
  "packages/learning/src",
  "packages/packs",
  "apps/desktop/src/renderer/notebook",
  "apps/desktop/src/renderer/practice",
  "apps/desktop/src/renderer/insights",
  "apps/desktop/src/renderer/backend/mastery", // owner: mastery (D57)
  "apps/desktop/src/renderer/study-prep", // owner: study-prep
];

export interface Rule {
  id: string;
  pattern: RegExp;
}

export const RULES: Rule[] = [
  // PI-26 fake urgency
  { id: "urgency", pattern: /\bonly\s+(?:\S+\s+){0,3}?left\b/i },
  { id: "urgency", pattern: /\bhurry\b/i },
  { id: "urgency", pattern: /\b(?:last chance|act now|time is running out|running out of time|before it'?s too late|don'?t miss out)\b/i },
  { id: "urgency", pattern: /\b(?:ends|expires|closing)\s+in\s+\d/i },
  // PI-27 guilt and shame
  { id: "guilt", pattern: /\bdon'?t\s+lose\b/i },
  { id: "guilt", pattern: /\b(?:you'?re|you are)\s+falling\s+behind\b/i },
  { id: "guilt", pattern: /\bwe\s+miss\s+you\b/i },
  { id: "guilt", pattern: /\bdisappoint(?:ed|ing)?\b/i },
  { id: "guilt", pattern: /\b(?:shame|ashamed|you failed)\b/i },
  { id: "guilt", pattern: /(?::-?\(|☹|🙁|😢|😞|😭)/u },
  // D20: no game mechanics (XP, streaks, freezes, hearts, lives)
  { id: "game", pattern: /\bstreaks?\b/i },
  { id: "game", pattern: /\bXP\b/ },
  { id: "game", pattern: /\bexperience points\b/i },
  { id: "game", pattern: /\b(?:hearts|lives)\s+(?:left|remaining)\b/i },
  // PI-29 leagues and leaderboards
  { id: "ranking", pattern: /\b(?:leagues?|leaderboards?)\b/i },
  { id: "ranking", pattern: /\b(?:top|bottom)\s+\d+\s*%/i },
  { id: "ranking", pattern: /\bbetter than\s+\d+\s*%/i },
  // IP-9 readiness, pass probability, predicted score, percentage of mastery
  { id: "readiness", pattern: /\b(?:predicted|projected|expected|estimated)\s+(?:score|grade|mark)\b/i },
  { id: "readiness", pattern: /\b(?:chance|probability|likelihood|odds)\s+of\s+passing\b/i },
  { id: "readiness", pattern: /\bpass(?:ing)?\s+(?:probability|chance|likelihood)\b/i },
  { id: "readiness", pattern: /\b(?:you'?re|you are)\s+(?:\w+\s+)?ready\b/i },
  { id: "readiness", pattern: /\bready\s+for\s+(?:the\s+|your\s+)?(?:exam|test|midterm|final|quiz)\b/i },
  { id: "readiness", pattern: /\byou\s+will\s+pass\b/i },
  { id: "readiness", pattern: /\d+(?:\.\d+)?\s*%\s*(?:mastered|mastery|ready|readiness|prepared)\b/i },
  { id: "readiness", pattern: /\b(?:mastery|readiness)\s*(?:score|level)?\s*[:=]?\s*\d+(?:\.\d+)?\s*%/i },
];

export interface Finding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

const QUOTE_MARK = /copy-lint:\s*quote/;

function check(text: string, file: string, line: number, out: Finding[]): void {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) out.push({ file, line, rule: rule.id, text: text.length > 120 ? text.slice(0, 117) + "..." : text });
  }
}

export function lintSource(file: string, source: string): Finding[] {
  const out: Finding[] = [];
  const lines = source.split(/\r?\n/);
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const marked = (node: ts.Node) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    const prev = lines[line - 1] ?? "";
    return QUOTE_MARK.test(lines[line] ?? "") || (/^\s*(?:\/\/|\/\*|\*)/.test(prev) && QUOTE_MARK.test(prev));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExternalModuleReference(node)) return;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return;
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) text = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" … ");
    else if (ts.isJsxText(node)) text = node.text.trim() || null;
    if (text !== null && !marked(node)) check(text, file, sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, out);
    if (!ts.isTemplateExpression(node)) ts.forEachChild(node, visit);
    else node.templateSpans.forEach((s) => visit(s.expression));
  };
  visit(sf);
  return out;
}

export function lintJson(file: string, source: string): Finding[] {
  const out: Finding[] = [];
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    return [{ file, line: 1, rule: "parse", text: "invalid JSON" }];
  }
  const walk = (v: unknown, key: string | null): void => {
    if (typeof v === "string") {
      if (key !== "quote") check(v, file, 1, out);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(data, null);
  return out;
}

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((d) =>
    d.name === "node_modules" ? [] : d.isDirectory() ? files(join(path, d.name)) : [join(path, d.name)],
  );
}

export function lintPaths(paths: string[]): Finding[] {
  const out: Finding[] = [];
  for (const f of paths.flatMap(files)) {
    if (/\.(?:ts|tsx)$/.test(f) && !f.endsWith(".d.ts")) out.push(...lintSource(f, readFileSync(f, "utf8")));
    else if (f.endsWith(".json") && !f.endsWith("package.json")) out.push(...lintJson(f, readFileSync(f, "utf8")));
  }
  return out;
}

function main(argv: string[]): number {
  const paths = argv.length ? argv : DEFAULT_PATHS;
  const findings = lintPaths(paths);
  for (const f of findings) console.error(`${relative(process.cwd(), f.file)}:${f.line}: [${f.rule}] ${JSON.stringify(f.text)}`);
  console.log(`copy-lint: ${findings.length} finding(s) in ${paths.join(", ")}`);
  return findings.length ? 1 : 0;
}

if (process.argv[1] && /copy-lint\.ts$/.test(process.argv[1])) process.exit(main(process.argv.slice(2)));
