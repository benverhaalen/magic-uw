import { z } from "zod";
import { planningCaptureSchema, type PlanningCapture, type PlanningGradeDistribution, type PlanningRecord } from "@magic/contracts";
import { canonicalizeCourseKey, type CourseIdentityTable } from "../../domain/src/planning";

/**
 * Madgrades (https://api.madgrades.com/v1) historical UW–Madison grade distributions.
 *
 * Shapes follow the server source (Madgrades/api.madgrades.com jbuilder views, camelCase keys via
 * `Jbuilder.key_format camelize: :lower`). The published openapi.yaml documents snake_case keys and a
 * flat `grade_distributions` array for /courses/{id}/grades that the source does not render, so keys are
 * normalized from either spelling and the nested source shape is required. No live response has been
 * checked by this project; fixtures are synthetic.
 */
export const MADGRADES_API_ORIGIN = "https://api.madgrades.com";
export const MADGRADES_SITE_ORIGIN = "https://madgrades.com";
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const madgradesTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const madgradesRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("course-search"), subjectCode: z.string().regex(/^\d{1,6}$/), number: z.string().regex(/^[1-9]\d{0,3}$/) }),
  z.strictObject({ kind: z.literal("course"), uuid }),
  z.strictObject({ kind: z.literal("course-grades"), uuid }),
]);
export type MadgradesRequest = z.infer<typeof madgradesRequestSchema>;
export type MadgradesFailure = "missing_token" | "unauthorized" | "not_found" | "rate_limited" | "cancelled" | "invalid_response" | "error";
export type MadgradesReadResult =
  | { status: "ok"; data: unknown }
  | { status: MadgradesFailure; code: string; retryAfterMs?: number };
/** The only surface core needs; the desktop host owns the token and performs the request. */
export interface MadgradesTransport {
  read(request: MadgradesRequest, signal?: AbortSignal): Promise<MadgradesReadResult>;
}

export function madgradesUrl(input: MadgradesRequest): string {
  const request = madgradesRequestSchema.parse(input);
  if (request.kind === "course-search")
    return `${MADGRADES_API_ORIGIN}/v1/courses?subject=${request.subjectCode}&number=${request.number}&per_page=25&page=1`;
  return `${MADGRADES_API_ORIGIN}/v1/courses/${request.uuid.toLowerCase()}${request.kind === "course-grades" ? "/grades" : ""}`;
}

export interface MadgradesHttpOptions {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Reads the locally protected token for each request; the value never enters results, records, or errors. */
  token: () => Promise<string | null | undefined>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  minSpacingMs?: number;
  requestTimeoutMs?: number;
}
const MAX_BYTES = 4 * 1024 * 1024;
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * One request at a time with host pacing. The server source throttles 150 requests/minute per IP
 * (rack_attack.rb); the default one-second spacing stays well below it and is a precaution, not a
 * measured limit. A 429 suppresses reads until Retry-After instead of retrying.
 */
export class MadgradesHttp implements MadgradesTransport {
  private tail: Promise<unknown> = Promise.resolve();
  private nextStart = 0;
  private suppressedUntil = 0;
  private readonly now: () => number;
  private readonly spacing: number;
  private readonly timeout: number;
  constructor(private readonly options: MadgradesHttpOptions) {
    this.now = options.now ?? Date.now;
    this.spacing = Math.max(0, Math.min(60_000, options.minSpacingMs ?? 1000));
    this.timeout = Math.max(1, Math.min(120_000, options.requestTimeoutMs ?? 15_000));
  }
  read(input: MadgradesRequest, signal?: AbortSignal): Promise<MadgradesReadResult> {
    const parsed = madgradesRequestSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve({ status: "invalid_response", code: "invalid_request" });
    const operation = this.tail.then(() => this.perform(parsed.data, signal));
    this.tail = operation.catch(() => {});
    return operation.catch(() => ({ status: signal?.aborted ? "cancelled" : "error", code: signal?.aborted ? "cancelled" : "transport_failure" }));
  }
  private async perform(request: MadgradesRequest, signal?: AbortSignal): Promise<MadgradesReadResult> {
    if (signal?.aborted) return { status: "cancelled", code: "cancelled" };
    let token: string | null | undefined;
    try { token = await this.options.token(); }
    catch { return { status: "missing_token", code: "token_unavailable" }; }
    if (!token) return { status: "missing_token", code: "token_missing" };
    if (!madgradesTokenSchema.safeParse(token).success) return { status: "missing_token", code: "token_format" };
    const suppressed = this.suppressedUntil - this.now();
    if (suppressed > 0) return { status: "rate_limited", code: "host_rate_limited", retryAfterMs: suppressed };
    try { await (this.options.sleep ?? delay)(Math.max(0, this.nextStart - this.now()), signal); }
    catch { return { status: signal?.aborted ? "cancelled" : "error", code: signal?.aborted ? "cancelled" : "pacing_failed" }; }
    if (signal?.aborted) return { status: "cancelled", code: "cancelled" };
    this.nextStart = this.now() + this.spacing;
    const url = madgradesUrl(request);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeout);
    const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    let response: Response | undefined;
    try {
      response = await this.options.fetch(url, {
        method: "GET",
        // Never follow a redirect: the Authorization header must not reach another URL.
        redirect: "manual", credentials: "omit",
        headers: { Accept: "application/json", Authorization: `Token token=${token}` },
        signal: requestSignal,
      });
      if (response.status === 401) return { status: "unauthorized", code: "unauthorized" };
      if (response.status === 404) return { status: "not_found", code: "not_found" };
      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        const wait = header && /^\d+$/.test(header.trim()) ? Number(header) * 1000 : 60_000;
        this.suppressedUntil = this.now() + wait;
        return { status: "rate_limited", code: "host_rate_limited", retryAfterMs: wait };
      }
      if (response.status >= 300 && response.status < 400 || response.type === "opaqueredirect") return { status: "invalid_response", code: "unexpected_redirect" };
      if (!response.ok) return { status: "error", code: "http_failure" };
      if (Number(response.headers.get("content-length")) > MAX_BYTES) return { status: "invalid_response", code: "response_byte_limit" };
      let text = "", bytes = 0;
      if (response.body) {
        const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) { text += decoder.decode(); break; }
            bytes += chunk.value.byteLength;
            if (bytes > MAX_BYTES) return { status: "invalid_response", code: "response_byte_limit" };
            text += decoder.decode(chunk.value, { stream: true });
          }
        } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      try { return { status: "ok", data: JSON.parse(text) as unknown }; }
      catch { return { status: "invalid_response", code: "invalid_json" }; }
    } catch {
      return { status: signal?.aborted ? "cancelled" : "error", code: signal?.aborted ? "cancelled" : timeout.signal.aborted ? "request_timeout" : "transport_failure" };
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }
}

/** Bounded snake_case → camelCase key normalization (the OpenAPI document and the server source disagree). */
function camelize(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.slice(0, 2000).map((item) => camelize(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), camelize(item, depth + 1)]));
  return value;
}
const count = z.number().int().min(0).max(10_000_000);
export const MADGRADES_GRADE_FIELDS = [
  ["A", "aCount"], ["AB", "abCount"], ["B", "bCount"], ["BC", "bcCount"], ["C", "cCount"], ["D", "dCount"], ["F", "fCount"],
  ["S", "sCount"], ["U", "uCount"], ["CR", "crCount"], ["N", "nCount"], ["P", "pCount"], ["I", "iCount"],
  ["NW", "nwCount"], ["NR", "nrCount"], ["OTHER", "otherCount"],
] as const;
const countsShape = Object.fromEntries(MADGRADES_GRADE_FIELDS.map(([, key]) => [key, count])) as Record<(typeof MADGRADES_GRADE_FIELDS)[number][1], typeof count>;
const distribution = z.object({ total: count, ...countsShape });
type Distribution = z.infer<typeof distribution>;
const subjectSchema = z.object({ code: z.string().regex(/^\d{1,6}$/), name: z.string().max(300).optional(), abbreviation: z.string().max(100).optional() });
const courseSchema = z.object({ uuid, number: z.number().int().min(0).max(99999), name: z.string().max(500).optional(), subjects: z.array(subjectSchema).min(1).max(50) });
export type MadgradesCourse = z.infer<typeof courseSchema>;
const courseSearchSchema = z.object({ totalCount: z.number().int().min(0), results: z.array(courseSchema).max(100) });
const courseDetailSchema = courseSchema.extend({ courseOfferings: z.array(z.object({ uuid, termCode: z.number().int() })).max(1000) });
const gradesSchema = z.object({
  courseUuid: uuid, cumulative: distribution,
  courseOfferings: z.array(z.object({
    termCode: z.number().int(), cumulative: distribution,
    sections: z.array(distribution.extend({ sectionNumber: z.number().int().min(0).max(99999), instructors: z.array(z.object({ id: z.number().int().min(0), name: z.string().max(200) })).max(30) })).max(1000),
  })).max(1000),
});
export const parseMadgradesCourseSearch = (data: unknown) => courseSearchSchema.safeParse(camelize(data));
export const parseMadgradesCourse = (data: unknown) => courseDetailSchema.safeParse(camelize(data));
export const parseMadgradesGrades = (data: unknown) => gradesSchema.safeParse(camelize(data));

/** Keys that the local identity table explicitly declares equivalent to this course (including itself). */
export function courseKeyGroup(courseKey: string, table: CourseIdentityTable): string[] {
  const canonical = canonicalizeCourseKey(courseKey, table);
  return [...new Set([canonical, courseKey, ...[...table.crosslists].filter(([, value]) => value === canonical).map(([key]) => key)])].sort();
}
export type MadgradesResolution =
  | { status: "resolved"; course: MadgradesCourse; courseKeys: string[] }
  | { status: "not_found" | "ambiguous" | "unverified_crosslist"; reason: string };
/**
 * Exact identity only: numeric subject code + catalog number, and every Madgrades cross-listed subject must be
 * explicitly equivalent in the local identity table. Course names are never compared.
 */
export function resolveMadgradesCourse(courseKey: string, table: CourseIdentityTable, candidates: MadgradesCourse[]): MadgradesResolution {
  const canonical = canonicalizeCourseKey(courseKey, table);
  const keysOf = (course: MadgradesCourse) => [...new Set(course.subjects.map((subject) => `uw:${subject.code}:${course.number}`))];
  const matching = new Map<string, MadgradesCourse>();
  for (const course of candidates)
    if (keysOf(course).some((key) => canonicalizeCourseKey(key, table) === canonical)) matching.set(course.uuid.toLowerCase(), course);
  if (!matching.size) return { status: "not_found", reason: "No Madgrades course has this exact subject code and catalog number." };
  if (matching.size > 1) return { status: "ambiguous", reason: "Several Madgrades courses match this course identity; they are not combined." };
  const course = [...matching.values()][0];
  const keys = keysOf(course);
  if (keys.some((key) => canonicalizeCourseKey(key, table) !== canonical))
    return { status: "unverified_crosslist", reason: "Madgrades lists another subject for this course without matching local cross-list evidence." };
  return { status: "resolved", course, courseKeys: keys.sort() };
}

const empty = (): Distribution => ({ total: 0, ...Object.fromEntries(MADGRADES_GRADE_FIELDS.map(([, key]) => [key, 0])) } as Distribution);
const sameCounts = (a: Distribution, b: Distribution) => a.total === b.total && MADGRADES_GRADE_FIELDS.every(([, key]) => a[key] === b[key]);
const consistent = (row: Distribution) => MADGRADES_GRADE_FIELDS.reduce((sum, [, key]) => sum + row[key], 0) === row.total;
const counts = (row: Distribution) => MADGRADES_GRADE_FIELDS.map(([grade, key]) => ({ grade, count: row[key] }));

export function normalizeMadgradesGrades(input: {
  courseKey: string; table: CourseIdentityTable; course: z.infer<typeof courseDetailSchema>; grades: z.infer<typeof gradesSchema>; observedAt: string;
}): PlanningCapture {
  const canonical = canonicalizeCourseKey(input.courseKey, input.table);
  const id = input.course.uuid.toLowerCase();
  const scope = { kind: "grade_course" as const, key: `madgrades:${canonical}` };
  const provenance = { sourceUrl: `${MADGRADES_SITE_ORIGIN}/courses/${id}`, observedAt: input.observedAt, scope };
  const records: PlanningGradeDistribution[] = [];
  const diagnostics: { code: string; message: string }[] = [{ code: "madgrades_instructor_join",
    message: "Madgrades course grades include only sections linked to an instructor, so term rows are partial. Averages are historical evidence, not predictions or rankings." }];
  const omitted = { term: 0, ambiguous: 0, inconsistent: 0, limit: 0 };
  const offeringsPerTerm = new Map<number, number>();
  for (const offering of input.course.courseOfferings) offeringsPerTerm.set(offering.termCode, (offeringsPerTerm.get(offering.termCode) ?? 0) + 1);
  const seenTerms = new Set<number>();
  const duplicateTerms = new Set(input.grades.courseOfferings.map((row) => row.termCode).filter((term) => seenTerms.has(term) || !seenTerms.add(term)));
  const sum = empty();
  for (const offering of [...input.grades.courseOfferings].sort((a, b) => b.termCode - a.termCode)) {
    const termCode = String(offering.termCode);
    if (!/^1\d{2}[246]$/.test(termCode)) { omitted.term++; continue; }
    // The source groups sections by number within a term. Two offerings in one term (for example topics)
    // can collide there, so that term's rows cannot be attributed and are omitted.
    if (duplicateTerms.has(offering.termCode) || offeringsPerTerm.get(offering.termCode) !== 1) { omitted.ambiguous++; continue; }
    const numbers = offering.sections.map((section) => section.sectionNumber);
    const total = offering.sections.reduce((acc, section) => {
      const next = { ...acc }; for (const key of ["total", ...MADGRADES_GRADE_FIELDS.map(([, k]) => k)] as const) next[key] += section[key]; return next;
    }, empty());
    if (new Set(numbers).size !== numbers.length || !sameCounts(total, offering.cumulative) || !consistent(offering.cumulative) || offering.sections.some((section) => !consistent(section))) { omitted.inconsistent++; continue; }
    if (records.length + offering.sections.length + 1 > 9000) { omitted.limit++; continue; }
    records.push({ id: `madgrades:${id}:${termCode}`, kind: "grade_distribution", provenance, courseKey: canonical, termCode, section: null,
      instructorNames: [], counts: counts(offering.cumulative), coverage: "partial" });
    for (const section of [...offering.sections].sort((a, b) => a.sectionNumber - b.sectionNumber)) {
      const instructors = [...new Map(section.instructors.map((row) => [row.id, row])).values()].sort((a, b) => a.id - b.id);
      records.push({ id: `madgrades:${id}:${termCode}:${section.sectionNumber}`, kind: "grade_distribution", provenance, courseKey: canonical, termCode,
        section: String(section.sectionNumber).padStart(3, "0"), instructorNames: instructors.map((row) => row.name.replace(/\s+/g, " ").trim()).filter(Boolean),
        instructorIds: instructors.map((row) => String(row.id)), counts: counts(section), coverage: "published" });
    }
    for (const key of ["total", ...MADGRADES_GRADE_FIELDS.map(([, k]) => k)] as const) sum[key] += offering.cumulative[key];
  }
  if (omitted.term) diagnostics.push({ code: "unsupported_term_code", message: `${omitted.term} terms had term codes outside the UW codec and were omitted.` });
  if (omitted.ambiguous) diagnostics.push({ code: "ambiguous_term_offerings", message: `${omitted.ambiguous} terms had several Madgrades offerings or duplicate rows; their sections cannot be attributed and were omitted.` });
  if (omitted.inconsistent) diagnostics.push({ code: "inconsistent_term_counts", message: `${omitted.inconsistent} terms had section counts that did not match their published totals and were omitted.` });
  if (omitted.limit) diagnostics.push({ code: "record_limit", message: `${omitted.limit} older terms were omitted to stay within local record bounds.` });
  const dropped = omitted.term + omitted.ambiguous + omitted.inconsistent + omitted.limit;
  if (!dropped && !sameCounts(sum, input.grades.cumulative)) diagnostics.push({ code: "cumulative_mismatch", message: "The published all-term total differs from the sum of term totals; the saved terms need verification." });
  const complete = dropped === 0 && diagnostics.length === 1;
  return planningCaptureSchema.parse({
    schemaVersion: 1, id: `madgrades-${canonical}-${input.observedAt}`, accountScope: "public", source: "madgrades", scope,
    sourceUrl: `${MADGRADES_API_ORIGIN}/v1/courses/${id}/grades`, observedAt: input.observedAt,
    status: complete ? "complete" : "partial", completeness: complete ? "complete" : "partial",
    records: records as PlanningRecord[], diagnostics,
  });
}

export type MadgradesPullStatus = "saved" | "not_found" | "ambiguous" | "unverified_crosslist" | "unsupported_identity" | MadgradesFailure;
export interface MadgradesPullResult { status: MadgradesPullStatus; message: string; capture: PlanningCapture | null }
const failureMessages: Record<MadgradesFailure, string> = {
  missing_token: "Add a Madgrades API token to load historical grade distributions. Saved evidence was kept.",
  unauthorized: "Madgrades rejected the saved token. Replace it to refresh; saved evidence was kept.",
  not_found: "Madgrades has no record for this course. Saved evidence was kept.",
  rate_limited: "Madgrades asked the app to slow down. Try again later; saved evidence was kept.",
  cancelled: "Madgrades read cancelled; no data was saved.",
  invalid_response: "Madgrades returned an unrecognized response. Saved evidence was kept.",
  error: "Madgrades could not be reached. Saved evidence was kept.",
};

/** search (one request per explicitly equivalent key) → exact identity → course detail → grades → normalized capture. */
export async function pullMadgradesGrades(transport: MadgradesTransport, input: { courseKey: string; table: CourseIdentityTable; observedAt: string }, signal?: AbortSignal): Promise<MadgradesPullResult> {
  const fail = (status: MadgradesFailure): MadgradesPullResult => ({ status, message: failureMessages[status], capture: null });
  const canonical = canonicalizeCourseKey(input.courseKey, input.table);
  const group = courseKeyGroup(input.courseKey, input.table);
  const unresolved = (status: "not_found" | "ambiguous" | "unverified_crosslist" | "unsupported_identity", reason: string): MadgradesPullResult => {
    const [, subject, number] = canonical.split(":");
    return { status, message: `${reason} Grade evidence stays unresolved.`, capture: planningCaptureSchema.parse({
      schemaVersion: 1, id: `madgrades-${canonical}-${input.observedAt}`, accountScope: "public", source: "madgrades",
      scope: { kind: "grade_course", key: `madgrades:${canonical}` },
      sourceUrl: /^\d+$/.test(number ?? "") ? `${MADGRADES_API_ORIGIN}/v1/courses?subject=${subject}&number=${number}` : `${MADGRADES_API_ORIGIN}/v1/courses`,
      observedAt: input.observedAt, status: "unsupported", completeness: "unknown", records: [],
      diagnostics: [{ code: `madgrades_${status}`, message: reason.slice(0, 500) }],
    }) };
  };
  const searchable = group.map((key) => /^uw:(\d{1,6}):([1-9]\d{0,3})$/.exec(key));
  if (group.length > 8 || searchable.some((match) => !match))
    return unresolved("unsupported_identity", "This course identity cannot be searched exactly in Madgrades (non-numeric catalog number or too many cross-listed designations).");
  const candidates: MadgradesCourse[] = [];
  for (const match of searchable as RegExpExecArray[]) {
    signal?.throwIfAborted();
    const result = await transport.read({ kind: "course-search", subjectCode: match[1]!, number: match[2]! }, signal);
    if (result.status !== "ok") return fail(result.status);
    const parsed = parseMadgradesCourseSearch(result.data);
    if (!parsed.success) return fail("invalid_response");
    if (parsed.data.totalCount > parsed.data.results.length)
      return unresolved("ambiguous", "The exact Madgrades search returned more matches than one page; they are not combined.");
    candidates.push(...parsed.data.results.filter((course) => course.number === Number(match[2]) && course.subjects.some((subject) => subject.code === match[1])));
  }
  const resolution = resolveMadgradesCourse(canonical, input.table, candidates);
  if (resolution.status !== "resolved") return unresolved(resolution.status, resolution.reason);
  const uuidValue = resolution.course.uuid.toLowerCase();
  const detailResult = await transport.read({ kind: "course", uuid: uuidValue }, signal);
  if (detailResult.status !== "ok") return fail(detailResult.status);
  const detail = parseMadgradesCourse(detailResult.data);
  if (!detail.success) return fail("invalid_response");
  // The detail must describe the same identity that the search established.
  const recheck = resolveMadgradesCourse(canonical, input.table, [detail.data]);
  if (recheck.status !== "resolved" || detail.data.uuid.toLowerCase() !== uuidValue) return unresolved("unverified_crosslist", "The Madgrades course detail disagrees with its search identity.");
  const gradesResult = await transport.read({ kind: "course-grades", uuid: uuidValue }, signal);
  if (gradesResult.status !== "ok") return fail(gradesResult.status);
  const grades = parseMadgradesGrades(gradesResult.data);
  if (!grades.success || grades.data.courseUuid.toLowerCase() !== uuidValue) return fail("invalid_response");
  signal?.throwIfAborted();
  const capture = normalizeMadgradesGrades({ courseKey: canonical, table: input.table, course: detail.data, grades: grades.data, observedAt: input.observedAt });
  const terms = capture.records.filter((row) => row.kind === "grade_distribution" && row.section === null).length;
  return { status: "saved", capture, message: `${terms} Madgrades terms saved as historical evidence${capture.status === "complete" ? "" : "; some terms were omitted"}. Averages are not predictions.` };
}
