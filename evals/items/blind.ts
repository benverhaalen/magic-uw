/**
 * The blind rubric step (measurement plan MS4, the rubric in rubric.json) for the bench-judge
 * seat or human raters.
 *
 *   export  tsx evals/items/blind.ts export --ours <run>/items.jsonl --ours-family <family>
 *             [--theirs <file> --theirs-format quizlet|csv --theirs-name <tool> --theirs-family <family>]
 *             [--reference <course text file>] [--seed <n>] [--limit <n per system>] --out <dir>
 *   score   tsx evals/items/blind.ts score --export <dir> --ratings <file.jsonl> [--ratings <file2.jsonl>]
 *
 * The export shuffles every item from every system into one set with no system name, no quote
 * and one format; it pairs items across systems by shared words and presents every pair in
 * both orders. Which system wrote what is sealed in <dir>/sealed/ until `score`. The scorer
 * refuses an LLM rater of the same model family as any generator in the set, reports each rate
 * with a Wilson interval, order-swap consistency, and (with two raters) Cohen's kappa per
 * dimension, quadratic-weighted for the ordinal scale.
 *
 * Exports and scores hold course text: write them under .data/ (gitignored), never commit them.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cohenKappa, formatRate, kappaBand, prng, rate, shuffle, type Rate } from "./stats";

export const RUBRIC_PATH = join(import.meta.dirname, "rubric.json");
interface Rubric {
  scale: number[];
  acceptable: number;
  dimensions: { id: string; question: string; anchors: Record<string, string>; na: boolean }[];
  pairwise: { question: string; orderSwap: string };
  raters: { rules: string[]; agreement: string };
}
export const loadRubric = (): Rubric => JSON.parse(readFileSync(RUBRIC_PATH, "utf8")) as Rubric;

/** One item as a rater sees it: no system, no quote, one format. */
export interface BlindItem {
  kind: "card" | "question";
  prompt: string;
  options: string[] | null;
  answer: string;
}
interface SourcedItem {
  system: string;
  ref: string;
  item: BlindItem;
}

const BLANK = /_{3,}/g;
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
/** One surface for every system: collapsed whitespace, one blank marker, no trailing spaces. */
export function normalise(item: BlindItem): BlindItem {
  return {
    kind: item.kind,
    prompt: clean(item.prompt).replace(BLANK, "____"),
    options: item.options ? item.options.map(clean) : null,
    answer: clean(item.answer),
  };
}

/** Our items from a harness run's items.jsonl. */
export function ourItems(jsonl: string, system: string): SourcedItem[] {
  return jsonl
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { item: { id: string; kind: string; stem: string; options: { id: string; text: string }[] | null; key: string | number; unit: string | null } })
    .map(({ item }) => {
      const choice = item.options && (item.kind === "mc" || item.kind === "tf");
      const keyText = choice ? (item.options!.find((o) => o.id === item.key)?.text ?? String(item.key)) : `${item.key}${item.unit ? ` ${item.unit}` : ""}`;
      return {
        system,
        ref: item.id,
        item: normalise({
          kind: item.kind === "card" || item.kind === "cloze" ? "card" : "question",
          prompt: item.stem,
          options: choice ? item.options!.map((o) => o.text) : null,
          answer: keyText,
        }),
      };
    });
}

/** RFC 4180-style parsing with a chosen delimiter: quoted fields, doubled quotes, newlines in quotes. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (text.startsWith(delimiter, i)) {
      row.push(field);
      field = "";
      i += delimiter.length - 1;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

/**
 * Another tool's items.
 * - `quizlet`: one card per row, front then back, tab-separated by default (Quizlet's export
 *   dialog lets the user choose the separators; pass --delimiter to match what was chosen).
 * - `csv`: a header row. Cards: front,back (or term,definition). Questions: question, the
 *   options (a,b,c,d or option_a..option_d or option1..), and answer (the letter or the text).
 */
export function theirItems(text: string, format: "quizlet" | "csv", system: string, delimiter?: string): SourcedItem[] {
  if (format === "quizlet")
    return parseDelimited(text, delimiter ?? "\t")
      .filter((r) => r.length >= 2 && r[0]!.trim() && r[1]!.trim())
      .map((r, i) => ({ system, ref: `row-${i + 1}`, item: normalise({ kind: "card", prompt: r[0]!, options: null, answer: r[1]! }) }));
  const rows = parseDelimited(text, delimiter ?? ",");
  const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const front = col("front", "term", "prompt");
  const back = col("back", "definition");
  const question = col("question", "stem");
  const answer = col("answer", "correct", "key");
  const optionCols = header.map((h, i) => (/^(option[ _]?)?([a-f]|[1-6])$/.test(h) ? i : -1)).filter((i) => i >= 0);
  return rows.flatMap((r, i): SourcedItem[] => {
    const ref = `row-${i + 2}`;
    if (question >= 0 && answer >= 0) {
      const options = optionCols.map((c) => r[c] ?? "").filter((o) => o.trim());
      const raw = (r[answer] ?? "").trim();
      const letter = /^[a-f]$/i.test(raw) ? options[raw.toLowerCase().charCodeAt(0) - 97] : /^[1-6]$/.test(raw) ? options[Number(raw) - 1] : undefined;
      if (!r[question]?.trim() || !raw) return [];
      return [{ system, ref, item: normalise({ kind: "question", prompt: r[question]!, options: options.length ? options : null, answer: letter ?? raw }) }];
    }
    if (front >= 0 && back >= 0 && r[front]?.trim() && r[back]?.trim())
      return [{ system, ref, item: normalise({ kind: "card", prompt: r[front]!, options: null, answer: r[back]! }) }];
    return [];
  });
}

const words = (item: BlindItem) => new Set(`${item.prompt} ${item.answer}`.toLowerCase().match(/\p{L}{4,}/gu) ?? []);
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/** Greedy cross-system pairs by shared words, so a pair compares items on the same topic. */
export function pairItems(a: SourcedItem[], b: SourcedItem[]): [SourcedItem, SourcedItem][] {
  const left = a.map((x) => ({ x, w: words(x.item) }));
  const right = b.map((x) => ({ x, w: words(x.item), used: false }));
  const out: [SourcedItem, SourcedItem][] = [];
  const candidates: { i: number; j: number; s: number }[] = [];
  left.forEach((l, i) => right.forEach((r, j) => candidates.push({ i, j, s: jaccard(l.w, r.w) })));
  candidates.sort((p, q) => q.s - p.s || p.i - q.i || p.j - q.j);
  const usedLeft = new Set<number>();
  for (const c of candidates) {
    if (usedLeft.has(c.i) || right[c.j]!.used) continue;
    usedLeft.add(c.i);
    right[c.j]!.used = true;
    out.push([left[c.i]!.x, right[c.j]!.x]);
  }
  return out;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const id = (random: () => number) => Math.floor(random() * 0xffffffff).toString(16).padStart(8, "0");

export interface ExportOptions {
  ours: SourcedItem[];
  theirs: SourcedItem[];
  generatorFamilies: Record<string, string>;
  seed: number;
  limit?: number;
  reference?: { name: string; text: string };
  out: string;
  now?: string;
}

export function exportBlind(o: ExportOptions): { tasks: number; pairs: number } {
  const rubric = loadRubric();
  const random = prng(o.seed);
  const take = (xs: SourcedItem[]) => (o.limit ? shuffle(xs, random).slice(0, o.limit) : xs);
  const ours = take(o.ours);
  const theirs = take(o.theirs);
  const all = shuffle([...ours, ...theirs], random);
  const taken = new Set<string>();
  const newId = (prefix: string) => {
    let v: string;
    do v = `${prefix}${id(random)}`;
    while (taken.has(v));
    taken.add(v);
    return v;
  };
  const tasks = all.map((s) => ({ taskId: newId("t"), item: s.item, source: s }));
  const pairs = pairItems(ours, theirs).flatMap(([x, y]) => {
    const pairId = newId("p");
    // Both orders, each placed independently in the shuffled list.
    return [
      { pairId, order: "AB" as const, A: x, B: y },
      { pairId, order: "BA" as const, A: y, B: x },
    ];
  });
  const shuffledPairs = shuffle(pairs, random);
  mkdirSync(join(o.out, "sealed"), { recursive: true });
  const tasksJsonl = tasks.map((t) => JSON.stringify({ taskId: t.taskId, item: t.item })).join("\n") + (tasks.length ? "\n" : "");
  const pairsJsonl = shuffledPairs.map((p) => JSON.stringify({ pairId: p.pairId, order: p.order, A: p.A.item, B: p.B.item })).join("\n") + (pairs.length ? "\n" : "");
  writeFileSync(join(o.out, "tasks.jsonl"), tasksJsonl);
  writeFileSync(join(o.out, "pairs.jsonl"), pairsJsonl);
  const rubricMd = renderRubric(rubric);
  writeFileSync(join(o.out, "rubric.md"), rubricMd);
  writeFileSync(join(o.out, "judge-brief.md"), judgeBrief(rubric, Boolean(o.reference)));
  if (o.reference) writeFileSync(join(o.out, "reference.txt"), o.reference.text);
  writeFileSync(
    join(o.out, "sealed", "key.json"),
    JSON.stringify(
      {
        tasks: Object.fromEntries(tasks.map((t) => [t.taskId, { system: t.source.system, ref: t.source.ref }])),
        pairs: Object.fromEntries(pairs.filter((p) => p.order === "AB").map((p) => [p.pairId, { AB: { A: p.A.system, B: p.B.system }, refs: [p.A.ref, p.B.ref] }])),
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(o.out, "manifest.json"),
    JSON.stringify(
      {
        schema: "magic-item-blind/1",
        createdAt: o.now ?? new Date().toISOString(),
        seed: o.seed,
        systems: [...new Set(all.map((s) => s.system))].length,
        generatorFamilies: Object.values(o.generatorFamilies),
        counts: { tasks: tasks.length, pairs: pairs.length / 2 },
        sha256: { tasks: sha(tasksJsonl), pairs: sha(pairsJsonl), rubric: sha(readFileSync(RUBRIC_PATH, "utf8").replace(/\r\n/g, "\n")) },
        reference: o.reference?.name ?? null,
      },
      null,
      2,
    ),
  );
  return { tasks: tasks.length, pairs: pairs.length / 2 };
}

function renderRubric(r: Rubric): string {
  const lines = ["# Item rubric (pre-registered)", "", `Scale 1-4; ${r.acceptable} or above is acceptable.`, ""];
  for (const d of r.dimensions) {
    lines.push(`## ${d.id}${d.na ? " (multiple choice only; otherwise na)" : ""}`, "", d.question, "");
    for (const [k, v] of Object.entries(d.anchors)) lines.push(`- **${k}**: ${v}`);
    lines.push("");
  }
  lines.push("## Pairwise", "", r.pairwise.question, "", r.pairwise.orderSwap, "");
  return lines.join("\n");
}

function judgeBrief(r: Rubric, reference: boolean): string {
  return [
    "# Brief for the rater (bench-judge seat or a human)",
    "",
    `Rate every line of tasks.jsonl on the rubric in rubric.md${reference ? ", against reference.txt (the course material both systems were given)" : ""}. Then answer every line of pairs.jsonl.`,
    "",
    "Rules:",
    ...r.raters.rules.map((x) => `- ${x}`),
    "- The items carry no system name on purpose. Never guess which system wrote an item, and never open sealed/.",
    "- A pair appears twice, once in each order. Judge each presentation on its own.",
    "",
    "Write one JSON object per line to ratings.jsonl:",
    "",
    "```",
    '{"taskId":"t…","rater":{"id":"r1","kind":"llm","family":"openai","model":"…"},"scores":{"accuracy":4,"clarity":3,"examRelevance":3,"difficultyFit":3,"distractorQuality":"na"}}',
    '{"pairId":"p…","order":"AB","rater":{"id":"r1","kind":"llm","family":"openai","model":"…"},"preferred":"A"}',
    "```",
    "",
    "`kind` is `human` or `llm`; an LLM rater names its model family (anthropic, openai, google, meta, …).",
    "",
  ].join("\n");
}

// ---------- scoring ----------

export interface Rater {
  id: string;
  kind: "human" | "llm";
  family?: string;
  model?: string;
}
type Score = number | "na";
export interface TaskRating {
  taskId: string;
  rater: Rater;
  scores: Record<string, Score>;
}
export interface PairRating {
  pairId: string;
  order: "AB" | "BA";
  rater: Rater;
  preferred: "A" | "B" | "tie";
}
export class RefusedError extends Error {}

export function readRatings(text: string): { tasks: TaskRating[]; pairs: PairRating[] } {
  const tasks: TaskRating[] = [];
  const pairs: PairRating[] = [];
  for (const line of text.split(/\r?\n/).filter((l) => l.trim())) {
    const r = JSON.parse(line) as Partial<TaskRating & PairRating>;
    if (!r.rater || typeof r.rater.id !== "string" || (r.rater.kind !== "human" && r.rater.kind !== "llm")) throw new Error(`a rating without a valid rater: ${line.slice(0, 120)}`);
    if (typeof r.taskId === "string" && r.scores) tasks.push(r as TaskRating);
    else if (typeof r.pairId === "string" && (r.order === "AB" || r.order === "BA") && ["A", "B", "tie"].includes(String(r.preferred))) pairs.push(r as PairRating);
    else throw new Error(`a rating line that is neither a task nor a pair rating: ${line.slice(0, 120)}`);
  }
  return { tasks, pairs };
}

/** MT4's negative check: an LLM rater of a generator's model family is refused. */
export function checkRaters(raters: Rater[], generatorFamilies: string[]): void {
  const families = new Set(generatorFamilies.map((f) => f.toLowerCase()));
  for (const r of raters) {
    if (r.kind !== "llm") continue;
    if (!r.family) throw new RefusedError(`LLM rater ${r.id} names no model family; the generator/judge family rule can't be checked.`);
    if (families.has(r.family.toLowerCase())) throw new RefusedError(`LLM rater ${r.id} is ${r.family}, the same model family as a generator in this set. Use a different family or a human rater.`);
  }
}

export interface ScoreResult {
  perSystem: Record<string, Record<string, { n: number; mean: number | null; acceptable: Rate }>>;
  pairwise: { pairs: number; swapConsistent: Rate; preference: Record<string, Rate>; ties: number } | null;
  agreement: { dimension: string; n: number; kappa: number | null; band: string; weights: string }[];
  raters: Rater[];
}

export function scoreBlind(exportDir: string, ratingFiles: string[]): ScoreResult {
  const rubric = loadRubric();
  const manifest = JSON.parse(readFileSync(join(exportDir, "manifest.json"), "utf8")) as { generatorFamilies: string[] };
  const key = JSON.parse(readFileSync(join(exportDir, "sealed", "key.json"), "utf8")) as {
    tasks: Record<string, { system: string }>;
    pairs: Record<string, { AB: { A: string; B: string } }>;
  };
  const sets = ratingFiles.map((f) => readRatings(readFileSync(f, "utf8")));
  const raters = [...new Map(sets.flatMap((s) => [...s.tasks, ...s.pairs].map((r) => [r.rater.id, r.rater]))).values()];
  checkRaters(raters, manifest.generatorFamilies);

  // Absolute ratings per system and dimension (first rating file is the primary rater).
  const primary = sets[0] ?? { tasks: [], pairs: [] };
  const perSystem: ScoreResult["perSystem"] = {};
  for (const d of rubric.dimensions) {
    const bySystem = new Map<string, number[]>();
    for (const r of primary.tasks) {
      const system = key.tasks[r.taskId]?.system;
      const v = r.scores[d.id];
      if (!system || typeof v !== "number") continue;
      if (!rubric.scale.includes(v)) throw new Error(`task ${r.taskId}: ${d.id} = ${v} is outside the scale`);
      bySystem.set(system, [...(bySystem.get(system) ?? []), v]);
    }
    for (const [system, vs] of bySystem) {
      perSystem[system] ??= {};
      perSystem[system]![d.id] = { n: vs.length, mean: vs.reduce((a, v) => a + v, 0) / vs.length, acceptable: rate(vs.filter((v) => v >= rubric.acceptable).length, vs.length) };
    }
  }

  // Pairwise with order swap: map each presentation's verdict to a system, then compare orders.
  let pairwise: ScoreResult["pairwise"] = null;
  if (primary.pairs.length) {
    const verdicts = new Map<string, Partial<Record<"AB" | "BA", string>>>();
    for (const p of primary.pairs) {
      const k = key.pairs[p.pairId];
      if (!k) continue;
      const [a, b] = p.order === "AB" ? [k.AB.A, k.AB.B] : [k.AB.B, k.AB.A];
      const winner = p.preferred === "tie" ? "tie" : p.preferred === "A" ? a : b;
      verdicts.set(p.pairId, { ...verdicts.get(p.pairId), [p.order]: winner });
    }
    const complete = [...verdicts.values()].filter((v) => v.AB && v.BA);
    const consistent = complete.filter((v) => v.AB === v.BA);
    const decided = consistent.filter((v) => v.AB !== "tie");
    const systems = [...new Set(Object.values(key.pairs).flatMap((p) => [p.AB.A, p.AB.B]))];
    pairwise = {
      pairs: complete.length,
      swapConsistent: rate(consistent.length, complete.length),
      preference: Object.fromEntries(systems.map((s) => [s, rate(decided.filter((v) => v.AB === s).length, decided.length)])),
      ties: consistent.length - decided.length,
    };
  }

  // Two raters: Cohen's kappa per dimension on the tasks both rated (quadratic-weighted: ordinal).
  const agreement: ScoreResult["agreement"] = [];
  if (sets.length >= 2) {
    const [x, y] = [sets[0]!, sets[1]!];
    for (const d of rubric.dimensions) {
      const ys = new Map(y.tasks.map((r) => [r.taskId, r.scores[d.id]]));
      const a: number[] = [];
      const b: number[] = [];
      for (const r of x.tasks) {
        const u = r.scores[d.id];
        const v = ys.get(r.taskId);
        if (typeof u === "number" && typeof v === "number") {
          a.push(u);
          b.push(v);
        }
      }
      const k = cohenKappa(a, b, rubric.scale, "quadratic");
      agreement.push({ dimension: d.id, n: a.length, kappa: k, band: kappaBand(k), weights: "quadratic" });
    }
    const yp = new Map(y.pairs.map((p) => [`${p.pairId}|${p.order}`, p.preferred]));
    const a: string[] = [];
    const b: string[] = [];
    for (const p of x.pairs) {
      const v = yp.get(`${p.pairId}|${p.order}`);
      if (v) {
        a.push(p.preferred);
        b.push(v);
      }
    }
    const k = cohenKappa(a, b, ["A", "B", "tie"], "none");
    agreement.push({ dimension: "pairwise", n: a.length, kappa: k, band: kappaBand(k), weights: "none" });
  }
  return { perSystem, pairwise, agreement, raters };
}

export function renderScore(s: ScoreResult): string {
  const lines = ["# Blind rubric scores", "", `Raters: ${s.raters.map((r) => `${r.id} (${r.kind}${r.family ? `, ${r.family}` : ""}${r.model ? `, ${r.model}` : ""})`).join("; ")}`, ""];
  lines.push("| System | Dimension | n | Mean (1-4) | Acceptable (>= 3; Wilson 95% CI) |", "|---|---|---|---|---|");
  for (const [system, dims] of Object.entries(s.perSystem))
    for (const [d, v] of Object.entries(dims)) lines.push(`| ${system} | ${d} | ${v.n} | ${v.mean?.toFixed(2) ?? "-"} | ${formatRate(v.acceptable)} |`);
  if (s.pairwise) {
    lines.push("", "## Pairwise (each pair shown in both orders)", "", `- Pairs with both orders rated: ${s.pairwise.pairs}`, `- Swap-consistent verdicts: ${formatRate(s.pairwise.swapConsistent)}`);
    for (const [system, r] of Object.entries(s.pairwise.preference)) lines.push(`- Preferred ${system} (of consistent, non-tie pairs): ${formatRate(r)}`);
    lines.push(`- Consistent ties: ${s.pairwise.ties}`);
  }
  if (s.agreement.length) {
    lines.push("", "## Agreement between two raters", "", "| Dimension | n | Cohen's kappa | Weights | Band (Landis and Koch) |", "|---|---|---|---|---|");
    for (const a of s.agreement) lines.push(`| ${a.dimension} | ${a.n} | ${a.kappa === null ? "undefined" : a.kappa.toFixed(2)} | ${a.weights} | ${a.band} |`);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------- CLI ----------

function args(argv: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++)
    if (argv[i]!.startsWith("--")) {
      const k = argv[i]!.slice(2);
      out.set(k, [...(out.get(k) ?? []), argv[i + 1] ?? ""]);
      i++;
    }
  return out;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const a = args(rest);
  const one = (k: string) => a.get(k)?.[0];
  if (command === "export") {
    const oursPath = one("ours");
    const out = one("out");
    const oursFamily = one("ours-family");
    if (!oursPath || !out || !oursFamily) {
      console.error("usage: blind.ts export --ours <items.jsonl> --ours-family <family> [--theirs <file> --theirs-format quizlet|csv --theirs-name <tool> --theirs-family <family> --delimiter <sep>] [--reference <file>] [--seed <n>] [--limit <n>] --out <dir>");
      return 2;
    }
    const ours = ourItems(readFileSync(oursPath, "utf8"), "magic");
    const theirsPath = one("theirs");
    const theirsName = one("theirs-name") ?? (theirsPath ? basename(theirsPath) : "other");
    const format = (one("theirs-format") ?? "csv") as "quizlet" | "csv";
    const delimiter = one("delimiter")?.replace("\\t", "\t");
    const theirs = theirsPath ? theirItems(readFileSync(theirsPath, "utf8"), format, theirsName, delimiter) : [];
    const families: Record<string, string> = { magic: oursFamily };
    if (theirsPath) families[theirsName] = one("theirs-family") ?? "unknown";
    const referencePath = one("reference");
    const r = exportBlind({
      ours,
      theirs,
      generatorFamilies: families,
      seed: Number(one("seed") ?? Date.now() % 2 ** 31),
      ...(one("limit") ? { limit: Number(one("limit")) } : {}),
      ...(referencePath ? { reference: { name: basename(referencePath), text: readFileSync(referencePath, "utf8") } } : {}),
      out,
    });
    console.log(`exported ${r.tasks} tasks and ${r.pairs} pairs (each in both orders) to ${out}; the key is in ${join(out, "sealed")}`);
    return 0;
  }
  if (command === "score") {
    const dir = one("export");
    const ratings = a.get("ratings") ?? [];
    if (!dir || !ratings.length) {
      console.error("usage: blind.ts score --export <dir> --ratings <file.jsonl> [--ratings <file2.jsonl>]");
      return 2;
    }
    try {
      const s = scoreBlind(dir, ratings);
      writeFileSync(join(dir, "score.json"), JSON.stringify(s, null, 2));
      const md = renderScore(s);
      writeFileSync(join(dir, "score.md"), md);
      console.log(md);
      return 0;
    } catch (error) {
      if (error instanceof RefusedError) {
        console.error(`refused: ${error.message}`);
        return 3;
      }
      throw error;
    }
  }
  console.error("usage: blind.ts export|score …");
  return 2;
}

if (process.argv[1] && /blind\.ts$/.test(process.argv[1])) process.exit(main(process.argv.slice(2)));
