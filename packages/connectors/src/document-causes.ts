// owner: acquisition. The real cause of each document read (RC3), in place of the old catch-all
// `document_read_incomplete`, for the capture diagnostic and the trial log. A cause carries a host
// (hostname only) or an extraction kind; never a URL, a query, a file name or a course name.
import { appendFile } from "node:fs/promises";
import type { CaptureDiagnostic } from "@magic/contracts";
import { CanvasFailure } from "./canvas-http.ts";
import { MaterialReadError, type CanvasFileHostClass } from "./network.ts";
import type { ExtractedDocument } from "./documents.ts";

export type DocumentCause =
  | "ok"
  | "redirect_blocked"
  | "secret_origin_blocked"
  | `http_${number}`
  | "too_large"
  | "extract_failed"
  | "needs_ocr"
  | "unsupported_type"
  | "needs_sign_in"
  | "reference_only"
  | "locked"
  | "network_error"
  | "timeout"
  | "metadata_invalid"
  | "read_failed";
export interface DocumentOutcome {
  cause: DocumentCause;
  /** A hostname only, for redirect and origin refusals. */
  host?: string;
  /** The extractor that failed (pdf, office, text), for extract_failed. */
  kind?: string;
}
const REDIRECT = new Set([
  "redirect_blocked",
  "redirect_outside_scope",
  "transport_redirect",
  "redirect_limit",
  "redirect_loop",
  "canvas_route_required",
]);
const safeHost = (host: string | undefined) =>
  host && /^[a-z0-9.-]{1,100}$/i.test(host) ? host.toLowerCase() : undefined;

export function causeFromError(error: unknown): DocumentOutcome {
  if (error instanceof CanvasFailure) {
    if (error.status === "needs_sign_in") return { cause: "needs_sign_in" };
    // canvas-http.ts: not_authorized is a 401 "unauthorized" or a 403; not_accessible a 404 or 410.
    if (error.code === "not_authorized") return { cause: "http_403" };
    if (error.code === "not_accessible") return { cause: "http_404" };
    if (error.code === "file_locked") return { cause: "locked" };
    if (error.code === "response_byte_limit") return { cause: "too_large" };
    return { cause: "read_failed" };
  }
  if (error instanceof MaterialReadError) {
    const host = safeHost(error.detail.host);
    if (REDIRECT.has(error.code)) return { cause: "redirect_blocked", ...(host ? { host } : {}) };
    if (error.code === "secret_origin_blocked" || error.code === "download_host_unverified")
      return { cause: "secret_origin_blocked", ...(host ? { host } : {}) };
    if (error.code === "byte_limit" || error.code === "office_expansion_limit")
      return { cause: "too_large" };
    if (error.detail.status && error.detail.status >= 400 && error.detail.status < 600)
      return { cause: `http_${error.detail.status}` };
    if (error.code === "inaccessible") return { cause: "http_403" };
    if (error.code === "not_found") return { cause: "http_404" };
    if (error.code === "login_page") return { cause: "needs_sign_in" };
    if (error.code === "network_error" || error.code === "empty_download")
      return { cause: "network_error" };
    if (error.code === "file_metadata_invalid") return { cause: "metadata_invalid" };
    if (error.code === "file_locked") return { cause: "locked" };
    return { cause: "read_failed" };
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    return { cause: "timeout" };
  return { cause: "read_failed" };
}

/** The extractor family, from the file name or content type; for extract_failed.<kind>. */
export function extractionKind(filename = "", contentType = ""): string {
  if (/\.pdf$/i.test(filename) || /pdf/i.test(contentType)) return "pdf";
  if (/\.(?:docx|pptx|xlsx|odt|odp|ods)$/i.test(filename) || /officedocument|opendocument/i.test(contentType))
    return "office";
  if (/\.(?:png|jpe?g|gif|bmp|tiff?|webp)$/i.test(filename) || /^image\//i.test(contentType))
    return "image";
  return "text";
}

export function causeFromExtraction(
  extracted: Pick<ExtractedDocument, "status" | "diagnostics">,
  kind: string,
): DocumentOutcome {
  if (extracted.status === "ok") return { cause: "ok" };
  if (extracted.status === "needs_ocr") return { cause: "needs_ocr" };
  if (extracted.status === "unsupported") return { cause: "unsupported_type" };
  if (extracted.diagnostics.some((d) => d === "byte_limit" || d === "office_expansion_limit"))
    return { cause: "too_large" };
  if (extracted.status === "partial") {
    // Text past the page or text limit: the text read is kept; the rest is too large to read.
    if (extracted.diagnostics.some((d) => d === "page_limit" || d === "text_limit"))
      return { cause: "too_large" };
    if (extracted.diagnostics.includes("textless_page")) return { cause: "needs_ocr" };
  }
  return { cause: "extract_failed", kind };
}

/** A capture diagnostic; the code matches the contract's `^[a-z0-9_.-]+$`, details go in `path`. */
export function causeDiagnostic(outcome: DocumentOutcome): CaptureDiagnostic {
  const code = outcome.cause === "extract_failed" && outcome.kind ? `extract_failed.${outcome.kind}` : outcome.cause;
  return {
    code,
    path: outcome.host ? ["host", outcome.host] : [],
    severity: outcome.cause === "ok" ? "warning" : outcome.cause === "needs_sign_in" ? "error" : "warning",
  };
}

export type DocumentHostClass = CanvasFileHostClass | "public" | "cache" | "unknown";
export interface DocumentTrialEvent {
  event: "document";
  hostClass: DocumentHostClass;
  status: string;
  cause: string;
  host?: string;
  bytes?: number;
  ms?: number;
}
/** The per-document trial-log line: host class, status, cause and bytes; no URL and no names. */
export function documentTrialEvent(
  outcome: DocumentOutcome,
  fields: { hostClass: DocumentHostClass; status: string; bytes?: number; ms?: number },
): DocumentTrialEvent {
  return {
    event: "document",
    hostClass: fields.hostClass,
    status: fields.status,
    cause: causeDiagnostic(outcome).code,
    ...(outcome.host ? { host: outcome.host } : {}),
    ...(fields.bytes !== undefined ? { bytes: fields.bytes } : {}),
    ...(fields.ms !== undefined ? { ms: Math.round(fields.ms) } : {}),
  };
}
/** Appends to the operator's trial log (MAGIC_TRIAL_LOG), only when it is set. */
export function trialLogDocument(event: DocumentTrialEvent, file = process.env.MAGIC_TRIAL_LOG) {
  if (!file) return;
  void appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n").catch(() => {});
}
