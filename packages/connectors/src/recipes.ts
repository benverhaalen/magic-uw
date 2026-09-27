/**
 * Site recipes (plan D32 step 4; spec A5): read an external course website's structure once per
 * layout with a model, then replay that structure with code at zero tokens.
 *
 * - `snapshotPage` turns stored HTML into a pruned outline for the model: headings, tables, lists
 *   and heading-delimited sections, each container with a short handle, a few sample rows, and
 *   truncated text. Scripts, styles, forms, navigation and footers are dropped.
 * - `layoutFingerprint` hashes the page's structural skeleton (block tags, table widths, header
 *   labels), never its body text, so a new schedule row keeps the layout and a new column does not.
 * - The model answers `recipeAnswerSchema` only: enums, handles and column numbers. Handles are
 *   mapped to structural paths by code (`compileRecipe`); a recipe never carries page text, so
 *   an instruction inside a page cannot become data the app stores as the model's.
 * - `applyRecipe` is the replay: pure code over the page, returning typed items plus the checks
 *   that failed (paths exist, required fields present, dates parse, links resolve, row counts
 *   plausible). Values always come from the page through code, never from the model.
 *
 * Mechanism adapted from Crawl4AI's `generate_schema` → pure-code replay and Skyvern's cached
 * scripts with a validation gate (research brief P3, "extraction patterns"), without importing
 * either framework.
 */
import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";
import { z } from "zod";
import {
  extractDeadlineMentions,
  identifiersIn,
  type ExtractionAnchors,
} from "../../domain/src/deadline-extraction";
import { cleanLink, sanitizeMaterialContent } from "./external";

export const RECIPE_FORMAT = "site-recipe/v1";

// ---------------------------------------------------------------- the page tree
export interface SiteNode {
  tag: string;
  href?: string;
  colspan?: number;
  /** Structural path from the document root: tag plus index among same-tag siblings. */
  path: string;
  children: (SiteNode | string)[];
}
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Never read: code, styling, forms and controls (the app never submits or clicks), embedded frames. */
const SKIP = new Set([
  "head", "script", "style", "template", "noscript", "svg", "iframe", "canvas", "object",
  "form", "button", "select", "textarea", "input", "option", "dialog",
]);
const BLOCK = new Set([
  "div", "section", "article", "main", "header", "footer", "nav", "aside", "table", "thead", "tbody", "tfoot",
  "tr", "td", "th", "ul", "ol", "li", "dl", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6", "p", "pre",
  "blockquote", "details", "summary", "figure", "caption", "body", "html",
]);
const HEADING = /^h([1-6])$/;
const isNode = (c: SiteNode | string): c is SiteNode => typeof c !== "string";

/** Parse only: markup never executes and cannot start a request. */
export function parseSiteTree(html: string, base: string): { root: SiteNode; title: string } {
  const root: SiteNode = { tag: "#root", path: "", children: [] };
  const stack: (SiteNode | null)[] = [root];
  const counts = new WeakMap<SiteNode, Map<string, number>>();
  let skipping = 0;
  let inTitle = false;
  let title = "";
  new Parser(
    {
      onopentag(name, attrs) {
        if (name === "title") inTitle = true;
        if (skipping || SKIP.has(name) || "hidden" in attrs || attrs["aria-hidden"] === "true") {
          stack.push(null);
          skipping++;
          return;
        }
        const parent = [...stack].reverse().find((n): n is SiteNode => !!n)!;
        const seen = counts.get(parent) ?? new Map<string, number>();
        counts.set(parent, seen);
        const index = seen.get(name) ?? 0;
        seen.set(name, index + 1);
        const node: SiteNode = { tag: name, path: `${parent.path}/${name}.${index}`, children: [] };
        if (name === "a" && attrs.href) {
          const url = cleanLink(attrs.href, base);
          if (url) node.href = url;
        }
        if ((name === "td" || name === "th") && attrs.colspan) {
          const span = Number(attrs.colspan);
          if (Number.isInteger(span) && span > 1) node.colspan = Math.min(span, 50);
        }
        parent.children.push(node);
        stack.push(node);
      },
      ontext(text) {
        if (inTitle) title += text;
        if (skipping) return;
        const parent = [...stack].reverse().find((n): n is SiteNode => !!n)!;
        parent.children.push(text);
      },
      onclosetag(name) {
        if (name === "title") inTitle = false;
        if (stack.length <= 1) return;
        const top = stack.pop();
        if (top === null) skipping = Math.max(0, skipping - 1);
      },
    },
    { decodeEntities: true },
  ).end(sanitizeMaterialContent(html, base));
  return { root, title: title.replace(/\s+/g, " ").trim() };
}

/** Visible text, with a space between blocks, whitespace collapsed. */
export function textOf(node: SiteNode | string): string {
  const parts: string[] = [];
  const walk = (n: SiteNode | string) => {
    if (typeof n === "string") return void parts.push(n);
    if (n.tag === "br") return void parts.push(" ");
    const block = BLOCK.has(n.tag);
    if (block) parts.push(" ");
    n.children.forEach(walk);
    if (block) parts.push(" ");
  };
  walk(node);
  return parts.join("").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}
export function linksOf(node: SiteNode): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = [];
  const walk = (n: SiteNode) => {
    if (n.tag === "a" && n.href && !out.some((l) => l.url === n.href)) out.push({ url: n.href, text: textOf(n).slice(0, 300) });
    n.children.filter(isNode).forEach(walk);
  };
  walk(node);
  return out;
}
function find(root: SiteNode, path: string): SiteNode | undefined {
  if (!path.startsWith("/")) return undefined;
  let node: SiteNode | undefined = root;
  for (const step of path.slice(1).split("/")) {
    const m = /^([a-z][a-z0-9-]*)\.(\d+)$/.exec(step);
    if (!m || !node) return undefined;
    const [, tag, index] = m;
    node = node.children.filter(isNode).filter((c) => c.tag === tag)[Number(index)];
  }
  return node;
}

// ---------------------------------------------------------------- tables, lists, sections
interface TableShape {
  header: string[] | null;
  rows: SiteNode[][];
  width: number;
}
function tableShape(table: SiteNode): TableShape {
  const rows: { cells: SiteNode[]; head: boolean }[] = [];
  const collect = (n: SiteNode, head: boolean) => {
    for (const c of n.children.filter(isNode)) {
      if (c.tag === "tr") {
        const cells = c.children.filter(isNode).filter((x) => x.tag === "td" || x.tag === "th");
        if (cells.length) rows.push({ cells, head: head || cells.every((x) => x.tag === "th") });
      } else if (c.tag === "thead") collect(c, true);
      else if (c.tag === "tbody" || c.tag === "tfoot") collect(c, false);
    }
  };
  collect(table, false);
  const headRow = rows.find((r) => r.head);
  const body = rows.filter((r) => !r.head).map((r) => r.cells);
  const widths = new Map<number, number>();
  for (const r of body) widths.set(r.length, (widths.get(r.length) ?? 0) + 1);
  const width = [...widths.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? headRow?.cells.length ?? 0;
  return { header: headRow ? headRow.cells.map((c) => textOf(c)) : null, rows: body, width };
}
const listItems = (list: SiteNode) => list.children.filter(isNode).filter((c) => c.tag === "li");
/** The heading level that splits a container into sections: the most frequent direct-child heading. */
function sectionLevel(node: SiteNode): number | null {
  const levels = new Map<number, number>();
  for (const c of node.children.filter(isNode)) {
    const m = HEADING.exec(c.tag);
    if (m) levels.set(Number(m[1]), (levels.get(Number(m[1])) ?? 0) + 1);
  }
  const best = [...levels.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return best ? best[0] : null;
}
/** Each heading of `level` with the siblings that follow it, up to the next heading at or above it. */
function sections(node: SiteNode, level: number): { heading: SiteNode; body: SiteNode }[] {
  const out: { heading: SiteNode; body: SiteNode }[] = [];
  let current: { heading: SiteNode; body: SiteNode } | null = null;
  for (const c of node.children) {
    const m = isNode(c) ? HEADING.exec(c.tag) : null;
    if (m && Number(m[1]) <= level) {
      current = Number(m[1]) === level ? { heading: c as SiteNode, body: { tag: "div", path: "", children: [] } } : null;
      if (current) out.push(current);
      continue;
    }
    current?.body.children.push(c);
  }
  return out;
}

/** Headings of one repeated pattern: "Week 1", "Week 2", ... or dated ones. */
function isRepetitive(headings: string[]): boolean {
  if (headings.length < 4) return false;
  const first = new Map<string, number>();
  for (const h of headings) {
    const w = h.toLowerCase().split(/\s+/)[0] ?? "";
    first.set(w, (first.get(w) ?? 0) + 1);
  }
  const top = Math.max(...first.values());
  return top >= headings.length * 0.75 || headings.filter((h) => /\d/.test(h)).length >= headings.length * 0.75;
}
const hasList = (s: { body: SiteNode }) => s.body.children.some((c) => isNode(c) && (c.tag === "ul" || c.tag === "ol"));
/** Sections that mostly hold lists are read item by item (a calendar with a list per week). */
function sectionsHoldLists(parts: { body: SiteNode }[]): boolean {
  return parts.length > 0 && parts.filter(hasList).length >= Math.ceil(parts.length / 2);
}

// ---------------------------------------------------------------- the snapshot
export interface SnapshotBlock {
  handle: string;
  path: string;
  container: "table" | "list" | "sections";
  level: number | null;
}
export interface PageSnapshot {
  /** What the model reads: a pruned outline, never raw HTML. */
  text: string;
  blocks: SnapshotBlock[];
  layoutHash: string;
  title: string;
  /** Rough token counts (4 characters per token, the runner's estimate) for the budget report. */
  htmlTokens: number;
  snapshotTokens: number;
}
const SAMPLE_ROWS = 3;
const CELL = 48;
const ITEM = 64;
const LIST_SAMPLES = 2;
const LINE = 90;
const MAX_BLOCKS = 40;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const tokens = (s: string) => Math.ceil(s.length / 4);
function linkMark(node: SiteNode): string {
  const links = linksOf(node);
  if (!links.length) return "";
  const ext = /\.([a-z0-9]{2,5})$/i.exec(new URL(links[0]!.url).pathname)?.[1]?.toLowerCase();
  return ` [${ext ? `.${ext}` : "link"}${links.length > 1 ? ` +${links.length - 1}` : ""}]`;
}
const cellText = (cell: SiteNode) => `${clip(textOf(cell), CELL)}${linkMark(cell)}` || "—";

export function snapshotPage(html: string, url: string): PageSnapshot & { root: SiteNode } {
  const { root, title } = parseSiteTree(html, url);
  const lines: string[] = [`page: ${clip(title || "(untitled)", LINE)}`, `path: ${clip(new URL(url).pathname, LINE)}`];
  const blocks: SnapshotBlock[] = [];
  const add = (node: SiteNode, container: SnapshotBlock["container"], level: number | null) => {
    const handle = `b${blocks.length}`;
    blocks.push({ handle, path: node.path, container, level });
    return handle;
  };
  const walk = (node: SiteNode, depth: number) => {
    if (blocks.length >= MAX_BLOCKS) return;
    const pad = "";
    if (node.tag === "nav" || node.tag === "footer") return;
    const heading = HEADING.exec(node.tag);
    if (heading) {
      lines.push(`${pad}h${heading[1]} ${clip(textOf(node), LINE)}`);
      return;
    }
    if (node.tag === "table") {
      const shape = tableShape(node);
      if (!shape.rows.length) return;
      lines.push(`${pad}[${add(node, "table", null)}] table ${shape.width} columns, ${shape.rows.length} rows`);
      if (shape.header) lines.push(`${pad}  head: ${shape.header.map((h, i) => `${i}:${clip(h, CELL)}`).join(" | ")}`);
      const sample = shape.rows.filter((r) => r.length === shape.width).slice(0, SAMPLE_ROWS);
      for (const row of sample) lines.push(`${pad}  row: ${row.map((c, i) => `${i}:${cellText(c)}`).join(" | ")}`);
      const odd = shape.rows.find((r) => r.length !== shape.width);
      if (odd) lines.push(`${pad}  other row (${odd.length} cells): ${odd.map(cellText).join(" | ")}`);
      return;
    }
    if (node.tag === "ul" || node.tag === "ol") {
      const items = listItems(node);
      if (!items.length) return;
      lines.push(`${pad}[${add(node, "list", null)}] list ${items.length} items`);
      for (const item of items.slice(0, LIST_SAMPLES)) lines.push(`${pad}  - ${clip(textOf(item), ITEM)}${linkMark(item)}`);
      return;
    }
    const level = sectionLevel(node);
    let repeated = false;
    if (level !== null) {
      const parts = sections(node, level);
      repeated = isRepetitive(parts.map((p) => textOf(p.heading)));
      const holding = sectionsHoldLists(parts) ? ", with lists (code reads each item)" : "";
      lines.push(`${pad}[${add(node, "sections", level)}] ${parts.length} h${level} sections${holding}`);
    }
    // A run of look-alike sections (Week 1, Week 2, ...) shows its first two; the sections block
    // covers the rest. Distinct sections (Homework, Readings, Slides) all show.
    let seen = 0;
    let hidden = 0;
    for (const c of node.children.filter(isNode)) {
      if (repeated && HEADING.exec(c.tag)?.[1] === String(level)) seen++;
      if (repeated && seen > 2) {
        hidden++;
        continue;
      }
      walk(c, BLOCK.has(c.tag) && c.tag !== "div" ? depth + 1 : depth);
    }
    if (hidden) lines.push(`${pad}(+${seen - 2} more sections like these)`);
  };
  walk(root, 0);
  const text = lines.join("\n");
  return {
    root,
    text,
    blocks,
    layoutHash: layoutFingerprint(root),
    title,
    htmlTokens: tokens(html),
    snapshotTokens: tokens(text),
  };
}

/**
 * The structural skeleton's hash. Block tags only (inline markup is transparent); repeated
 * children collapse to their distinct shapes, so added rows or weeks keep the layout; a table
 * keeps its row widths and header labels (stable words such as "Date | Topic"), so a schedule
 * table and an assignment table with the same width do not share a recipe.
 */
export function layoutFingerprint(root: SiteNode): string {
  const shape = (node: SiteNode): string[] => {
    const inner = node.children.filter(isNode).flatMap(shape);
    if (!BLOCK.has(node.tag)) return inner;
    if (/^h[1-6]$|^p$|^pre$/.test(node.tag)) return [node.tag];
    if (node.tag === "tr") return [`tr[${node.children.filter(isNode).filter((c) => c.tag === "td" || c.tag === "th").map((c) => c.tag + (c.colspan ?? "")).join(",")}]`];
    if (node.tag === "td" || node.tag === "th") return [node.tag];
    let label = node.tag;
    if (node.tag === "table") {
      const header = tableShape(node).header;
      if (header) label += `{${header.map((h) => h.toLowerCase().replace(/[^a-z]+/g, " ").trim().slice(0, 30)).join("|")}}`;
    }
    return [`${label}(${[...new Set(inner)].join(",")})`];
  };
  return createHash("sha256").update(RECIPE_FORMAT).update(shape(root).join(",")).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------- the recipe
export const siteItemKinds = ["schedule", "assignment", "reading", "material", "staff", "announcement"] as const;
export type SiteItemKind = (typeof siteItemKinds)[number];
const column = z.number().int().min(0).max(30).nullable();
/** What the model may return: enums, handles and column numbers. No free text reaches storage. */
export const recipeAnswerSchema = z
  .object({
    pageKind: z.enum(["schedule", "assignments", "readings", "materials", "staff", "announcements", "home", "other"]),
    collections: z
      .array(
        z
          .object({
            block: z.string().regex(/^b\d{1,3}$/),
            kind: z.enum([...siteItemKinds, "mixed"]),
            columns: z
              .object({ date: column, title: column, points: column, link: column, detail: column })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type RecipeAnswer = z.infer<typeof recipeAnswerSchema>;
const pathText = z.string().regex(/^(?:\/[a-z][a-z0-9-]*\.\d+)+$/).max(2000);
export const storedRecipeSchema = z
  .object({
    format: z.literal(RECIPE_FORMAT),
    status: z.enum(["valid", "stale", "failed"]),
    pageKind: recipeAnswerSchema.shape.pageKind,
    collections: z
      .array(
        z
          .object({
            path: pathText,
            container: z.enum(["table", "list", "sections"]),
            level: z.number().int().min(1).max(6).nullable(),
            kind: z.enum([...siteItemKinds, "mixed"]),
            columns: recipeAnswerSchema.shape.collections.element.shape.columns,
          })
          .strict(),
      )
      .max(8),
    generatedBy: z.object({ client: z.string().max(50), model: z.string().max(200) }).strict().nullable(),
    tokens: z.object({ in: z.number().int().nonnegative(), out: z.number().int().nonnegative() }).strict(),
    failedAt: z.string().max(40).nullable(),
  })
  .strict();
export type StoredRecipe = z.infer<typeof storedRecipeSchema>;

/** Handles → structural paths. Returns check errors instead of a recipe when a handle is unknown. */
export function compileRecipe(answer: RecipeAnswer, snapshot: Pick<PageSnapshot, "blocks">): { recipe?: Omit<StoredRecipe, "generatedBy" | "tokens" | "status" | "failedAt">; errors: string[] } {
  const errors: string[] = [];
  const collections: StoredRecipe["collections"] = [];
  const used = new Set<string>();
  answer.collections.forEach((c, i) => {
    const block = snapshot.blocks.find((b) => b.handle === c.block);
    if (!block) return void errors.push(`collection ${i}: ${c.block} is not a block in the outline`);
    if (used.has(`${c.block}:${c.kind}`)) return void errors.push(`collection ${i}: ${c.block} is already used for ${c.kind}`);
    used.add(`${c.block}:${c.kind}`);
    if (block.container === "table" && !c.columns) return void errors.push(`collection ${i}: ${c.block} is a table, so give its columns`);
    collections.push({ path: block.path, container: block.container, level: block.level, kind: c.kind, columns: block.container === "table" ? c.columns : null });
  });
  return errors.length ? { errors } : { recipe: { format: RECIPE_FORMAT, pageKind: answer.pageKind, collections }, errors };
}

// ---------------------------------------------------------------- replay
export interface SiteDate {
  value: string;
  precision: "minute" | "day";
  /** The literal date phrase from the page. */
  text: string;
}
export interface SiteItem {
  /** `null`: a mixed collection's row that code could not place; Jev or the student's AI may. */
  kind: SiteItemKind | null;
  title: string;
  /** The row's full visible text, from the page. */
  text: string;
  date: SiteDate | null;
  /** A date-like phrase that did not resolve (no year anchor, weekday mismatch). */
  dateProblem: string | null;
  points: number | null;
  links: { url: string; text: string }[];
  detail: string;
  collection: number;
  index: number;
}
export interface ReplayResult {
  items: SiteItem[];
  /** Failed checks; any error means the recipe does not fit this page. */
  errors: string[];
}

/** Code's date reading, through the domain's bounded deadline grammar; nothing is guessed from now. */
export function parseSiteDate(text: string, anchors: ExtractionAnchors): SiteDate | { problem: string } | null {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 400);
  if (!clean) return null;
  // The whole text first, then its leading clauses: the grammar declines "Sep 2: Topic" (a day
  // followed by a colon reads like a clock time), while "Sep 2" alone is unambiguous.
  const clauses = clean.split(/\s*[:·|—–]\s+|\s+-\s+/).slice(0, 2);
  for (const candidate of [clean, ...clauses]) {
    // The grammar emits a claim only beside deadline language; the cell itself is the date.
    const probe = `Due ${candidate}`;
    const mentions = extractDeadlineMentions({ resourceId: "site", version: 1, contentHash: "site", field: "text", text: probe }, anchors);
    const first = mentions.find((m) => !m.previous);
    if (!first) continue;
    if (!first.value) return { problem: first.unresolvedReason ?? "The date could not be resolved." };
    return { value: first.value, precision: first.precision ?? "minute", text: first.match.text };
  }
  return null;
}
const POINTS = /(\d{1,4}(?:\.\d+)?)\s*(?:pts?|points?|marks?)\b/i;
function pointsIn(text: string): number | null {
  const m = POINTS.exec(text) ?? (/^\s*(\d{1,4}(?:\.\d+)?)\s*$/.exec(text) as RegExpExecArray | null);
  return m ? Number(m[1]) : null;
}
const SEPARATORS = /^[\s\-–—:|,.;·)]+|[\s\-–—:|,.;·(]+$/g;
function titleWithout(text: string, phrase: string | undefined): string {
  let t = phrase ? text.replace(phrase, " ") : text;
  t = t.replace(/\(\s*\d{1,4}(?:\.\d+)?\s*(?:pts?|points?|marks?)\s*\)/gi, " ");
  t = t.replace(/\s+/g, " ").replace(SEPARATORS, "").replace(/\b(?:due|by|on|at)\s*$/i, "").replace(SEPARATORS, "");
  return t.trim();
}
/** A clause break: a dash, colon, bar or middle dot, or a sentence end that is not "Prof." or "Ch.". */
const CLAUSE = /\s[—–|·-]\s|:\s|(?<!\b(?:Prof|Dr|Mr|Mrs|Ms|Ch|Sec|St|No|vs|pp|Vol|al|approx))\.\s/;
/** A list item's label and the rest: the linked text when the item starts with it, else the first clause. */
function splitLabel(text: string, links: { text: string }[]): { title: string; detail: string } {
  const lead = links[0]?.text.trim();
  if (lead && lead.length >= 3 && text.startsWith(lead))
    return { title: lead, detail: text.slice(lead.length).replace(SEPARATORS, "").trim() };
  const m = CLAUSE.exec(text);
  if (!m || m.index < 3) return { title: text, detail: "" };
  return { title: text.slice(0, m.index).replace(SEPARATORS, "").trim(), detail: text.slice(m.index + m[0].length).replace(SEPARATORS, "").trim() };
}

/** Code's own placement for a mixed collection's row; `null` is a leftover for Jev. */
export function placeRow(text: string): SiteItemKind | null {
  if (/\b(?:midterm|final exam|exam)\b/i.test(text) && !/\breview\b/i.test(text)) return "schedule";
  if (identifiersIn(text).length || /\b(?:due|submit|hand in|turn in)\b/i.test(text)) return "assignment";
  if (/\b(?:read(?:ing)?s?|chapters?|ch\.|pp\.)\s/i.test(text)) return "reading";
  if (/\b(?:slides|lecture notes|notes|recording|video|handout)\b/i.test(text)) return "material";
  return null;
}

const MAX_ITEMS = 500;
const REQUIRED: Record<SiteItemKind | "mixed", ("date" | "title" | "link")[]> = {
  schedule: ["date", "title"],
  assignment: ["title"],
  reading: ["title"],
  material: ["title", "link"],
  staff: ["title"],
  announcement: ["title"],
  mixed: ["title"],
};

/**
 * Pure code: applies a stored recipe to a page and checks that it fits. `sameSite` decides
 * which links count as the course's own (others are kept as references, never followed here).
 */
export function applyRecipe(
  root: SiteNode,
  recipe: Pick<StoredRecipe, "collections">,
  anchors: ExtractionAnchors,
): ReplayResult {
  const items: SiteItem[] = [];
  const errors: string[] = [];
  recipe.collections.forEach((c, ci) => {
    const node = find(root, c.path);
    const label = `collection ${ci} (${c.kind})`;
    if (!node) return void errors.push(`${label}: its block is not on this page`);
    const rows: { title: string; text: string; dateText: string; points: number | null; links: { url: string; text: string }[]; detail: string; list?: boolean }[] = [];
    if (c.container === "table") {
      if (node.tag !== "table") return void errors.push(`${label}: the block is not a table`);
      const shape = tableShape(node);
      const cols = c.columns!;
      const used = Object.values(cols).filter((v): v is number => v !== null);
      const outside = used.filter((v) => v >= shape.width);
      if (outside.length) return void errors.push(`${label}: column ${outside[0]} is outside the table's ${shape.width} columns`);
      if (cols.title === null) return void errors.push(`${label}: the title column is required`);
      for (const cells of shape.rows) {
        if (cells.length !== shape.width) continue; // a divider row ("Week 3") spans the table
        const cell = (i: number | null) => (i === null ? null : cells[i]!);
        const titleCell = cell(cols.title)!;
        const linkCell = cell(cols.link);
        rows.push({
          title: textOf(titleCell),
          text: cells.map((x) => textOf(x)).filter(Boolean).join(" | "),
          dateText: cols.date === null ? "" : textOf(cell(cols.date)!),
          points: cols.points === null ? null : pointsIn(textOf(cell(cols.points)!)),
          links: linkCell ? linksOf(linkCell) : linksOf(titleCell).length ? linksOf(titleCell) : [],
          detail: cols.detail === null ? "" : textOf(cell(cols.detail)!),
        });
      }
    } else if (c.container === "list") {
      if (node.tag !== "ul" && node.tag !== "ol") return void errors.push(`${label}: the block is not a list`);
      for (const li of listItems(node)) {
        const text = textOf(li);
        rows.push({ title: "", text, dateText: text, points: pointsIn(text), links: linksOf(li), detail: "", list: true });
      }
    } else {
      const level = c.level ?? sectionLevel(node);
      if (level === null) return void errors.push(`${label}: the block has no repeated headings`);
      const parts = sections(node, level);
      if (sectionsHoldLists(parts)) {
        // A list per section (a calendar with a list per week): each list item is a row.
        for (const s of parts)
          for (const list of s.body.children.filter(isNode).filter((x) => x.tag === "ul" || x.tag === "ol"))
            for (const li of listItems(list)) {
              const text = textOf(li);
              rows.push({ title: "", text, dateText: text, points: pointsIn(text), links: linksOf(li), detail: clip(textOf(s.heading), 200), list: true });
            }
      } else
        for (const s of parts) {
          const head = textOf(s.heading);
          const body = textOf(s.body);
          rows.push({ title: "", text: `${head} ${body}`.trim(), dateText: head, points: pointsIn(body), links: linksOf(s.body).concat(linksOf(s.heading)), detail: clip(body, 600) });
        }
    }
    if (!rows.length) return void errors.push(`${label}: no rows found`);
    if (rows.length > MAX_ITEMS) return void errors.push(`${label}: ${rows.length} rows is more than a course page holds`);
    let dated = 0, dateProblems = 0, withDateText = 0, kept = 0, missingTitle = 0, missingLink = 0;
    const problems: string[] = [];
    rows.forEach((row, index) => {
      const parsed = row.dateText ? parseSiteDate(row.dateText, anchors) : null;
      if (row.dateText && c.container === "table") withDateText++;
      const date = parsed && "value" in parsed ? parsed : null;
      if (date) dated++;
      if (parsed && "problem" in parsed) { dateProblems++; if (problems.length < 2) problems.push(`"${clip(row.dateText, 40)}": ${parsed.problem}`); }
      else if (!parsed && row.dateText && c.container === "table" && problems.length < 2) problems.push(`"${clip(row.dateText, 40)}" is not a date`);
      let title = row.title;
      let detail = row.detail;
      if (row.list) {
        const label = splitLabel(titleWithout(row.text, date?.text), row.links);
        title = label.title || row.links[0]?.text || "";
        detail = label.detail;
      }
      else if (c.container === "sections") title = titleWithout(row.dateText, date?.text) || row.links[0]?.text || "";
      else title = titleWithout(title, undefined);
      title = clip(title, 300);
      if (!title) { missingTitle++; return; }
      if (REQUIRED[c.kind].includes("link") && !row.links.length) missingLink++;
      // Rows without the kind's date are skipped, not errors: a "No class" or holiday row is normal.
      if (REQUIRED[c.kind].includes("date") && !date) return;
      const kind = c.kind === "mixed" ? placeRow(row.text) : c.kind;
      kept++;
      items.push({
        kind,
        title,
        text: clip(row.text, 2000),
        date,
        dateProblem: parsed && "problem" in parsed ? parsed.problem : null,
        points: row.points,
        links: row.links.slice(0, 20),
        detail: clip(detail, 600),
        collection: ci,
        index,
      });
    });
    const total = rows.length;
    // A sparse column (a schedule's "Due" cells) is normal; a column with no labels at all is not.
    if (!kept && !missingLink) errors.push(`${label}: no row has a title${missingTitle ? ` (${missingTitle} empty)` : ""}`);
    if (REQUIRED[c.kind].includes("date") && dated < Math.max(1, Math.ceil(total * 0.5)))
      errors.push(`${label}: only ${dated} of ${total} rows have a date that parses${problems.length ? `, e.g. ${problems.join("; ")}` : ""}`);
    else if (c.container === "table" && c.columns!.date !== null && withDateText >= 3 && dated + dateProblems < withDateText * 0.6)
      errors.push(`${label}: the date column mostly holds text that is not a date${problems.length ? `, e.g. ${problems.join("; ")}` : ""}`);
    if (REQUIRED[c.kind].includes("link") && missingLink > total / 2) errors.push(`${label}: ${missingLink} of ${total} rows have no working link`);
    if (c.kind === "schedule" && kept < 2) errors.push(`${label}: a schedule needs at least 2 dated rows`);
  });
  return { items, errors };
}

/**
 * Stable identity for an item across syncs and recipe versions: page, kind and title (plus an
 * ordinal for repeats). The date is left out, so a moved due date is a change, not a new item.
 */
export function itemKey(pageUrl: string, kind: string, title: string, ordinal = 0): string {
  return createHash("sha256")
    .update(JSON.stringify([pageUrl, kind, title.toLowerCase().replace(/\s+/g, " "), ordinal]))
    .digest("hex")
    .slice(0, 32);
}
