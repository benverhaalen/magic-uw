import { createHash, createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { planningCaptureSchema, planningSubjectSchema, type PlanningCapture, type PlanningSubject } from "@magic/contracts";
import { UwPlanningHttp, type UwPlanningReadResult } from "./uw-planning-http";
import { normalizeUwPublicTerms, normalizeUwStudentInfo, normalizeUwSubjectsMap, verifyMyUwSession, getUwPrimaryTerm, uwAddDropWindow } from "./uw-planning-profile";
import { normalizeUwCurrentEnrollment } from "./uw-planning-enrollment";
import { pullUwDegreePlanHistory } from "./uw-planning-history";
import { pullUwSavedAudits } from "./uw-planning-audit";

type PrivateSource = "uw_enroll" | "uw_myuw" | "uw_dars";
/** Requests that reached the network during one sync (cached refusals excluded). */
export interface UwPlanningSyncMetrics {
  requests: number; bytes: number; ms: number;
  hosts: Record<string, { requests: number; bytes: number; ms: number }>;
}
export interface UwPlanningSyncResult {
  captures: PlanningCapture[];
  /** Failed service reads invalidate older evidence without deleting it. */
  invalidated: Array<{ source: PrivateSource; status: "blocked" | "failed"; code: string }>;
  /** Stored saved reports DARS listed again; the worker re-observes them without a download. */
  reconfirmed?: Array<{ accountScope: string; scopeKey: string; reportId: string }>;
  metrics?: UwPlanningSyncMetrics;
  /** The current term's add/drop window from published term dates, when the terms were read. */
  addDrop?: { start: string; end: string } | null;
  /** The soft deadline passed: what arrived is kept, unfinished reads are marked refresh_failed. */
  partial?: boolean;
}
const storedAuditSchema = z.array(z.object({ accountScope: z.string().regex(/^uw-account:[a-f0-9]{64}$/), reportId: z.string().regex(/^\d{1,30}$/) }).strict()).max(1000);
const freshSubjectsSchema = z.array(planningSubjectSchema).min(1).max(5000);
export interface UwPlanningSyncOptions {
  http: Pick<UwPlanningHttp, "read">;
  /** Random installation/session seed, held by the native broker, never a credential. */
  accountSeed: string;
  signal?: AbortSignal;
  /**
   * A soft deadline. When it fires, reads in flight end as `refresh_failed`, later reads are not
   * started, and the identity is rechecked on its own short budget so arrived rows are kept.
   * `signal` stays the hard cancel (sign-out, purge): it still discards everything.
   */
  deadline?: AbortSignal;
  /** Saved reports already stored with complete coverage (untrusted hint from the worker). */
  storedAudits?: unknown;
  /** Stored search subjects while term-fresh: the public terms and subjects reads are skipped. */
  freshSubjects?: unknown;
  recheckTimeoutMs?: number;
  now?: () => Date;
  /**
   * fix/current-courses-only. "enrollment": the student record and this term's enrollment only
   * (onboarding needs them before choosing courses); degree history and saved audits are left
   * for the full read that follows in the background, and are not marked unconfirmed.
   */
  phase?: "enrollment";
}
const identitySchema = z.object({ personAttributes: z.object({ emplid: z.string().regex(/^\d{1,30}$/) }) });
const urls = {
  student: "https://enroll.wisc.edu/api/enroll/v1/studentInfo",
  myuw: "https://my.wisc.edu/portal/web/session.json",
  audits: "https://enroll.wisc.edu/api/dars/audit-metadata",
  terms: "https://public.enroll.wisc.edu/api/search/v1/aggregate",
  subjects: "https://enroll.wisc.edu/api/search/v1/subjectsMap/0000",
};
const identity = (value: unknown) => {
  const parsed = identitySchema.safeParse(value);
  return parsed.success ? parsed.data.personAttributes.emplid : null;
};
const loginSchema = z.object({ personAttributes: z.object({ email: z.string(), netid: z.string() }) });
const canvasIdentitySchema = z.object({ id: z.union([z.number().int().positive().safe(), z.string().regex(/^[1-9]\d{0,29}$/)]), login_id: z.string() });
function sameInstitutionalLogin(student: unknown, canvas: unknown): string | null {
  const s = loginSchema.safeParse(student), c = canvasIdentitySchema.safeParse(canvas);
  if (!s.success || !c.success) return null;
  const email = s.data.personAttributes.email.trim().toLowerCase();
  if (!/^[a-z0-9._-]+@wisc\.edu$/.test(email) || email !== c.data.login_id.trim().toLowerCase() ||
      email.split("@")[0] !== s.data.personAttributes.netid.trim().toLowerCase()) return null;
  return String(c.data.id);
}
function failure(result: UwPlanningReadResult): { status: "blocked" | "failed"; code: string } {
  return result.status === "ok" ? { status: "failed", code: "response_schema_unverified" }
    : { status: ["needs_sign_in", "forbidden", "rate_limited"].includes(result.status) ? "blocked" : "failed", code: result.code };
}

/** Runs only in the native process. Raw UW identities, credentials and reports are
 * reduced here; only normalized captures cross into the worker and renderer.
 * Recheck identity before releasing any private rows, including after partial errors.
 */
export async function syncUwPlanning(options: UwPlanningSyncOptions): Promise<UwPlanningSyncResult> {
  if (options.accountSeed.length < 32) throw new Error("A private planning account seed is required.");
  const { http, signal, deadline } = options;
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  const captures: PlanningCapture[] = [], privateCaptures: PlanningCapture[] = [];
  const invalidated: UwPlanningSyncResult["invalidated"] = [];
  const fallbackScope = `uw-account:${createHmac("sha256", options.accountSeed).update("unverified-session").digest("hex")}`;
  // owner: planning-perf. Cost of this sync, from each read's own metadata (so concurrent public
  // reads through the shared client are not counted).
  const metrics: UwPlanningSyncMetrics = { requests: 0, bytes: 0, ms: 0, hosts: {} };
  const meter = (result: UwPlanningReadResult) => {
    if (result.status !== "ok" && (result.cached || (result.httpStatus === undefined && result.code !== "transport_failure"))) return;
    const entry = (metrics.hosts[result.host ?? "unknown"] ??= { requests: 0, bytes: 0, ms: 0 });
    entry.requests++; entry.bytes += result.bytes; entry.ms += result.elapsedMs;
    metrics.requests++; metrics.bytes += result.bytes; metrics.ms += result.elapsedMs;
  };
  const readSignal = signal && deadline ? AbortSignal.any([signal, deadline]) : signal ?? deadline;
  const unfinished = (): UwPlanningReadResult => ({ status: "error", code: "refresh_failed", bytes: 0, elapsedMs: 0, schemaVerified: false });
  // Past the deadline a read ends as refresh_failed, so each source keeps what already arrived.
  const read = async (request: Parameters<UwPlanningHttp["read"]>[0]) => {
    signal?.throwIfAborted();
    if (deadline?.aborted) return unfinished();
    const result = await http.read(request, readSignal);
    meter(result);
    signal?.throwIfAborted();
    return deadline?.aborted && result.status !== "ok" ? unfinished() : result;
  };
  const client: Pick<UwPlanningHttp, "read"> = { read: (request) => read(request) };
  // The identity recheck has its own short budget: a passed deadline must not strand arrived rows.
  const recheck = async (request: Parameters<UwPlanningHttp["read"]>[0]) => {
    signal?.throwIfAborted();
    const budget = AbortSignal.timeout(options.recheckTimeoutMs ?? 10_000);
    const result = await http.read(request, signal ? AbortSignal.any([signal, budget]) : budget);
    meter(result);
    signal?.throwIfAborted();
    return result;
  };
  const storedAudits = storedAuditSchema.safeParse(options.storedAudits ?? []);
  const fresh = options.freshSubjects === undefined ? null : freshSubjectsSchema.safeParse(options.freshSubjects);
  const freshSubjects: PlanningSubject[] | null = fresh?.success ? fresh.data : null;
  const reconfirmed: Array<{ scopeKey: string; reportId: string }> = [];
  // end owner: planning-perf
  const health = (source: PlanningCapture["source"], accountScope: string, scope: PlanningCapture["scope"], sourceUrl: string,
    status: PlanningCapture["status"], code: string, message: string): PlanningCapture => planningCaptureSchema.parse({
      schemaVersion: 1, id: randomUUID(), source, accountScope, scope, sourceUrl, observedAt,
      status, completeness: status === "complete" ? "complete" : "unknown", records: [], diagnostics: [{ code, message }],
    });
  const [student, aggregate, portal] = await Promise.all([
    read({ kind: "student-info" }), freshSubjects ? Promise.resolve(null) : read({ kind: "public-terms" }), read({ kind: "myuw-session" }),
  ]);
  const personId = student.status === "ok" ? identity(student.data) : null;
  const accountScope = personId ? `uw-account:${createHmac("sha256", options.accountSeed).update(`uw-enroll:${personId}`).digest("hex")}` : fallbackScope;
  if (!aggregate) { /* Term-fresh public terms and subjects are not re-read (owner: planning-perf). */ }
  else if (aggregate.status === "ok") captures.push(normalizeUwPublicTerms(aggregate.data, observedAt));
  else captures.push(health("uw_public", "public", { kind: "terms", key: "public-search-terms" }, urls.terms, failure(aggregate).status, failure(aggregate).code, "The search term list could not be refreshed. Saved terms were retained."));
  const portalValid = portal.status === "ok" && verifyMyUwSession(portal.data);
  // A portal connection is independent of Course Search & Enroll identity; no portal
  // academic records are imported or attributed to that account from this check.
  captures.push(health("uw_myuw", fallbackScope, { kind: "student_record", key: "connection:myuw-session" }, urls.myuw,
    portalValid ? "complete" : failure(portal).status, portalValid ? "session_available" : failure(portal).code,
    portalValid ? "My UW returned a recognized session response. No academic records or identity were imported from this check." : "My UW could not be verified. Course Search & Enroll has its own connection status."));
  if (!portalValid) invalidated.push({ source: "uw_myuw", ...failure(portal) });
  const subjects = aggregate ? await read({ kind: "subjects-map" }) : null;
  if (!subjects || !aggregate) { /* skipped while term-fresh */ }
  else if (subjects.status === "ok" && aggregate.status === "ok") captures.push(normalizeUwSubjectsMap(subjects.data, aggregate.data, observedAt));
  else captures.push(health("uw_public", "public", { kind: "subjects", key: "search-subjects-map:0000" }, urls.subjects, "failed", "subjects_unavailable", "Subject abbreviations and formal names could not both be verified. Saved subjects were retained."));
  if (!personId || student.status !== "ok") {
    const invalid = failure(student);
    captures.push(health("uw_enroll", fallbackScope, { kind: "student_record", key: "connection:student-info" }, urls.student, invalid.status, invalid.code, "The signed-in student could not be verified. Saved private records were retained and need refresh."));
    invalidated.push({ source: "uw_enroll", ...invalid }, { source: "uw_dars", ...invalid });
    return { captures, invalidated, reconfirmed: [], metrics, partial: Boolean(deadline?.aborted) };
  }
  privateCaptures.push(...normalizeUwStudentInfo(student.data, { accountScope, observedAt }));
  const canvas = await read({ kind: "canvas-profile" });
  const canvasId = canvas.status === "ok" ? sameInstitutionalLogin(student.data, canvas.data) : null;
  if (options.phase !== "enrollment") privateCaptures.push(await pullUwDegreePlanHistory(client, { accountScope, observedAt, signal }));
  const termCode = getUwPrimaryTerm(student.data);
  if (termCode) {
    const enrolled = await read({ kind: "current-enrollment", term: termCode });
    if (enrolled.status === "ok") privateCaptures.push(...normalizeUwCurrentEnrollment(enrolled.data, { accountScope, observedAt, termCode }));
    else privateCaptures.push(health("uw_enroll", accountScope, { kind: "enrollment_term", key: termCode }, `https://enroll.wisc.edu/api/enroll/v1/current/${termCode}`, failure(enrolled).status, failure(enrolled).code, "Current enrollment could not be refreshed. Saved enrollment was retained."));
  }
  if (termCode && options.phase !== "enrollment") {
    const auditSubjects = freshSubjects ?? captures.flatMap(c => c.records).filter(r => r.kind === "subject");
    const storedReportIds = new Set((storedAudits.success ? storedAudits.data : []).filter((row) => row.accountScope === accountScope).map((row) => row.reportId));
    privateCaptures.push(...await pullUwSavedAudits(client, { accountScope, observedAt, subjects: auditSubjects, currentTermCode: termCode, signal, storedReportIds, reconfirmed }));
  } else if (options.phase !== "enrollment") {
    privateCaptures.push(health("uw_dars", accountScope, { kind: "audit_program", key: "saved-audits" }, urls.audits, "partial", "audit_term_unverified", "A current academic term could not be verified. Saved audit evidence was retained."));
  }
  // Any old report not explicitly refreshed loses freshness, never its records.
  if (options.phase !== "enrollment")
    invalidated.push({ source: "uw_dars", status: "failed", code: deadline?.aborted ? "refresh_failed" : "audit_not_reconfirmed" });
  const rechecked = await recheck({ kind: "student-info" });
  if (rechecked.status !== "ok" || identity(rechecked.data) !== personId) {
    captures.push(health("uw_enroll", accountScope, { kind: "student_record", key: "connection:student-info" }, urls.student, "blocked", "account_recheck_failed", "The signed-in account changed or could not be rechecked. No new private records were saved; refresh after signing in."));
    invalidated.push({ source: "uw_enroll", status: "blocked", code: "account_recheck_failed" }, { source: "uw_dars", status: "blocked", code: "account_recheck_failed" });
    reconfirmed.length = 0;
  } else {
    // Names and a personal email are not identity proof. Bind only an exact UW
    // institutional login, then recheck both services before releasing the link.
    const laterCanvas = canvasId ? await recheck({ kind: "canvas-profile" }) : null;
    const bound = canvasId !== null && laterCanvas?.status === "ok" && sameInstitutionalLogin(rechecked.data, laterCanvas.data) === canvasId;
    const link = health("uw_enroll", accountScope, { kind: "student_record", key: "connection:canvas-account" }, urls.student,
      bound ? "complete" : "failed", bound ? "canvas_account_verified" : "canvas_account_unverified",
      bound ? "Canvas and Course Search & Enroll returned the same institutional login before and after the read. Identity fields were discarded." : "The Canvas account could not be matched to this student record. Cross-source course comparisons remain unavailable.");
    if (bound) link.records.push({ kind: "account_link", id: "canvas-account", canvasAccountScope: createHash("sha256").update(`https://canvas.wisc.edu\n${canvasId}`).digest("hex"), method: "matched_institutional_login", provenance: { sourceUrl: urls.student, observedAt, scope: link.scope } });
    privateCaptures.push(link);
    captures.push(health("uw_enroll", accountScope, { kind: "student_record", key: "connection:student-info" }, urls.student, "complete", "account_verified", "The same signed-in student was verified before and after the planning read."), ...privateCaptures);
  }
  signal?.throwIfAborted();
  const addDrop = aggregate?.status === "ok" && termCode ? uwAddDropWindow(aggregate.data, termCode) : null;
  return { captures, invalidated, reconfirmed: reconfirmed.map((row) => ({ accountScope, ...row })), metrics, partial: Boolean(deadline?.aborted), addDrop };
}
