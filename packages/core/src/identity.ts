import { createHash } from "node:crypto";
import {
  citationClaimSchema,
  type CitationClaim,
  type CitationResult,
  type IdentityPerson,
  type RedactionKind,
  type RedactionSummary,
  type Resource,
  type Store,
} from "@magic/contracts";

/**
 * Identity scrubbing for hosted payloads (docs/pipeline-details.md, "Name
 * scrubbing and exact citations"). Known student identities and identifier
 * patterns are replaced with opaque placeholders; instructor names from course
 * metadata are kept. The span map stays local so a quote taken from scrubbed
 * text resolves to the exact original span. This is not anonymization.
 */
export interface EffectiveRoster {
  /** Student identities to remove. `token` is the stable placeholder label. */
  people: { token: string; person: IdentityPerson }[];
  /** Instructor/author names to keep (never a student's name). */
  retain: string[];
  version: string;
}
export interface RedactionSpan {
  kind: RedactionKind;
  placeholder: string;
  /** Span in the scrubbed text. */
  start: number;
  end: number;
  /** Span in the original text. */
  originalStart: number;
  originalEnd: number;
}
export interface ScrubResult {
  text: string;
  spans: RedactionSpan[];
}
export const scrubNote =
  "Known student names, emails, NetIDs, student IDs and phone numbers were replaced before sending. This is not anonymization; distinctive details can still identify people.";

const lower = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase();
const collapse = (value: string) => lower(value).replace(/\s+/g, " ");

/**
 * Stored roster plus identities captured for this course: teacher names are
 * retained, submission-comment authors who are not teachers are scrubbed.
 */
export function rosterFor(store: Store, courseId: string): EffectiveRoster {
  const base = store.identityRoster();
  const inCourse = store
    .resources()
    .filter((r) => !r.deleted && r.courseId === courseId);
  const instructors = [
    ...new Set(inCourse.flatMap((r) => r.course?.instructors ?? [])),
  ];
  const students = [base.self, ...base.peers]
    .filter((p): p is IdentityPerson => !!p)
    .flatMap((p) => p.names.map(collapse));
  const keep = new Set(
    [...instructors, ...base.retain].map(collapse),
  );
  const derived = [
    ...new Set(
      inCourse
        .flatMap((r) => r.submission?.comments ?? [])
        .map((c) => c.authorName?.trim())
        .filter((n): n is string => !!n && n.length >= 2),
    ),
  ]
    .filter((n) => !keep.has(collapse(n)) && !students.includes(collapse(n)))
    .sort();
  const peers: IdentityPerson[] = [
    ...base.peers,
    ...derived.map((n) => ({ names: [n], emails: [], netIds: [], studentIds: [] })),
  ];
  const people = [
    ...(base.self ? [{ token: "STUDENT_SELF", person: base.self }] : []),
    ...peers.map((person, i) => ({ token: `STUDENT_${i + 1}`, person })),
  ];
  // A student's identity is never retained, even if it also appears as a teacher.
  const retain = [...instructors, ...base.retain].filter(
    (n) => !students.includes(collapse(n)) && !derived.some((d) => collapse(d) === collapse(n)),
  );
  const version = createHash("sha256")
    .update(JSON.stringify({ people, retain }))
    .digest("hex")
    .slice(0, 16);
  return { people, retain, version };
}

interface Candidate {
  start: number;
  end: number;
  kind: RedactionKind | "retain";
  /** Placeholder label for names, or normalized value for patterns. */
  key: string;
  honorific?: boolean;
}
const B = "(?<![\\p{L}\\p{N}_])";
const E = "(?![\\p{L}\\p{N}_])";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const particles = new Set(["de", "da", "del", "di", "du", "van", "von", "la", "le", "bin", "al", "st"]);
const honorific = /(?:\b(?:prof(?:essor)?|dr|instructor|lecturer)\.?\s+)$/i;

function nameCandidates(text: string, name: string, kind: Candidate["kind"], key: string) {
  const out: Candidate[] = [];
  const parts = name.normalize("NFKC").trim().split(/\s+/).filter(Boolean);
  const run = (source: string, flags: string) => {
    for (const m of text.matchAll(new RegExp(source, flags)))
      out.push({
        start: m.index,
        end: m.index + m[0].length,
        kind,
        key,
        honorific: honorific.test(text.slice(Math.max(0, m.index - 16), m.index)),
      });
  };
  // Full names are matched case-insensitively with flexible whitespace.
  run(B + parts.map(escape).join("\\s+") + E, "giu");
  if (parts.length >= 2)
    run(B + `${escape(parts.at(-1)!)},\\s*${escape(parts[0]!)}` + E, "giu");
  // Single name parts only match capitalized or upper-case forms, so common
  // words ("will", "grace") are not removed from ordinary prose.
  if (parts.length >= 2)
    for (const part of parts) {
      if (part.length < 2 || particles.has(part.toLocaleLowerCase())) continue;
      const cap = part[0]!.toLocaleUpperCase() + part.slice(1);
      const forms = [...new Set([cap, part.toLocaleUpperCase()])].map(escape);
      run(B + `(?:${forms.join("|")})` + E, "gu");
    }
  return out;
}

const patterns: { kind: RedactionKind; source: RegExp; group?: number }[] = [
  { kind: "email", source: /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g },
  // UW student ID numbers are 10 digits.
  { kind: "student_id", source: /(?<![\d-])\d{10}(?![\d-])/g },
  { kind: "phone", source: /(?<![\d-])(?:\+?1[-.\s]?)?(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]\d{4}(?![\d-])/g },
  // A token explicitly labelled as a NetID.
  { kind: "netid", source: /\bnet\s?-?id\b\s*(?:is|:|#|=|-)?\s*([A-Za-z][A-Za-z0-9]{1,15})\b/dgi, group: 1 },
];

function resolve(cands: Candidate[], taken: Candidate[] = []) {
  const accepted = [...taken];
  const rank = (c: Candidate) => (c.kind === "retain" ? (c.honorific ? 0 : 2) : 1);
  const sorted = [...cands].sort(
    (a, b) => b.end - b.start - (a.end - a.start) || rank(a) - rank(b) || a.start - b.start,
  );
  for (const c of sorted)
    if (!accepted.some((a) => c.start < a.end && a.start < c.end)) accepted.push(c);
  return accepted;
}

/** Scrub one field of free text. Deterministic for a given text and roster. */
export function scrubText(text: string, roster: EffectiveRoster): ScrubResult {
  const found: Candidate[] = [];
  for (const p of patterns)
    for (const m of text.matchAll(p.source)) {
      const [start, end] = p.group ? m.indices![p.group]! : [m.index, m.index + m[0].length];
      found.push({ start, end, kind: p.kind, key: lower(text.slice(start, end)) });
    }
  for (const { person } of roster.people) {
    for (const netId of person.netIds)
      for (const m of text.matchAll(new RegExp(B + escape(netId) + E, "giu")))
        found.push({ start: m.index, end: m.index + m[0].length, kind: "netid", key: lower(netId) });
    for (const sid of person.studentIds)
      for (const m of text.matchAll(new RegExp(`(?<!\\d)${sid}(?!\\d)`, "g")))
        found.push({ start: m.index, end: m.index + m[0].length, kind: "student_id", key: sid });
  }
  // Identifier patterns always win over names (an instructor email is still an email).
  const identifiers = resolve(found);
  const names: Candidate[] = [];
  for (const { token, person } of roster.people)
    for (const n of person.names) names.push(...nameCandidates(text, n, "student_name", token));
  for (const n of roster.retain) names.push(...nameCandidates(text, n, "retain", ""));
  const chosen = resolve(names, identifiers)
    .filter((c) => c.kind !== "retain")
    .sort((a, b) => a.start - b.start);
  const numbers = new Map<string, number>();
  const counters: Partial<Record<RedactionKind, number>> = {};
  let out = "", cursor = 0;
  const spans: RedactionSpan[] = [];
  for (const c of chosen) {
    const kind = c.kind as RedactionKind;
    let placeholder: string;
    if (kind === "student_name") placeholder = `[${c.key}]`;
    else {
      const id = `${kind}:${c.key}`;
      if (!numbers.has(id)) numbers.set(id, (counters[kind] = (counters[kind] ?? 0) + 1));
      placeholder = `[${kind.toUpperCase()}_${numbers.get(id)}]`;
    }
    out += text.slice(cursor, c.start);
    spans.push({ kind, placeholder, start: out.length, end: out.length + placeholder.length, originalStart: c.start, originalEnd: c.end });
    out += placeholder;
    cursor = c.end;
  }
  return { text: out + text.slice(cursor), spans };
}

/**
 * Map a span of scrubbed text back to the original text. Returns null when a
 * boundary falls inside a placeholder (the quote splits a redaction).
 */
export function toOriginalSpan(result: ScrubResult, start: number, end: number) {
  const map = (p: number) => {
    let delta = 0;
    for (const s of result.spans) {
      if (s.end <= p) {
        delta += s.end - s.start - (s.originalEnd - s.originalStart);
        continue;
      }
      if (p > s.start && p < s.end) return null;
      break;
    }
    return p - delta;
  };
  const a = map(start), b = map(end);
  return a === null || b === null ? null : { start: a, end: b };
}

/** Scrubs payload fields for one manifest and summarizes what changed. */
export function payloadScrubber(store: Store, hosted: boolean) {
  const rosters = new Map<string, EffectiveRoster>();
  const counts: Partial<Record<RedactionKind, number>> = {};
  const roster = (courseId: string) => {
    let r = rosters.get(courseId);
    if (!r) rosters.set(courseId, (r = rosterFor(store, courseId)));
    return r;
  };
  return {
    field(value: string, courseId: string) {
      if (!hosted) return value;
      const result = scrubText(value, roster(courseId));
      for (const s of result.spans) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
      return result.text;
    },
    summary(courseId: string): RedactionSummary | undefined {
      if (!hosted) return undefined;
      return { applied: true, counts, rosterVersion: roster(courseId).version, note: scrubNote };
    },
  };
}

function fieldText(r: Resource, field: CitationResult["field"]) {
  return field === "title" ? r.title : field === "policy" ? r.policy.evidence : r.text;
}

/**
 * Literal-span citation check. Exact match or exact offset validation only;
 * quotes are never fuzzily repaired. "supported" establishes presence of the
 * span in that captured version, not that the claim is correct.
 */
export function validateCitations(store: Store, claims: CitationClaim[]): CitationResult[] {
  return claims.map((raw, index) => {
    const claim = citationClaimSchema.parse(raw);
    const head = { index, resourceId: claim.resourceId, contentHash: claim.contentHash, field: claim.field };
    const fail = (reason: CitationResult["reason"], extra: Partial<CitationResult> = {}): CitationResult => ({
      ...head,
      status: "unsupported",
      reason,
      ...extra,
    });
    const r = store.resource(claim.resourceId);
    if (!r || r.deleted) return fail("source_missing");
    if (r.contentHash !== claim.contentHash) return fail("stale_version");
    const original = fieldText(r, claim.field);
    const scrubbed =
      claim.basis === "outgoing" ? scrubText(original, rosterFor(store, r.courseId)) : { text: original, spans: [] };
    let start: number;
    if (claim.start !== undefined) {
      if (scrubbed.text.slice(claim.start, claim.end) !== claim.quote || claim.end! - claim.start !== claim.quote.length)
        return fail("offset_mismatch");
      start = claim.start;
    } else {
      const hits: number[] = [];
      for (let i = scrubbed.text.indexOf(claim.quote); i !== -1; i = scrubbed.text.indexOf(claim.quote, i + 1))
        hits.push(i);
      if (!hits.length) return fail("quote_not_found");
      if (hits.length > 1) return fail("ambiguous_quote");
      start = hits[0]!;
    }
    const end = start + claim.quote.length;
    const mapped = toOriginalSpan(scrubbed, start, end);
    if (!mapped) return fail("quote_splits_redaction", { cited: { start, end } });
    return {
      ...head,
      status: "supported",
      cited: { start, end },
      original: { ...mapped, text: original.slice(mapped.start, mapped.end) },
      containsRedaction: scrubbed.spans.some((s) => s.start < end && start < s.end),
    };
  });
}
