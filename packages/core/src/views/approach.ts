/**
 * The optional "how to approach it" paragraph (owner: page-views): the page's facts, the check that
 * every date, number and quote in the paragraph is in those facts, and the cache read the query
 * does. Generation (one checked call through the student's own AI) is `approach-run.ts`; a query
 * only reads the cached artifact by the page's fact hash and never calls a model.
 */
import type { AssessmentPage, AssignmentWorkspace, PageApproach } from "@magic/contracts";
import { learningArtifactStore } from "../../../packs/core/src/learning-stores";
import { payloadHash } from "../egress";
import { clip, showDate, type ViewContext } from "./common";

export const APPROACH_PACK = "page-approach" as const;
export const APPROACH_VERSION = "v1";
export interface ApproachFacts {
  kind: "assignment" | "assessment";
  title: string;
  /** One fact per line, as code states it; the paragraph may use only these. */
  lines: string[];
  /** Quoted source text the paragraph may quote from (instructions, rubric, scope). */
  passages: { sourceId: string; text: string }[];
}
export interface ApproachOutput {
  paragraph: string;
  quotes: { sourceId: string; quote: string }[];
}

/** The artifact's cache key: the page's fact hash and the pack version, nothing else. */
export const approachKey = (hash: string) => payloadHash({ pack: APPROACH_PACK, version: APPROACH_VERSION, factHash: hash });

type Page = Omit<AssignmentWorkspace, "approach"> | Omit<AssessmentPage, "approach">;
export function approachFacts(page: Page): ApproachFacts {
  const lines: string[] = [];
  const passages: ApproachFacts["passages"] = [];
  const at = (iso: string) => `${showDate(iso)} (${iso})`;
  if (page.view === "assignment.workspace") {
    const h = page.header;
    lines.push(`Assignment: ${h.title}`, `Course: ${page.course.courseName}`);
    if (h.due) lines.push(`Due: ${at(h.due.at)}`);
    if (h.lock) lines.push(`Closes: ${at(h.lock.at)}`);
    if (h.unlock) lines.push(`Opens: ${at(h.unlock.at)}`);
    if (h.points) lines.push(`Points: ${h.points.value}`);
    if (h.gradeWeight.text) lines.push(`Grade weight: ${h.gradeWeight.text}`);
    if (h.submissionTypes.length) lines.push(`Submit as: ${h.submissionTypes.join(", ")}`);
    lines.push(`Status: ${h.status.state}`);
    if (h.effort) lines.push(`Typical effort: ${h.effort.lowMin}-${h.effort.highMin} minutes (${h.effort.basis})`);
    lines.push(`Course AI policy: ${h.aiPolicy.mode}`);
    for (const r of page.resources) lines.push(`Resource: ${r.title} (${r.reason})`);
    for (const t of page.tools) lines.push(`Tool: ${t.name} (${t.accessState})`);
    if (page.instructions.text) passages.push({ sourceId: "instructions", text: clip(page.instructions.text, 6000) });
    const rubric = page.instructions.rubric.map((c) => `${c.criterion}${c.points === null ? "" : ` (${c.points} points)`}`).join("\n");
    if (rubric) passages.push({ sourceId: "rubric", text: rubric });
  } else {
    lines.push(`Assessment: ${page.assessment.title}`, `Course: ${page.course.courseName}`);
    for (const d of page.details) if (d.value) lines.push(`${d.field.replace("_", " ")}: ${d.field === "date" ? at(d.value) : d.value}`);
    for (const r of page.materials.core) lines.push(`Core material: ${r.title} (${r.reason})`);
    if (page.plan.status === "ok") lines.push(`Plan: ${page.plan.text}`);
    const scope = page.scope.quotes.map((q) => q.quote).join("\n");
    if (scope) passages.push({ sourceId: "scope", text: clip(scope, 4000) });
  }
  passages.unshift({ sourceId: "facts", text: lines.join("\n") });
  return { kind: page.view === "assignment.workspace" ? "assignment" : "assessment", title: page.view === "assignment.workspace" ? page.header.title : page.assessment.title, lines, passages };
}

// ---------- The code check ----------
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthDay = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi;
const slashDate = /\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g;
const isoDate = /\b\d{4}-(\d{2})-(\d{2})(?:T[0-9:.]+Z?)?\b/g;
const clockTime = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/gi;
const weekday = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|rsday|urday|sday)?\b/gi;
const number = /(?<![\w.])\d+(?:\.\d+)?(?![\w])/g;
const quoted = /["“]([^"”]{6,})["”]/g;
const collapse = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function dayKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const m of text.matchAll(monthDay)) keys.add(`${MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1}-${Number(m[2])}`);
  for (const m of text.matchAll(slashDate)) keys.add(`${Number(m[1])}-${Number(m[2])}`);
  for (const m of text.matchAll(isoDate)) keys.add(`${Number(m[1])}-${Number(m[2])}`);
  return keys;
}
function timeKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const m of text.matchAll(clockTime)) keys.add(`${Number(m[1]) % 12}:${m[2] ?? "00"}${m[3]!.toLowerCase()}`);
  return keys;
}
/** Every date, time, weekday, number and quote in the paragraph must be in the facts or passages. */
export function checkApproach(paragraph: string, facts: ApproachFacts): string[] {
  const hay = [facts.lines.join("\n"), ...facts.passages.map((p) => p.text)].join("\n");
  const errors: string[] = [];
  const days = dayKeys(hay);
  for (const k of dayKeys(paragraph)) if (!days.has(k)) errors.push(`date ${k} is not among the page's dates`);
  const times = timeKeys(hay);
  for (const k of timeKeys(paragraph)) if (!times.has(k)) errors.push(`time ${k} is not among the page's times`);
  const lowerHay = hay.toLowerCase();
  for (const m of paragraph.matchAll(weekday)) if (!new RegExp(`\\b${m[1]!.slice(0, 3).toLowerCase()}`).test(lowerHay)) errors.push(`weekday "${m[0]}" is not among the page's dates`);
  // Numbers outside the dates and times just checked.
  const stripped = paragraph.replace(monthDay, " ").replace(slashDate, " ").replace(isoDate, " ").replace(clockTime, " ");
  const numbers = new Set(hay.match(number) ?? []);
  for (const n of stripped.match(number) ?? []) if (!numbers.has(n)) errors.push(`number ${n} is not in the page's facts`);
  const flat = collapse(hay);
  for (const m of paragraph.matchAll(quoted)) if (!flat.includes(collapse(m[1]!))) errors.push(`quote "${clip(m[1]!, 60)}" is not in the sources`);
  return errors;
}

/** The query's read: the cached paragraph for this fact hash, re-checked; never a model call. */
export function readApproach(ctx: ViewContext, hash: string, facts: ApproachFacts, scope: PageApproach["request"]["scope"]): PageApproach {
  const request = { type: "pack" as const, pack: APPROACH_PACK, scope };
  const base = { factHash: hash, text: null, generatedAt: null, client: null, model: null, checks: { passed: false, errors: [] as string[] }, request };
  const learning = ctx.store.learning;
  if (!learning) return { ...base, status: "unavailable", message: "Generated text isn't available in this workspace." };
  const hit = learningArtifactStore(learning, () => null).get(approachKey(hash));
  const output = hit?.output as Partial<ApproachOutput> | undefined;
  if (!hit || typeof output?.paragraph !== "string")
    return { ...base, status: "not_generated", message: "Ask your AI for a short plan of approach; it uses only the facts on this page." };
  const errors = checkApproach(output.paragraph, facts);
  return {
    ...base,
    status: "ready",
    message: errors.length ? "The saved paragraph no longer passes the checks; regenerate it." : "Written by your AI from this page's facts; every date, number and quote was checked.",
    text: errors.length ? null : output.paragraph,
    generatedAt: hit.createdAt,
    client: hit.client,
    model: hit.model,
    checks: { passed: !errors.length, errors },
  };
}
