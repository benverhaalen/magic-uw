import { Parser } from "htmlparser2";
import { planningCaptureSchema, type PlanningCapture, type PlanningRecord, type PlanningSubject } from "@magic/contracts";
import { decodeUwTerm } from "../../domain/src/planning";
import type { PublicClient } from "./network";

type Node = { href?: string; tag: string; classes: string[]; children: (Node | string)[] };
function document(html: string): Node {
  if (Buffer.byteLength(html) > 2_000_000) throw new Error("Public page exceeds the parsing limit.");
  const root: Node = { tag: "root", classes: [], children: [] }, stack = [root];
  new Parser({
    onopentag(tag, attrs) {
      const node: Node = { tag, href: attrs.href, classes: (attrs.class ?? "").split(/\s+/), children: [] };
      stack.at(-1)!.children.push(node); stack.push(node);
    },
    ontext(text) { if (!["script", "style"].includes(stack.at(-1)!.tag)) stack.at(-1)!.children.push(text); },
    onclosetag() { if (stack.length > 1) stack.pop(); },
  }, { decodeEntities: true }).end(html);
  return root;
}
const clean = (value: string) => value.replace(/[\u200b\u00ad]/g, "").replace(/\s+/g, " ").trim();
function content(node: Node): string {
  if (["script", "style"].includes(node.tag)) return "";
  return node.children.map((child) => typeof child === "string" ? child : child.tag === "br" ? "\n" : content(child)).join("");
}
function select(node: Node, match: (node: Node) => boolean): Node[] {
  return node.children.flatMap((child) => typeof child === "string" ? [] : match(child) ? [child] : select(child, match));
}
const cls = (node: Node, value: string) => select(node, (n) => n.classes.includes(value));
const key = (value: string) => clean(value).toUpperCase().replace(/\s/g, "");
const subjectsUrl = "https://registrar.wisc.edu/subjectareas/";
const termsUrl = "https://registrar.wisc.edu/sessioncodes/";

/** Published session rows corroborate term identity, not the complete course-search term list. */
export function parsePublicTerms(html: string, observedAt: string): PlanningCapture {
  const scope = { kind: "terms" as const, key: "registrar-session-terms" };
  const provenance = { sourceUrl: termsUrl, observedAt, scope };
  const terms = new Map<string, PlanningRecord>();
  const conflicted = new Set<string>();
  let invalid = 0;
  for (const table of select(document(html), (node) => node.tag === "table")) {
    const rows = select(table, (node) => node.tag === "tr");
    const header = rows.map((row) => select(row, (node) => node.tag === "th").map((node) => clean(content(node)).toLowerCase()))
      .find((cells) => cells.includes("term") && cells.includes("session"));
    if (!header) continue;
    const column = header.indexOf("term");
    const bodies = select(table, (node) => node.tag === "tbody");
    const dataRows = bodies.length ? bodies.flatMap((body) => select(body, (node) => node.tag === "tr")) : rows;
    for (const row of dataRows) {
      const cells = select(row, (node) => node.tag === "td");
      if (!cells.length) continue;
      const value = cells[column] ? clean(content(cells[column])) : "";
      const pair = /^(\d{4})\s*:\s*(.+)$/.exec(value);
      if (!pair) { invalid++; continue; }
      let term;
      try { term = decodeUwTerm(pair[1]); }
      catch { invalid++; continue; }
      const label = /^(fall|spring|summer)\s+(\d{4})(?:\s*[-–]\s*(\d{4}))?$/i.exec(pair[2]);
      const matches = label && label[1].toLowerCase() === term.season && (
        label[3]
          ? Number(label[2]) === term.academicYear - 1 && Number(label[3]) === term.academicYear
          : Number(label[2]) === term.year
      );
      if (!matches) {
        invalid++;
        conflicted.add(term.code);
        continue;
      }
      terms.set(term.code, {
        kind: "term", id: term.code, code: term.code, season: term.season,
        year: term.year, label: term.label, past: null, provenance,
      });
    }
  }
  // A contradictory label cannot be silently outvoted by repeated session rows for the same code.
  for (const code of conflicted) terms.delete(code);
  const records = [...terms.values()].sort((a, b) => a.id.localeCompare(b.id));
  return planningCaptureSchema.parse({
    schemaVersion: 1, id: `registrar-terms-${observedAt}`, accountScope: "public", source: "uw_public",
    scope, sourceUrl: termsUrl, observedAt, status: records.length ? "partial" : "failed",
    completeness: records.length ? "partial" : "unknown", records,
    diagnostics: [
      { code: records.length ? "registrar_terms_fallback" : "term_shape_changed",
        message: records.length
          ? "Terms published in the Registrar session table. The search-service term list, past-term flags, and term-wide dates remain unverified."
          : "No published Registrar terms could be corroborated against their labels; saved terms were retained." },
      ...(invalid ? [{ code: "unverified_term_rows", message: `${invalid} session rows had missing, unsupported, or inconsistent term labels.` }] : []),
      ...(conflicted.size ? [{ code: "conflicting_term_labels", message: `${conflicted.size} term codes were omitted because a published label disagreed with the central term codec.` }] : []),
    ],
  });
}

export function parsePublicSubjects(html: string, observedAt: string): PlanningCapture {
  const scope = { kind: "subjects" as const, key: "registrar-subjects" }, provenance = { sourceUrl: subjectsUrl, observedAt, scope };
  const rows = select(document(html), (node) => node.tag === "tr"), records: PlanningRecord[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const cells = select(row, (node) => node.tag === "td").map((node) => clean(content(node)));
    if (cells.length !== 3 || !/^\d{3}$/.test(cells[0]) || !cells[1] || !cells[2] || seen.has(cells[0])) continue;
    seen.add(cells[0]); records.push({ kind: "subject", id: cells[0], code: cells[0], shortName: cells[1], formalName: cells[2], aliases: [], provenance });
  }
  // Public HTML is a fallback catalog; it cannot prove deletion from the search service's subjects map.
  return planningCaptureSchema.parse({ schemaVersion: 1, id: `subjects-${observedAt}`, accountScope: "public", source: "uw_public", scope, sourceUrl: subjectsUrl, observedAt,
    status: records.length ? "partial" : "failed", completeness: "partial", records,
    diagnostics: [{ code: records.length ? "registrar_fallback" : "subject_shape_changed", message: records.length ? "Registrar subject list; search API subjects map has not been checked." : "The Registrar subject table could not be recognized." }],
  });
}

export function parseGuideSubject(html: string, slug: string, subjects: PlanningSubject[], observedAt: string): PlanningCapture {
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(slug)) throw new Error("Invalid Guide subject.");
  const sourceUrl = `https://guide.wisc.edu/courses/${slug}/`, scope = { kind: "catalog_term" as const, key: `guide:${slug}` }, provenance = { sourceUrl, observedAt, scope };
  const aliases = new Map<string, Set<string>>();
  for (const subject of subjects) for (const name of [subject.shortName, ...subject.aliases]) {
    const codes = aliases.get(key(name)) ?? new Set<string>(); codes.add(subject.code); aliases.set(key(name), codes);
  }
  const records: PlanningRecord[] = [], seen = new Set<string>(); let invalid = 0;
  for (const block of cls(document(html), "courseblock")) {
    const code = clean(content(cls(block, "courseblockcode")[0] ?? { tag: "span", classes: [], children: [] }));
    const match = code.match(/^(.*?)\s+(\d{1,4}[A-Z]?)$/);
    const titleNode = cls(block, "courseblocktitle")[0], creditNode = cls(block, "courseblockcredits")[0];
    if (!match || !titleNode || !creditNode) { invalid++; continue; }
    const courseKeys = match[1].split("/").map((name) => {
      const codes = aliases.get(key(name)); return codes?.size === 1 ? `uw:${[...codes][0]}:${match[2]}` : null;
    });
    if (courseKeys.some((value) => !value)) { invalid++; continue; }
    const canonicalKey = [...courseKeys as string[]].sort()[0];
    if (seen.has(canonicalKey)) { invalid++; continue; } seen.add(canonicalKey);
    const extras = new Map<string, string>();
    for (const extra of cls(block, "courseblockextra")) {
      const label = cls(extra, "cbextra-label")[0], data = cls(extra, "cbextra-data")[0];
      if (label && data) extras.set(clean(content(label)).replace(/:$/, ""), content(data).trim());
    }
    const credit = clean(content(creditNode)).match(/^(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))? credits?\.?$/);
    const prerequisites = extras.get("Requisites") ?? null;
    const description = cls(block, "courseblockdesc").map((node) => clean(content(node))).join("\n");
    if (!credit || !description || !clean(content(titleNode)).includes("—")) { invalid++; continue; }
    records.push({ kind: "catalog_course", id: canonicalKey, provenance, courseKey: canonicalKey, termCode: null,
      title: clean(content(titleNode)).split("—").slice(1).join("—").trim(), description,
      creditMin: Number(credit[1]), creditMax: Number(credit[2] ?? credit[1]),
      designations: (extras.get("Course Designation") ?? "").split(/\n/).map(clean).filter(Boolean),
      prerequisiteText: prerequisites ? clean(prerequisites) : null,
      prerequisite: prerequisites && clean(prerequisites) === "None" ? { kind: "none" } : null,
      prerequisiteCheckedAt: prerequisites && clean(prerequisites) === "None" ? observedAt : null, offeringFrequency: null,
    });
    if (courseKeys.length > 1) records.push({ kind: "crosslist", id: canonicalKey, provenance, canonicalKey, courseKeys: courseKeys as string[] });
  }
  return planningCaptureSchema.parse({ schemaVersion: 1, id: `guide-${slug}-${observedAt}`, accountScope: "public", source: "uw_public", scope, sourceUrl, observedAt,
    status: records.length ? "partial" : "failed", completeness: "partial", records,
    diagnostics: [{ code: "guide_catalog_only", message: "Guide descriptions do not establish term availability, seats, or eligibility." }, ...(invalid ? [{ code: "unparsed_courses", message: `${invalid} course blocks could not be validated.` }] : [])],
  });
}

export async function pullPublicSubjects(client: PublicClient, observedAt: string, signal?: AbortSignal): Promise<PlanningCapture> {
  const result = await client.text(subjectsUrl, { signal, maxBytes: 2_000_000, onRedirect: (url) => new URL(url).origin === "https://registrar.wisc.edu" });
  return parsePublicSubjects(result.text, observedAt);
}
export async function pullPublicTerms(client: PublicClient, observedAt: string, signal?: AbortSignal): Promise<PlanningCapture> {
  signal?.throwIfAborted();
  const result = await client.text(termsUrl, { signal, maxBytes: 2_000_000, onRedirect: (url) => new URL(url).origin === "https://registrar.wisc.edu" });
  signal?.throwIfAborted();
  return parsePublicTerms(result.text, observedAt);
}
export async function pullGuideSubject(client: PublicClient, slug: string, subjects: PlanningSubject[], observedAt: string, signal?: AbortSignal): Promise<PlanningCapture> {
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(slug)) throw new Error("Invalid Guide subject.");
  const result = await client.text(`https://guide.wisc.edu/courses/${slug}/`, { signal, maxBytes: 2_000_000, onRedirect: (url) => new URL(url).origin === "https://guide.wisc.edu" });
  return parseGuideSubject(result.text, slug, subjects, observedAt);
}

/** Resolve a subject using the Guide's published index, never a guessed URL slug. */
export function guideSubjectSlug(html: string, subject: PlanningSubject): string | null {
  const names = new Set([subject.shortName, ...subject.aliases].map(key));
  const matches = new Set<string>();
  for (const link of select(document(html), (node) => node.tag === "a")) {
    const slug = link.href?.match(/^\/courses\/([a-z][a-z0-9_]{0,79})\/$/)?.[1];
    const designation = clean(content(link)).match(/\(([^()]*)\)$/)?.[1];
    if (slug && designation && names.has(key(designation))) matches.add(slug);
  }
  return matches.size === 1 ? [...matches][0] : null;
}
export async function pullGuideForSubject(client: PublicClient, subject: PlanningSubject, subjects: PlanningSubject[], observedAt: string, signal?: AbortSignal): Promise<PlanningCapture> {
  const index = await client.text("https://guide.wisc.edu/courses/", { signal, maxBytes: 2_000_000, onRedirect: (url) => new URL(url).origin === "https://guide.wisc.edu" });
  const slug = guideSubjectSlug(index.text, subject);
  if (!slug) throw new Error("This subject could not be matched to the current UW Guide index.");
  return pullGuideSubject(client, slug, subjects, observedAt, signal);
}
