/**
 * The protection pass every hosted payload goes through (docs/ai-and-privacy.md, "Protection
 * layers"). It composes three layers without changing the roster scrubber in identity.ts:
 * 1. the roster scrubber's name and roster-ID spans (`scrubText`), with its known false
 *    positives removed: a sentence-start common word that is also a first name, and a
 *    lowercase common word matched through a one-word roster name;
 * 2. the code detectors (detectors.ts), which replace the scrubber's own patterns so a bare
 *    10-digit number needs a context word;
 * 3. per-request pseudonyms (pseudonyms.ts): the same person or value keeps one placeholder
 *    in every field of one request.
 * What is replaced depends on what the text is (`ContentClass`): teaching material keeps its
 * content (only roster students, emails, phones, signed URLs and Canvas user links go); personal
 * content gets every detector, numbers only with a person context word.
 * The span map is identity.ts's `ScrubResult`, so `toOriginalSpan` maps quotes back unchanged.
 */
import { randomUUID } from "node:crypto";
import {
  citationClaimSchema,
  type CitationClaim,
  type CitationResult,
  type MailMetadata,
  type ProtectionCounts,
  type RedactionKind,
  type RedactionSummary,
  type Resource,
  type Store,
} from "@magic/contracts";
import { outgoingProjection, rosterFor, scrubText, toOriginalSpan, validateCitations, type EffectiveRoster, type RedactionSpan, type ScrubResult } from "../identity";
import { detect, resolveDetections, type Detection, type DetectMode } from "./detectors";
import { labelOf, pseudonymSession, type PseudonymSession } from "./pseudonyms";

export const protectionNote =
  "Names of students and, by code checks, emails, phone numbers, signed links and Canvas user links were replaced before sending; in messages, comments, mail and notes also IDs, addresses, dates of birth and card or social security numbers given as someone's. Course material is otherwise sent as written. This is not anonymization; distinctive details can still identify people.";

/**
 * What a text is, which decides what is replaced (the operator's rule, September 27):
 * "teaching" for instructor-authored material, "personal" for what people wrote about themselves
 * or each other. Unknown text is treated as personal (the more protective choice).
 */
export type ContentClass = "teaching" | "personal";
/** Discussions and announcements, mail, the student's notes and student work are personal. */
export function classOf(r: Pick<Resource, "kind"> & Partial<Pick<Resource, "mail" | "notes" | "gitlab">>): ContentClass {
  if (r.mail || r.notes || r.gitlab) return "personal";
  return r.kind === "message" ? "personal" : "teaching";
}

interface Chosen {
  kind: RedactionKind;
  /** Roster token for a name, the normalized value otherwise. */
  key: string;
  start: number;
  end: number;
}
export interface ProtectResult extends ScrubResult {
  counts: ProtectionCounts;
}

/**
 * Name placeholders. "roster" keeps identity.ts's roster labels (`[STUDENT_SELF]`, `[STUDENT_n]`
 * in roster order), which existing tests pin; "session" numbers names by the per-request HMAC
 * ranking like every other kind, so a provider cannot follow one classmate across requests.
 * Switching is the lead's call (it changes three assertions in identity-scrubber.test.ts).
 */
export const NAME_LABELS = "session" as "roster" | "session";
/** The student's own identity stays `[STUDENT_SELF]` (a role, the same for every student). */
const nameLabel = (session: PseudonymSession, key: string) =>
  NAME_LABELS === "roster" || key === "STUDENT_SELF" ? `[${key}]` : session.placeholder("student_name", key);

const lower = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase();

/** First names that are also everyday English words (the sentence-start false positive). */
const COMMON_WORD_NAMES = new Set(
  (
    "will grace may mark bill rose june april august faith hope joy max frank art pat sue jack chase dawn eve ray rich " +
    "sandy summer autumn amber ivy lily iris violet jade penny ruby crystal hunter drew gene guy jean rob bob carol don " +
    "hazel heather holly jasmine jewel kay lane lee lou mercy miles misty olive pearl reed rocky rusty sky stone storm " +
    "cliff dale dean earl glen grant hardy harmony heath jay kit lance major marshall mason nick noel norm page parker " +
    "patience peace price prince rain river robin royal sage skip sonny spring sterling sunny trace wade ward win winter " +
    "wren young brook cash chance clay cole colt destiny dusty eden ember forest fox gray grey haven honor journey justice " +
    "king knight lark love lyric march meadow melody memory miracle ocean poppy rebel saint scout serenity shadow shepherd " +
    "silver skye sparrow star story tanner timber true unity valor west willow wolf al bud buck chip chuck clark dick " +
    "doc duke ernest gay gil hank herb iva jan jewel kelly lincoln mo ned pierce rex sal stu sylvan tony victor walker"
  ).split(/\s+/),
);
const NAME_CUE = /^(?:['’]s\b|,|\s+(?:said|says|asked|asks|wrote|writes|posted|replied|mentioned|emailed|commented|shared|thinks|thought|and\s+I\b|is\s+my\b))/;
function atSentenceStart(text: string, start: number) {
  if (/^[\s\-*•>"“(]*$/.test(text.slice(0, start))) return true;
  return /(?:[.!?…:;]["'”’)\]]*\s+|\n[\s\-*•>]*|["“(]\s*)$/.test(text.slice(Math.max(0, start - 12), start));
}

/** A one-word name hit that is ordinary prose, not a person. */
function falseNameHit(text: string, start: number, end: number, rosterTokens: ReadonlySet<string>): boolean {
  const token = text.slice(start, end);
  if (/[\s,]/.test(token)) return false; // full names are never dropped
  // "Will Drevo" when the roster has "Will Hart": a full roster name would have matched as one span,
  // so a first name followed by another capitalized name word is a different person.
  const next = /^\s+(\p{Lu}[\p{Ll}'’-]+)/u.exec(text.slice(end, end + 40))?.[1];
  if (next && !rosterTokens.has(next)) return true;
  const word = token.toLocaleLowerCase();
  if (!COMMON_WORD_NAMES.has(word)) return false;
  if (token === word) return true; // "will" matched through a one-word roster name
  if (!atSentenceStart(text, start)) return false; // capitalized mid-sentence: a name
  if (NAME_CUE.test(text.slice(end, end + 24))) return false;
  // The same word capitalized mid-sentence elsewhere in this text is evidence of a name.
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${token}(?![\\p{L}\\p{N}_])`, "gu");
  for (const m of text.matchAll(re)) if (m.index !== start && !atSentenceStart(text, m.index)) return false;
  return true;
}

const rosterWordCache = new WeakMap<EffectiveRoster, Set<string>>();
/** Every name word of the roster (students and retained teachers), as written. */
function rosterWords(roster: EffectiveRoster) {
  let words = rosterWordCache.get(roster);
  if (!words) {
    words = new Set([...roster.people.flatMap(({ person }) => person.names), ...roster.retain].flatMap((n) => n.normalize("NFKC").split(/\s+/)).filter(Boolean));
    rosterWordCache.set(roster, words);
  }
  return words;
}
const rosterIdCache = new WeakMap<EffectiveRoster, Set<string>>();
function rosterIds(roster: EffectiveRoster) {
  let ids = rosterIdCache.get(roster);
  if (!ids) {
    ids = new Set(roster.people.flatMap(({ person }) => [...person.netIds, ...person.studentIds].map(lower)));
    rosterIdCache.set(roster, ids);
  }
  return ids;
}

/** Every replacement for `text`: identifiers first, then roster names that do not overlap them. */
export function protectionCandidates(text: string, roster: EffectiveRoster, cls: ContentClass = "personal"): Chosen[] {
  const base = scrubText(text, roster);
  const ids = rosterIds(roster);
  const names: Chosen[] = [];
  const identifiers: Detection[] = detect(text, cls satisfies DetectMode);
  for (const s of base.spans as RedactionSpan[]) {
    const original = text.slice(s.originalStart, s.originalEnd);
    if (s.kind === "student_name") {
      if (!falseNameHit(text, s.originalStart, s.originalEnd, rosterWords(roster)))
        names.push({ kind: "student_name", key: s.placeholder.slice(1, -1), start: s.originalStart, end: s.originalEnd });
    } else if ((s.kind === "netid" || s.kind === "student_id") && ids.has(lower(original)))
      // A roster ID is replaced wherever it appears, with or without a context word.
      identifiers.push({ kind: s.kind, start: s.originalStart, end: s.originalEnd, value: lower(original) });
  }
  const chosen: Chosen[] = resolveDetections(identifiers).map((d) => ({ kind: d.kind, key: d.value, start: d.start, end: d.end }));
  for (const n of names) if (!chosen.some((c) => n.start < c.end && c.start < n.end)) chosen.push(n);
  return chosen.sort((a, b) => a.start - b.start);
}

const candidateCache = new WeakMap<PseudonymSession, Map<string, Chosen[]>>();
function candidatesIn(session: PseudonymSession, text: string, roster: EffectiveRoster, cls: ContentClass) {
  let cache = candidateCache.get(session);
  if (!cache) candidateCache.set(session, (cache = new Map()));
  const key = `${roster.version}\u0000${cls}\u0000${text}`;
  let found = cache.get(key);
  if (!found) cache.set(key, (found = protectionCandidates(text, roster, cls)));
  return found;
}

/** Protect one field of free text within a request's pseudonym session. */
export function protectText(text: string, roster: EffectiveRoster, session: PseudonymSession, cls: ContentClass = "personal"): ProtectResult {
  const chosen = candidatesIn(session, text, roster, cls);
  const counts: ProtectionCounts = {};
  const spans: RedactionSpan[] = [];
  let out = "", cursor = 0;
  for (const c of chosen) {
    const placeholder = c.kind === "student_name" ? nameLabel(session, c.key) : session.placeholder(c.kind, c.key);
    out += text.slice(cursor, c.start);
    spans.push({ kind: c.kind, placeholder, start: out.length, end: out.length + placeholder.length, originalStart: c.start, originalEnd: c.end });
    out += placeholder;
    cursor = c.end;
    counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  }
  return { text: out + text.slice(cursor), spans, counts };
}

/** Number every identity in `texts` in HMAC order before the fields are rendered. */
export function primeSession(session: PseudonymSession, texts: Iterable<string | [string, ContentClass]>, roster: EffectiveRoster): void {
  const entries: { kind: string; key: string }[] = [];
  for (const item of texts)
    for (const c of typeof item === "string" ? candidatesIn(session, item, roster, "personal") : candidatesIn(session, item[0], roster, item[1]))
      if (c.kind !== "student_name" || NAME_LABELS === "session") entries.push({ kind: c.kind, key: c.key });
  session.prime(entries);
}

/** Course ids that hold account-wide items (mail, unmapped notes) rather than one course's. */
const ACCOUNT_WIDE = new Set(["outlook-mail", "unmapped", "outlook-calendar"]);
/**
 * Mail and unmapped notes are not one course's: their roster is every course roster of the
 * account merged (a classmate from any course is scrubbed from a message), peers renumbered.
 */
export function accountRoster(store: Store, accountScope: string | undefined, courseId: string): EffectiveRoster {
  const courses = [...new Set(store.sources().filter((s) => !accountScope || s.accountScope === accountScope).map((s) => s.courseId))];
  const parts = [courseId, ...courses.filter((c) => c !== courseId)].map((c) => rosterFor(store, c, accountScope));
  const seen = new Set<string>();
  const people: EffectiveRoster["people"] = [];
  let n = 0;
  for (const { token, person } of parts.flatMap((r) => r.people)) {
    const id = JSON.stringify([...person.names].map(lower).sort());
    if (seen.has(id)) continue;
    seen.add(id);
    people.push({ token: token === "STUDENT_SELF" ? token : `STUDENT_${++n}`, person });
  }
  const students = new Set(people.flatMap((p) => p.person.names.map(lower)));
  const retain = [...new Set(parts.flatMap((r) => r.retain))].filter((name) => !students.has(lower(name)));
  return { people, retain, version: parts.map((r) => r.version).join(".") };
}

/**
 * The drop-in for identity.ts's `payloadScrubber` on hosted paths: same `field` and `summary`,
 * plus the request's session, a full `text` result for frozen passages, and `prime`.
 */
export function protectedPayloadScrubber(store: Store, hosted: boolean, accountScope: string | undefined, context: string) {
  const session = pseudonymSession(context);
  const rosters = new Map<string, EffectiveRoster>();
  const counts: ProtectionCounts = {};
  const roster = (courseId: string) => {
    let r = rosters.get(courseId);
    if (!r) rosters.set(courseId, (r = ACCOUNT_WIDE.has(courseId) ? accountRoster(store, accountScope, courseId) : rosterFor(store, courseId, accountScope)));
    return r;
  };
  const text = (value: string, courseId: string, cls: ContentClass = "personal"): ProtectResult => {
    if (!hosted) return { text: value, spans: [], counts: {} };
    const result = protectText(value, roster(courseId), session, cls);
    for (const [k, n] of Object.entries(result.counts)) counts[k as RedactionKind] = (counts[k as RedactionKind] ?? 0) + n!;
    return result;
  };
  return {
    session,
    roster,
    prime(texts: Iterable<string | [string, ContentClass]>, courseId: string) {
      if (hosted) primeSession(session, texts, roster(courseId));
    },
    text,
    field: (value: string, courseId: string, cls: ContentClass = "personal") => text(value, courseId, cls).text,
    /** Replacement counts so far (never values), for a receipt. */
    counts: (): ProtectionCounts => ({ ...counts }),
    summary(courseId: string): RedactionSummary | undefined {
      if (!hosted) return undefined;
      return { applied: true, counts: { ...counts }, rosterVersion: roster(courseId).version, note: protectionNote };
    },
  };
}
export type ProtectedScrubber = ReturnType<typeof protectedPayloadScrubber>;

const PLACEHOLDER_KINDS: RedactionKind[] = [
  "student_id", "student_name", "person", "email", "netid", "phone", "secret_url", "card", "ssn", "campus_id", "dob", "address", "ip", "canvas_user",
];
const PLACEHOLDER_RE = new RegExp(
  `\\[(${[...PLACEHOLDER_KINDS].map(labelOf).sort((a, b) => b.length - a.length).join("|")})_(?:\\d+|SELF)\\]`,
  "g",
);
const KIND_OF = new Map(PLACEHOLDER_KINDS.map((k) => [labelOf(k), k]));
/** Replacements per kind in an outgoing payload, counted from its placeholders (never values). */
export function protectionCounts(payload: unknown): ProtectionCounts {
  const counts: ProtectionCounts = {};
  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const kind = KIND_OF.get(m[1]!)!;
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}
/** "3 names, 1 email, 1 phone replaced", for a receipt line. */
export function describeProtection(counts: ProtectionCounts | undefined): string {
  const nouns: Record<RedactionKind, [string, string]> = {
    student_name: ["name", "names"], person: ["sender", "senders"], email: ["email", "emails"], netid: ["NetID", "NetIDs"],
    student_id: ["student ID", "student IDs"], phone: ["phone", "phones"], secret_url: ["signed link", "signed links"],
    card: ["card number", "card numbers"], ssn: ["SSN", "SSNs"], campus_id: ["campus ID", "campus IDs"],
    dob: ["date of birth", "dates of birth"], address: ["address", "addresses"], ip: ["IP address", "IP addresses"],
    canvas_user: ["Canvas user ID", "Canvas user IDs"],
  };
  const parts = Object.entries(counts ?? {})
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${nouns[k as RedactionKind][n === 1 ? 0 : 1]}`);
  return parts.length ? `${parts.join(", ")} replaced` : "nothing replaced";
}

// --- citations against the protected projection ----------------------------------------------
function fieldText(r: Resource, field: CitationResult["field"]) {
  return field === "title" ? r.title : field === "policy" ? r.policy.evidence : r.text;
}
interface Projection { resourceId: string; contentHash: string; field: CitationResult["field"]; result: ScrubResult; start: number; end: number }
const projections = new WeakMap<Store, Map<string, Projection>>();
export function clearProtectedProjections(store: Store) {
  projections.delete(store);
}
/**
 * As identity.ts's `outgoingProjection`, over the protected text. Pass the request's scrubber
 * so the projection's placeholders are the ones in the payload.
 */
export function protectedProjection(
  store: Store,
  resource: Resource,
  field: CitationResult["field"] = "text",
  range?: { start: number; end: number },
  scrubber?: ProtectedScrubber,
) {
  const scope = store.sources().find((s) => s.id === resource.sourceId)?.accountScope;
  const s = scrubber ?? protectedPayloadScrubber(store, true, scope, `projection:${resource.courseId}`);
  const result = s.text(fieldText(resource, field), resource.courseId, field === "text" ? classOf(resource) : "teaching");
  const start = Math.max(0, range?.start ?? 0), end = Math.min(result.text.length, range?.end ?? result.text.length);
  // Where the protected text equals the roster scrubber's, hand out identity.ts's projection, so
  // its own validateCitations keeps working; otherwise only validateProtectedCitations resolves it.
  const legacy = outgoingProjection(store, resource, field, range, s.roster(resource.courseId));
  if (legacy.start === start && legacy.end === end && legacy.text === result.text.slice(start, end)) return legacy;
  const id = randomUUID();
  let cache = projections.get(store);
  if (!cache) projections.set(store, (cache = new Map()));
  if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
  cache.set(id, { resourceId: resource.id, contentHash: resource.contentHash, field, result, start, end });
  return { id, text: result.text.slice(start, end), start, end };
}
/** validateCitations for protected projections; every other claim goes to identity.ts unchanged. */
export function validateProtectedCitations(store: Store, claims: CitationClaim[]): CitationResult[] {
  return claims.map((raw, index) => {
    const claim = citationClaimSchema.parse(raw);
    const projection = claim.basis === "outgoing" && claim.projectionId ? projections.get(store)?.get(claim.projectionId) : undefined;
    if (!projection) return { ...validateCitations(store, [raw])[0]!, index };
    const head = { index, resourceId: claim.resourceId, contentHash: claim.contentHash, field: claim.field };
    const fail = (reason: CitationResult["reason"], extra: Partial<CitationResult> = {}): CitationResult => ({ ...head, status: "unsupported", reason, ...extra });
    const r = store.resource(claim.resourceId);
    if (!r || r.deleted) return fail("source_missing");
    if (r.contentHash !== claim.contentHash) return fail("stale_version");
    if (projection.resourceId !== r.id || projection.contentHash !== r.contentHash || projection.field !== claim.field) return fail("projection_missing");
    const scrubbed = projection.result;
    let start: number;
    if (claim.start !== undefined) {
      if (scrubbed.text.slice(claim.start, claim.end) !== claim.quote || claim.end! - claim.start !== claim.quote.length) return fail("offset_mismatch");
      start = claim.start;
    } else {
      const hits: number[] = [];
      for (let i = scrubbed.text.indexOf(claim.quote, projection.start); i !== -1 && i + claim.quote.length <= projection.end; i = scrubbed.text.indexOf(claim.quote, i + 1)) hits.push(i);
      if (!hits.length) return fail("quote_not_found");
      if (hits.length > 1) return fail("ambiguous_quote");
      start = hits[0]!;
    }
    const end = start + claim.quote.length;
    if (start < projection.start || end > projection.end) return fail("outside_projection");
    const mapped = toOriginalSpan(scrubbed, start, end);
    if (!mapped) return fail("quote_splits_redaction", { cited: { start, end } });
    const original = fieldText(r, claim.field);
    return {
      ...head,
      status: "supported",
      cited: { start, end },
      original: { ...mapped, text: original.slice(mapped.start, mapped.end) },
      containsRedaction: scrubbed.spans.some((s) => s.start < end && start < s.end),
    };
  });
}

// --- mail -------------------------------------------------------------------------------------
/**
 * The hosted form of one message (for mail.gist and any mail-reading prompt): subject, preview
 * and gist protected as course text; the sender's name and address always pseudonymised, except
 * a sender named on the course's retain list (an instructor), whose name is kept.
 */
export function protectMail(
  message: { subject: string; mail: Pick<MailMetadata, "fromName" | "fromAddress" | "preview" | "gist" | "category" | "receivedAt"> },
  roster: EffectiveRoster,
  session: PseudonymSession,
) {
  const p = (v: string) => protectText(v, roster, session).text;
  const retained = new Set(roster.retain.map(lower));
  const name = message.mail.fromName?.trim();
  let from: string | undefined;
  if (name) {
    const scrubbed = protectText(name, roster, session);
    from = scrubbed.spans.length ? scrubbed.text : retained.has(lower(name)) ? name : session.placeholder("person", lower(name));
  }
  const address = message.mail.fromAddress?.trim();
  return {
    subject: p(message.subject),
    ...(from ? { from } : {}),
    ...(address ? { fromAddress: session.placeholder("email", lower(address)) } : {}),
    receivedAt: message.mail.receivedAt,
    category: message.mail.category,
    preview: p(message.mail.preview),
    ...(message.mail.gist ? { gist: p(message.mail.gist) } : {}),
  };
}
