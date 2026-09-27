import { createHash, randomUUID } from "node:crypto";
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

function mergePeople(people: (IdentityPerson | undefined)[]): IdentityPerson | undefined {
  const present = people.filter((p): p is IdentityPerson => !!p);
  if (!present.length) return undefined;
  const union = (key: keyof IdentityPerson) => [...new Set(present.flatMap((p) => p[key]))];
  return { names: union("names"), emails: union("emails"), netIds: union("netIds"), studentIds: union("studentIds") };
}

/**
 * Manual roster merged with identities captured automatically: the Canvas
 * profile as the student's own identity; non-teacher discussion/announcement
 * and submission-comment authors as peers. Teacher names are retained; a
 * student's identity never is. Automatic entries never replace manual ones.
 */
export function rosterFor(store: Store, courseId: string, accountScope?: string): EffectiveRoster {
  const base = store.identityRoster();
  const accounts = store.autoIdentities().accounts;
  const auto = accountScope ? [accounts[accountScope]].filter((a) => !!a) : Object.values(accounts);
  const sources = new Map(store.sources().map((s) => [s.id, s]));
  const self = mergePeople([base.self, ...auto.map((a) => a.self)]);
  const inCourse = store
    .resources()
    .filter((r) => !r.deleted && r.courseId === courseId && (!accountScope || sources.get(r.sourceId)?.accountScope === accountScope));
  const instructors = [
    ...new Set(inCourse.flatMap((r) => r.course?.instructors ?? [])),
  ];
  const students = [self, ...base.peers]
    .filter((p): p is IdentityPerson => !!p)
    .flatMap((p) => p.names.map(collapse));
  const keep = new Set(
    [...instructors, ...base.retain].map(collapse),
  );
  const derived = [
    ...new Set(
      [
        ...inCourse.flatMap((r) => r.submission?.comments ?? []).map((c) => c.authorName),
        ...auto.flatMap((a) => a.authorsByCourse[courseId] ?? []),
      ]
        .map((n) => n?.trim())
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
    ...(self ? [{ token: "STUDENT_SELF", person: self }] : []),
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

interface Entry { token?: string; retain: boolean }
interface Matcher {
  full?: RegExp;
  tokens?: RegExp;
  ids?: RegExp;
  fullKeys: Map<string, Entry>;
  tokenKeys: Map<string, Entry>;
  idKeys: Map<string, RedactionKind>;
}
/** Normalizes a matched full-name form: case, whitespace, and "Last, First" spacing. */
const fullKey = (s: string) => lower(s).replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ");
const compiled = new WeakMap<EffectiveRoster, Matcher>();
/** One alternation per form (longest first), compiled once per roster. */
function matcher(roster: EffectiveRoster): Matcher {
  const cached = compiled.get(roster);
  if (cached) return cached;
  const fullKeys = new Map<string, Entry>(), tokenKeys = new Map<string, Entry>();
  const idKeys = new Map<string, RedactionKind>();
  const fullSources = new Set<string>(), tokenSources = new Set<string>(), idSources = new Set<string>();
  const add = (map: Map<string, Entry>, key: string, token: string | undefined) => {
    const e = map.get(key) ?? { retain: false };
    if (token) e.token ??= token;
    else e.retain = true;
    map.set(key, e);
  };
  const register = (name: string, token?: string) => {
    const parts = name.normalize("NFKC").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return;
    // Full names: case-insensitive with flexible whitespace, plus "Last, First".
    add(fullKeys, fullKey(parts.join(" ")), token);
    fullSources.add(parts.map(escape).join("\\s+"));
    if (parts.length >= 2) {
      add(fullKeys, fullKey(`${parts.at(-1)}, ${parts[0]}`), token);
      fullSources.add(`${escape(parts.at(-1)!)}\\s*,\\s*${escape(parts[0]!)}`);
      // Single parts only match capitalized or upper-case forms, so common
      // words ("will", "grace") survive in ordinary prose.
      for (const part of parts) {
        if (part.length < 2 || particles.has(part.toLocaleLowerCase())) continue;
        for (const f of new Set([part[0]!.toLocaleUpperCase() + part.slice(1), part.toLocaleUpperCase()])) {
          add(tokenKeys, f, token);
          tokenSources.add(escape(f));
        }
      }
    }
  };
  for (const { token, person } of roster.people) {
    for (const n of person.names) register(n, token);
    for (const id of person.netIds) {
      idKeys.set(lower(id), "netid");
      idSources.add(escape(id));
    }
    for (const id of person.studentIds) {
      idKeys.set(lower(id), "student_id");
      idSources.add(escape(id));
    }
  }
  for (const n of roster.retain) register(n);
  const alt = (xs: Set<string>) => [...xs].sort((a, b) => b.length - a.length).join("|");
  const m: Matcher = { fullKeys, tokenKeys, idKeys };
  if (fullSources.size) m.full = new RegExp(`${B}(?:${alt(fullSources)})${E}`, "giu");
  if (tokenSources.size) m.tokens = new RegExp(`${B}(?:${alt(tokenSources)})${E}`, "gu");
  if (idSources.size) m.ids = new RegExp(`${B}(?:${alt(idSources)})${E}`, "giu");
  compiled.set(roster, m);
  return m;
}
function nameCandidates(text: string, m: Matcher) {
  const out: Candidate[] = [];
  const run = (re: RegExp | undefined, keys: Map<string, Entry>, key: (s: string) => string) => {
    if (!re) return;
    for (const hit of text.matchAll(re)) {
      const e = keys.get(key(hit[0]));
      if (!e) continue;
      const honor = honorific.test(text.slice(Math.max(0, hit.index - 16), hit.index));
      // A form shared by a student and a teacher is scrubbed unless an honorific marks the teacher.
      const kind = e.token && !(e.retain && honor) ? "student_name" : "retain";
      out.push({ start: hit.index, end: hit.index + hit[0].length, kind, key: e.token ?? "", honorific: honor });
    }
  };
  run(m.full, m.fullKeys, fullKey);
  run(m.tokens, m.tokenKeys, (s) => s);
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
  const m = matcher(roster);
  if (m.ids)
    for (const hit of text.matchAll(m.ids))
      found.push({ start: hit.index, end: hit.index + hit[0].length, kind: m.idKeys.get(lower(hit[0]))!, key: lower(hit[0]) });
  // Identifier patterns always win over names (an instructor email is still an email).
  const identifiers = resolve(found);
  const names = nameCandidates(text, m);
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
export function payloadScrubber(store: Store, hosted: boolean, accountScope?: string) {
  const rosters = new Map<string, EffectiveRoster>();
  const counts: Partial<Record<RedactionKind, number>> = {};
  const roster = (courseId: string) => {
    let r = rosters.get(courseId);
    if (!r) rosters.set(courseId, (r = rosterFor(store, courseId, accountScope)));
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

interface Projection { resourceId: string; contentHash: string; field: CitationResult["field"]; result: ScrubResult; start: number; end: number }
const projections = new WeakMap<Store, Map<string, Projection>>();
/** Immutable local map of exactly the displayed outgoing range. IDs expire on restart/eviction. */
export function clearOutgoingProjections(store: Store) { projections.delete(store); }
export function outgoingProjection(store: Store, resource: Resource, field: CitationResult["field"] = "text", range?: { start: number; end: number }) {
  const scope = store.sources().find((s) => s.id === resource.sourceId)?.accountScope;
  const result = scrubText(fieldText(resource, field), rosterFor(store, resource.courseId, scope));
  const start = Math.max(0, range?.start ?? 0), end = Math.min(result.text.length, range?.end ?? result.text.length);
  const id = randomUUID();
  let cache = projections.get(store);
  if (!cache) projections.set(store, cache = new Map());
  if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
  cache.set(id, { resourceId: resource.id, contentHash: resource.contentHash, field, result, start, end });
  return { id, text: result.text.slice(start, end), start, end };
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
    const projection = claim.projectionId ? projections.get(store)?.get(claim.projectionId) : undefined;
    if (claim.basis === "outgoing" && (!projection || projection.resourceId !== r.id || projection.contentHash !== r.contentHash || projection.field !== claim.field)) return fail("projection_missing");
    const scrubbed = claim.basis === "outgoing" ? projection!.result : { text: original, spans: [] };
    let start: number;
    if (claim.start !== undefined) {
      if (scrubbed.text.slice(claim.start, claim.end) !== claim.quote || claim.end! - claim.start !== claim.quote.length)
        return fail("offset_mismatch");
      start = claim.start;
    } else {
      const hits: number[] = [];
      for (let i = scrubbed.text.indexOf(claim.quote, claim.basis === "outgoing" ? projection!.start : 0); i !== -1 && i + claim.quote.length <= (claim.basis === "outgoing" ? projection!.end : scrubbed.text.length); i = scrubbed.text.indexOf(claim.quote, i + 1))
        hits.push(i);
      if (!hits.length) return fail("quote_not_found");
      if (hits.length > 1) return fail("ambiguous_quote");
      start = hits[0]!;
    }
    const end = start + claim.quote.length;
    if (claim.basis === "outgoing" && (start < projection!.start || end > projection!.end)) return fail("outside_projection");
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
