/**
 * Outlook through Microsoft Graph (T30): mail and calendar delta sync, code-first mail
 * categories, meeting capture, and the URL allowlist main enforces for the worker's proxy.
 *
 * - The worker never holds a token. It asks main for one Graph GET at a time (`GraphTransport`);
 *   main checks the URL against `checkedGraphUrl`, attaches the bearer token and answers with
 *   the status, a few headers and the body.
 * - Delta: `/me/mailFolders/{folder}/messages/delta` with `$select` limited to the stored fields
 *   and `/me/calendarView/delta` for a −14…+120 day window. Each `@odata.deltaLink` is kept
 *   per folder, so a check with nothing new costs one request per folder.
 *   https://learn.microsoft.com/graph/api/message-delta , .../event-delta (read 2026-09-26).
 * - Failures: 410 restarts that stream with a full sync (delta-query-overview); 429 and 503 wait
 *   `Retry-After`; 401 asks main for a silent token refresh and retries once.
 * - Outlook allows four concurrent requests per app and mailbox (graph/throttling-limits); this
 *   reader uses at most two.
 * - No body is stored. Mail keeps Graph's `bodyPreview` (≤255 characters).
 */
import { createHash } from "node:crypto";
import {
  captureBatchSchema,
  evidenceUrlSchema,
  mailMetadataSchema,
  resourceInputSchema,
  OUTLOOK_CALENDAR_COURSE_ID,
  OUTLOOK_MAIL_COURSE_ID,
  UNMAPPED_COURSE_ID,
  type CaptureBatch,
  type MailCategory,
  type MailMetadata,
  type ResourceInput,
} from "@magic/contracts";

export const GRAPH_ORIGIN = "https://graph.microsoft.com";
export const GRAPH_ROOT = `${GRAPH_ORIGIN}/v1.0`;
/**
 * The one first-time consent screen (lead, 2026-09-26): read mail, calendar, OneNote and the
 * student's OneDrive files, and write only inside the app's own OneDrive folder (Apps/<app>).
 * Grants are recorded per scope; a partial grant runs what was granted (`streamsFor`).
 */
export const GRAPH_READ_SCOPES = [
  "offline_access",
  "User.Read",
  "Calendars.Read",
  "Mail.Read",
  "Files.Read",
  "Notes.Read",
  "Files.ReadWrite.AppFolder",
] as const;
/** Optional; requested only when the student first confirms a calendar write. */
export const GRAPH_WRITE_SCOPE = "Calendars.ReadWrite";
/** Mail.Send and the meeting respond endpoints are never requested or called. */
export const GRAPH_FORBIDDEN_SCOPES = ["Mail.Send", "Mail.ReadWrite"] as const;
export const MAIL_SELECT = [
  "id",
  "conversationId",
  "from",
  "receivedDateTime",
  "subject",
  "bodyPreview",
  "importance",
  "hasAttachments",
  "webLink",
  "categories",
  "flag",
  "isRead",
] as const;
export const MAIL_WINDOW_DAYS = 45;
export const MAX_STORED_MESSAGES = 2000;
export const CALENDAR_PAST_DAYS = 14;
export const CALENDAR_AHEAD_DAYS = 120;
/** A calendar window older than this is re-based with a fresh delta (the window moves). */
export const CALENDAR_REBASE_DAYS = 7;
export const GRAPH_CONCURRENCY = 2;
const PREFER_PAGE = "odata.maxpagesize=100";
const PREFER_UTC = 'outlook.timezone="UTC"';

// ---------------------------------------------------------------------------------------------
// Main's allowlist
// ---------------------------------------------------------------------------------------------
const wellKnownFolder = /^(?:inbox|sentitems|archive|drafts|deleteditems|junkemail)$/i;
const graphId = "[A-Za-z0-9_=+/%!.-]{1,400}";
const readPaths = [
  new RegExp(`^/v1\\.0/me/mailFolders(?:/${graphId}|\\('${graphId}'\\))/messages/delta$`),
  /^\/v1\.0\/me\/calendarView\/delta$/,
  new RegExp(`^/v1\\.0/me/messages/${graphId}$`),
  /^\/v1\.0\/me\/onenote\/pages$/,
  new RegExp(`^/v1\\.0/me/onenote/pages/${graphId}/content$`),
  /^\/v1\.0\/me\/drive\/root\/delta(?:\(token='[^'/]{1,2000}'\))?$/,
  new RegExp(`^/v1\\.0/me/drive/items/${graphId}/content$`),
  /^\/v1\.0\/me\/drive\/special\/approot\/delta(?:\(token='[^'/]{1,2000}'\))?$/,
];
/** The one PUT: a file inside the app's own OneDrive folder (Files.ReadWrite.AppFolder). */
const appFolderPutPath = /^\/v1\.0\/me\/drive\/special\/approot:\/[^:\\]{1,400}:\/content$/;
const readParams = new Set([
  "$select",
  "$filter",
  "$expand",
  "$deltatoken",
  "$skiptoken",
  "startDateTime",
  "endDateTime",
  "startdatetime",
  "enddatetime",
  "$top",
  "$skip",
  "$orderby",
  "token",
]);
/** Upload types the app-folder PUT accepts (lecture notes). */
export const APP_FOLDER_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown",
  "text/plain",
  "application/pdf",
]);
/**
 * Main's check for the worker's Graph proxy: https, graph.microsoft.com, paths under
 * `/v1.0/me/` in the allowlist, and known query parameters. GET only, except one PUT into the
 * app's own folder. Throws on anything else.
 */
export function checkedGraphUrl(input: unknown, method: "GET" | "PUT" = "GET"): string {
  if (typeof input !== "string" || input.length > 8000) throw new Error("graph_url");
  const url = new URL(input);
  if (
    url.origin !== GRAPH_ORIGIN ||
    url.username ||
    url.password ||
    url.hash ||
    url.port
  )
    throw new Error("graph_url");
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    throw new Error("graph_url");
  }
  if (method === "PUT") {
    if (!appFolderPutPath.test(path) || path.includes("..") || url.search) throw new Error("graph_url");
    return url.href;
  }
  if (!readPaths.some((pattern) => pattern.test(path))) throw new Error("graph_url");
  for (const key of url.searchParams.keys())
    if (!readParams.has(key)) throw new Error("graph_url");
  return url.href;
}
/** Only these `Prefer` preferences cross to Graph. */
export function checkedGraphPrefer(input: unknown): string | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  if (typeof input !== "string" || input.length > 200) throw new Error("graph_prefer");
  const parts = input.split(",").map((p) => p.trim());
  for (const part of parts)
    if (
      !/^odata\.maxpagesize=\d{1,3}$/.test(part) &&
      part !== PREFER_UTC &&
      part !== 'outlook.body-content-type="text"'
    )
      throw new Error("graph_prefer");
  return parts.join(", ");
}
/** The only write: create one event in the student's own calendar (a confirmed proposal). */
export const GRAPH_CREATE_EVENT_URL = `${GRAPH_ROOT}/me/events`;

// ---------------------------------------------------------------------------------------------
// Transport and request policy
// ---------------------------------------------------------------------------------------------
export interface GraphRequest {
  url: string;
  prefer?: string;
  /** Ask main to renew the access token silently before this request (after a 401). */
  forceRefresh?: boolean;
  /** A file download: main answers with the body base64-encoded (≤25 MB). */
  binary?: boolean;
  /** Only for an app-folder PUT: the file, base64-encoded, and its type. */
  method?: "GET" | "PUT";
  bodyBase64?: string;
  contentType?: string;
  /** A conditional download: Graph answers 304 when the eTag still matches. */
  ifNoneMatch?: string;
  signal?: AbortSignal;
}
export interface GraphResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export type GraphTransport = (request: GraphRequest) => Promise<GraphResponse>;
export type GraphFailure =
  | "unauthorized"
  | "consent"
  | "throttled"
  | "resync"
  | "http"
  | "invalid"
  | "unavailable";
export class GraphError extends Error {
  constructor(readonly code: GraphFailure, readonly status?: number) {
    super(code);
  }
}
export interface GraphPolicy {
  transport: GraphTransport;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Counts every request sent (the zero-change budget is one per stream). */
  count: { requests: number };
  limit: <T>(task: () => Promise<T>) => Promise<T>;
}
const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
/** At most `slots` tasks at once (Graph's mailbox limit is four; this reader uses two). */
export function limiter(slots = GRAPH_CONCURRENCY) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= slots) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
function retryAfterMs(headers: Record<string, string>): number {
  const raw = headers["retry-after"];
  const seconds = raw && /^\d{1,5}$/.test(raw.trim()) ? Number(raw) : 5;
  return Math.min(120, Math.max(1, seconds)) * 1000;
}
/**
 * One GET with Graph's failure rules: 429/503 wait `Retry-After` (up to three times); 401 asks
 * for a silent refresh and retries once; 403 is consent; 410 means resync.
 */
export async function graphGet(
  policy: GraphPolicy,
  url: string,
  prefer?: string,
  /** true: the body as text (OneNote HTML); "binary": a Buffer (a file download). */
  raw?: true | "binary",
): Promise<unknown> {
  return (await graphSend(policy, { url, ...(prefer ? { prefer } : {}), ...(raw === "binary" ? { binary: true } : {}) }, raw)).value;
}
/** One request under the failure rules; a 304 is returned, not thrown. */
export async function graphSend(
  policy: GraphPolicy,
  request: Omit<GraphRequest, "signal" | "forceRefresh">,
  raw?: true | "binary",
): Promise<{ status: number; headers: Record<string, string>; value: unknown }> {
  const sleep = policy.sleep ?? defaultSleep;
  let refreshed = false,
    waits = 0;
  for (;;) {
    policy.signal?.throwIfAborted();
    const response = await policy.limit(() => {
      policy.count.requests++;
      return policy.transport({
        ...request,
        ...(refreshed ? { forceRefresh: true } : {}),
        ...(policy.signal ? { signal: policy.signal } : {}),
      });
    });
    const status = response.status;
    if (status === 304) return { status, headers: response.headers, value: undefined };
    if (status >= 200 && status < 300) {
      const value =
        raw === "binary"
          ? Buffer.from(response.body, "base64")
          : raw === true
            ? response.body
            : parseJson(response.body, status);
      return { status, headers: response.headers, value };
    }
    if (status === 401 && !refreshed) {
      refreshed = true;
      continue;
    }
    if ((status === 429 || status === 503) && waits < 3) {
      waits++;
      await sleep(retryAfterMs(response.headers), policy.signal);
      continue;
    }
    throw new GraphError(
      status === 401
        ? "unauthorized"
        : status === 403
          ? "consent"
          : status === 410
            ? "resync"
            : status === 429 || status === 503
              ? "throttled"
              : "http",
      status,
    );
  }
}
function parseJson(body: string, status: number): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new GraphError("invalid", status);
  }
}
interface DeltaPage {
  value?: unknown[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}
/** Follows `@odata.nextLink` to the `@odata.deltaLink`. At most 200 pages per stream. */
async function deltaRound(
  policy: GraphPolicy,
  start: string,
  prefer: string | undefined,
): Promise<{ items: Record<string, unknown>[]; deltaLink: string }> {
  const items: Record<string, unknown>[] = [];
  let url = start;
  for (let page = 0; page < 200; page++) {
    const body = (await graphGet(policy, url, prefer)) as DeltaPage;
    if (!body || typeof body !== "object") throw new GraphError("invalid");
    for (const item of body.value ?? [])
      if (item && typeof item === "object") items.push(item as Record<string, unknown>);
    const next = body["@odata.nextLink"],
      delta = body["@odata.deltaLink"];
    if (typeof delta === "string") return { items, deltaLink: checkedGraphUrl(delta) };
    if (typeof next !== "string") throw new GraphError("invalid");
    url = checkedGraphUrl(next);
  }
  throw new GraphError("invalid");
}

// ---------------------------------------------------------------------------------------------
// Code-first mail categories
// ---------------------------------------------------------------------------------------------
export interface CourseDirectoryEntry {
  courseId: string;
  accountScope: string;
  courseName: string;
  courseCode?: string;
  /** Instructor and TA addresses when the store has them (lowercase). */
  staffEmails?: string[];
}
export interface MailContext {
  courses: CourseDirectoryEntry[];
  /**
   * Local only: advisor display names from the student's planning records. Compared in code in
   * the worker; never stored, never sent. A match stores only the category `advisor`.
   */
  advisorNames?: string[];
  canvasOrigin?: string;
  /** Senders already seen with one List-Id three or more times: address → list. */
  knownLists?: Map<string, { listId: string; org: string }>;
}
export interface MailFacts {
  fromName?: string;
  fromAddress?: string;
  subject: string;
  preview: string;
  /** `@odata.type` of the item (an invite is `#microsoft.graph.eventMessageRequest`). */
  odataType?: string;
  meetingMessageType?: string;
  listId?: string;
  listUnsubscribe?: boolean;
}
export interface MailMatch {
  category: MailCategory;
  reason: string;
  courseId?: string;
  accountScope?: string;
  org?: string;
  listId?: string;
  canvasLink?: string;
}
const CANVAS_NOTIFICATION = "notifications@instructure.com";
/** University offices (sender local part or subdomain under wisc.edu). */
const ADMIN_UNITS = [
  "registrar",
  "bursar",
  "finaid",
  "doit",
  "help",
  "helpdesk",
  "housing",
  "uhs",
  "dos",
  "deanofstudents",
  "students",
  "admissions",
  "library",
  "secfac",
  "chancellor",
  "provost",
  "parking",
  "transportation",
  "recwell",
  "careers",
  "iss",
  "mcburney",
  "wiscard",
  "uwpd",
  "it",
];
const ORG_DOMAINS = ["lists.wisc.edu", "win.wisc.edu"];
function normalName(value: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ");
  // "Last, First" and "First Last" compare equal.
  const [last, first] = cleaned.split(",");
  const ordered = first !== undefined ? `${first} ${last}` : cleaned;
  return ordered.replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
}
/** Course code aliases: "COMP SCI 400" → COMP SCI 400, COMPSCI 400, CS 400 (spaces optional). */
export function courseAliases(code: string | undefined): RegExp[] {
  if (!code) return [];
  const match = code.toUpperCase().match(/([A-Z][A-Z&]*(?:\s+[A-Z&]+)*)\s*(\d{3,4})/);
  if (!match) return [];
  const words = match[1]!.split(/\s+/).filter(Boolean),
    number = match[2]!;
  const forms = new Set<string>([words.join(""), words.map((w) => w[0]).join("")]);
  if (words.length === 1 && words[0]!.length > 4) forms.add(words[0]!.slice(0, 2));
  return [...forms]
    .filter((form) => form.length >= 2)
    .map((form) => {
      const letters = form.split("").map((c) => c.replace(/[&]/g, "\\&")).join("\\s*");
      return new RegExp(`(?:^|[^A-Z0-9])${letters}\\s*${number}(?![0-9])`, "i");
    });
}
function adminUnit(address: string): string | undefined {
  const [local, domain] = address.split("@");
  if (!local || !domain || !(domain === "wisc.edu" || domain.endsWith(".wisc.edu"))) return;
  const sub = domain === "wisc.edu" ? "" : domain.slice(0, -".wisc.edu".length).split(".").pop()!;
  const localKey = local.replace(/[^a-z]/g, "");
  return ADMIN_UNITS.find((unit) => unit === sub || unit === localKey || local.startsWith(`${unit}-`));
}
function listOrg(listId: string | undefined, fromName: string | undefined): string | undefined {
  const phrase = listId?.match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim();
  return (phrase || fromName || listId?.replace(/[<>]/g, "").split(".")[0])?.slice(0, 300);
}
/**
 * The code's category for one message, with its reason. Order: meeting, advisor, course, admin,
 * org, general. Never a model call.
 */
export function categorizeMail(facts: MailFacts, context: MailContext): MailMatch {
  const address = (facts.fromAddress ?? "").toLowerCase().trim();
  const subject = facts.subject ?? "";
  if (
    /eventMessage/i.test(facts.odataType ?? "") ||
    (facts.meetingMessageType && facts.meetingMessageType !== "none")
  )
    return {
      category: "meeting",
      reason: `Meeting ${facts.meetingMessageType && facts.meetingMessageType !== "none" ? facts.meetingMessageType : "invite"} (Graph ${facts.odataType ?? "eventMessage"})`,
    };
  if (facts.fromName && context.advisorNames?.length) {
    const sender = normalName(facts.fromName);
    if (sender && context.advisorNames.some((name) => normalName(name) === sender))
      return { category: "advisor", reason: "Sender's name matches your assigned advisor" };
  }
  if (address)
    for (const course of context.courses)
      if (course.staffEmails?.includes(address))
        return {
          category: "course",
          reason: `Sender is course staff of ${course.courseCode ?? course.courseName}`,
          courseId: course.courseId,
          accountScope: course.accountScope,
        };
  if (address === CANVAS_NOTIFICATION) {
    const origin = context.canvasOrigin ?? "https://canvas.wisc.edu";
    const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const link = `${facts.preview} ${subject}`.match(
      new RegExp(`${escaped}/courses/(\\d+)(?:/[A-Za-z_]+/\\d+)?`),
    );
    if (link) {
      const course = context.courses.find((c) => c.courseId === link[1]);
      if (course)
        return {
          category: "course",
          reason: `Canvas notification links ${course.courseCode ?? course.courseName}`,
          courseId: course.courseId,
          accountScope: course.accountScope,
          canvasLink: link[0],
        };
    }
  }
  for (const course of context.courses) {
    const alias = courseAliases(course.courseCode).find((pattern) => pattern.test(subject));
    if (alias)
      return {
        category: "course",
        reason: `Subject names course code ${course.courseCode}`,
        courseId: course.courseId,
        accountScope: course.accountScope,
      };
  }
  for (const course of context.courses) {
    const name = course.courseName.trim();
    if (name.length >= 8 && subject.toLowerCase().includes(name.toLowerCase()))
      return {
        category: "course",
        reason: `Subject names course "${name}"`,
        courseId: course.courseId,
        accountScope: course.accountScope,
      };
  }
  if (address) {
    const unit = adminUnit(address);
    if (unit)
      return { category: "admin", reason: `University office sender (${unit})` };
  }
  if (facts.listId)
    return {
      category: "org",
      reason: `Mailing list ${facts.listId}`,
      org: listOrg(facts.listId, facts.fromName),
      listId: facts.listId.slice(0, 500),
    };
  const known = address ? context.knownLists?.get(address) : undefined;
  if (known)
    return {
      category: "org",
      reason: `Sender seen 3+ times on list ${known.listId}`,
      org: known.org,
      listId: known.listId,
    };
  const domain = address.split("@")[1];
  if (domain && ORG_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`)))
    return {
      category: "org",
      reason: `Sender is a UW list or organization address (${domain})`,
      org: (facts.fromName || address.split("@")[0])?.slice(0, 300),
    };
  return { category: "general", reason: "No course, advisor, office or list signal" };
}
/** Senders seen with the same List-Id three or more times, from stored mail. */
export function knownListsFrom(stored: Pick<MailMetadata, "fromAddress" | "listId" | "org">[]) {
  const counts = new Map<string, { listId: string; org: string; n: number }>();
  for (const mail of stored) {
    if (!mail.fromAddress || !mail.listId) continue;
    const key = `${mail.fromAddress.toLowerCase()}\u0000${mail.listId}`;
    const entry = counts.get(key) ?? { listId: mail.listId, org: mail.org ?? mail.listId, n: 0 };
    entry.n++;
    counts.set(key, entry);
  }
  const lists = new Map<string, { listId: string; org: string }>();
  for (const [key, entry] of counts)
    if (entry.n >= 3) lists.set(key.split("\u0000")[0]!, { listId: entry.listId, org: entry.org });
  return lists;
}

// ---------------------------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------------------------
export type MeetingService = "zoom" | "teams" | "webex" | "meet";
/** An online-meeting join link, found by code; origin plus path only (no passcode query). */
export function findJoinLink(...texts: (string | undefined)[]):
  | { service: MeetingService; url: string }
  | undefined {
  const patterns: [MeetingService, RegExp][] = [
    ["zoom", /https:\/\/(?:[a-z0-9-]+\.)?zoom\.us\/(?:j|my|w|s)\/[A-Za-z0-9._-]+/i],
    ["teams", /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"'<>)]+/i],
    ["teams", /https:\/\/teams\.live\.com\/meet\/[^\s"'<>)]+/i],
    ["webex", /https:\/\/[a-z0-9-]+\.webex\.com\/[^\s"'<>)]+/i],
    ["meet", /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i],
  ];
  for (const text of texts) {
    if (!text) continue;
    for (const [service, pattern] of patterns) {
      const found = text.match(pattern)?.[0];
      if (!found) continue;
      try {
        const url = new URL(found);
        const clean = `${url.origin}${url.pathname}`;
        if (evidenceUrlSchema.safeParse(clean).success) return { service, url: clean };
      } catch {
        /* not a URL */
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------
export function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
function str(value: unknown, max = 4000): string | undefined {
  return typeof value === "string" && value.trim() ? value.slice(0, max) : undefined;
}
function graphInstant(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { dateTime, timeZone } = value as { dateTime?: unknown; timeZone?: unknown };
  if (typeof dateTime !== "string") return undefined;
  // Requests carry Prefer: outlook.timezone="UTC"; anything else is refused, not guessed.
  if (typeof timeZone === "string" && timeZone.toUpperCase() !== "UTC") return undefined;
  const parsed = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(dateTime) ? dateTime : `${dateTime}Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
function safeLink(value: unknown, fallback: string): string {
  const raw = str(value);
  return raw && evidenceUrlSchema.safeParse(raw).success ? raw : fallback;
}
const OUTLOOK_MAIL_URL = "https://outlook.office.com/mail/";
const OUTLOOK_CALENDAR_URL = "https://outlook.office.com/calendar/view/day";
/** One stored message: the compact, agent-ready form. Never a body. */
export function mailRecord(
  item: Record<string, unknown>,
  folder: string,
  context: MailContext,
  extra: { listId?: string; gist?: string } = {},
): ResourceInput | undefined {
  const id = str(item.id, 1000);
  const received = str(item.receivedDateTime);
  if (!id || !received || !Number.isFinite(Date.parse(received))) return undefined;
  const from = (item.from as { emailAddress?: { name?: unknown; address?: unknown } } | undefined)
    ?.emailAddress;
  const subject = str(item.subject, 500) ?? "(no subject)";
  const preview = (str(item.bodyPreview, 255) ?? "").replace(/\s+/g, " ").trim().slice(0, 255);
  const odataType = str(item["@odata.type"], 200);
  const meetingMessageType = str(item.meetingMessageType, 60);
  const match = categorizeMail(
    {
      fromName: str(from?.name, 300),
      fromAddress: str(from?.address, 320),
      subject,
      preview,
      odataType,
      meetingMessageType,
      listId: extra.listId,
    },
    context,
  );
  const flag = (item.flag as { flagStatus?: unknown } | undefined)?.flagStatus;
  const importance = str(item.importance);
  const mail: MailMetadata = mailMetadataSchema.parse({
    messageId: id,
    ...(str(item.conversationId, 1000) ? { conversationId: str(item.conversationId, 1000) } : {}),
    folder,
    ...(str(from?.name, 300) ? { fromName: str(from?.name, 300) } : {}),
    ...(str(from?.address, 320) ? { fromAddress: str(from?.address, 320)!.toLowerCase() } : {}),
    receivedAt: new Date(Date.parse(received)).toISOString(),
    preview,
    ...(extra.gist ? { gist: extra.gist.slice(0, 280) } : {}),
    ...(importance === "low" || importance === "normal" || importance === "high"
      ? { importance }
      : {}),
    ...(typeof item.hasAttachments === "boolean" ? { hasAttachments: item.hasAttachments } : {}),
    ...(Array.isArray(item.categories)
      ? {
          categories: item.categories
            .filter((c): c is string => typeof c === "string")
            .slice(0, 50)
            .map((c) => c.slice(0, 200)),
        }
      : {}),
    ...(typeof flag === "string" ? { flagged: flag === "flagged" } : {}),
    ...(typeof item.isRead === "boolean" ? { isRead: item.isRead } : {}),
    category: match.category,
    categoryReason: match.reason.slice(0, 500),
    ...(match.courseId ? { courseId: match.courseId } : {}),
    ...(match.accountScope ? { courseAccountScope: match.accountScope } : {}),
    ...(match.org ? { org: match.org } : {}),
    ...(match.listId ? { listId: match.listId } : {}),
    ...(meetingMessageType ? { meetingMessageType } : {}),
  });
  return resourceInputSchema.parse({
    externalId: `mail:${hashId(id)}`,
    kind: "message",
    courseId: OUTLOOK_MAIL_COURSE_ID,
    courseName: "Outlook mail",
    title: subject,
    url: safeLink(item.webLink, OUTLOOK_MAIL_URL),
    text: mail.gist ?? preview,
    ...(match.canvasLink && evidenceUrlSchema.safeParse(match.canvasLink).success
      ? { links: [{ url: match.canvasLink, rel: "canvas-item" }] }
      : {}),
    createdAt: mail.receivedAt,
    updatedAt: mail.receivedAt,
    mail,
    deadlines: [],
  });
}
/** Agenda entries key by the Graph event id (a delta removal names only that id). */
export function graphEventKey(graphId: string): string {
  return `graph-event:${hashId(graphId)}`;
}
/** One Graph calendar event as an agenda entry under the Outlook calendar. */
export function eventRecord(
  item: Record<string, unknown>,
  extra: { sourceMailId?: string } = {},
): ResourceInput | undefined {
  const id = str(item.id, 1000);
  if (!id || item.isCancelled === true) return undefined;
  const allDay = item.isAllDay === true;
  const startAt = graphInstant(item.start),
    endAt = graphInstant(item.end);
  if (!startAt) return undefined;
  const start = allDay ? startAt.slice(0, 10) : startAt;
  const end = endAt ? (allDay ? endAt.slice(0, 10) : endAt) : null;
  const iCalUId = str(item.iCalUId, 1000);
  const location = str((item.location as { displayName?: unknown } | undefined)?.displayName, 500);
  const online = item.onlineMeeting as { joinUrl?: unknown } | null | undefined;
  const join = findJoinLink(str(online?.joinUrl), location, str(item.bodyPreview));
  const organizer = str(
    (item.organizer as { emailAddress?: { name?: unknown } } | undefined)?.emailAddress?.name,
    300,
  );
  const response = str((item.responseStatus as { response?: unknown } | undefined)?.response, 40);
  const meeting =
    Boolean(join) ||
    item.isOnlineMeeting === true ||
    (Array.isArray(item.attendees) && item.attendees.length > 0) ||
    Boolean(extra.sourceMailId);
  const title = str(item.subject, 500) ?? "Calendar event";
  const modifiedMs = Date.parse(str(item.lastModifiedDateTime) ?? "");
  const modified = Number.isFinite(modifiedMs) ? new Date(modifiedMs).toISOString() : undefined;
  return resourceInputSchema.parse({
    externalId: graphEventKey(id),
    kind: "event",
    courseId: OUTLOOK_CALENDAR_COURSE_ID,
    courseName: "Outlook calendar",
    title,
    url: safeLink(item.webLink, OUTLOOK_CALENDAR_URL),
    text: "",
    ...(modified ? { updatedAt: modified } : {}),
    calendar: {
      uid: iCalUId ?? id,
      start,
      end,
      allDay,
      timezone: "UTC",
      lastModified: modified ?? null,
      ...(location ? { location } : {}),
      ...(join ? { onlineMeeting: join.service, joinUrl: join.url } : {}),
      ...(meeting ? { entryKind: "meeting" as const } : {}),
      ...(iCalUId ? { iCalUId } : {}),
      ...(organizer ? { organizer } : {}),
      ...(extra.sourceMailId ? { sourceMailId: extra.sourceMailId.slice(0, 1000) } : {}),
      ...(response ? { responseStatus: response } : {}),
    },
    deadlines: allDay
      ? []
      : [
          {
            value: startAt,
            kind: "event",
            quote: `Outlook calendar start: ${startAt}`,
            authority: "structured",
            scopeConfirmed: false,
          },
        ],
  });
}

// ---------------------------------------------------------------------------------------------
// Notes: OneNote pages and cloud-only OneDrive files
// ---------------------------------------------------------------------------------------------
/** Files read from OneDrive: Office documents, PDF and Markdown. */
export const DRIVE_MIME_TYPES = new Set([
  "application/pdf",
  "text/markdown",
  "text/x-markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.ms-powerpoint",
  "application/vnd.ms-excel",
]);
export const DRIVE_MAX_BYTES = 25 * 1024 * 1024;
export const ONENOTE_SELECT =
  "id,title,createdDateTime,lastModifiedDateTime,links,parentSection,parentNotebook";
/** A drive item is a file this reader takes: an allowed type (a `.md` name counts as Markdown). */
export function driveFileWanted(item: { name?: unknown; file?: { mimeType?: unknown } | null }): boolean {
  const mime = typeof item.file?.mimeType === "string" ? item.file.mimeType.toLowerCase() : "";
  if (!item.file) return false;
  return DRIVE_MIME_TYPES.has(mime) || (typeof item.name === "string" && /\.md$/i.test(item.name));
}
/** OneNote page HTML to plain text, in code (no model). */
export function oneNoteText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|table|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 200000);
}
export interface DriveExtraction {
  text: string;
  parts?: ResourceInput["parts"];
  document?: ResourceInput["document"];
}

// ---------------------------------------------------------------------------------------------
// The sync
// ---------------------------------------------------------------------------------------------
/** Delta links, window starts and watermarks; main keeps them in the encrypted vault. */
export interface DeltaState {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string | null): Promise<void>;
}
export type GraphStream = "mail" | "calendar" | "onenote" | "drive";
/** Which readers a set of granted scopes allows (a partial grant runs what is granted). */
export function streamsFor(scopes: readonly string[]): GraphStream[] {
  const has = (scope: string) => scopes.some((s) => s.toLowerCase() === scope.toLowerCase());
  const streams: GraphStream[] = [];
  if (has("Mail.Read")) streams.push("mail");
  if (has("Calendars.Read") || has("Calendars.ReadWrite")) streams.push("calendar");
  if (has("Notes.Read")) streams.push("onenote");
  if (has("Files.Read")) streams.push("drive");
  return streams;
}
export interface GraphSyncOptions {
  transport: GraphTransport;
  state: DeltaState;
  accountScope: string;
  /** The stored records of a source, so a delta round merges into them. */
  previous(sourceId: string): ResourceInput[];
  context: MailContext;
  /** The readers to run; `streamsFor(grantedScopes)`. Default: mail and calendar. */
  streams?: GraphStream[];
  now?: () => Date;
  folders?: string[];
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Follow-up reads per sync: an invite's event, a list header. Default 10. */
  maxFollowUps?: number;
  /** OneNote page contents and OneDrive downloads per sync. Default 10 each. */
  maxContentReads?: number;
  /** Turns downloaded file bytes into text with the existing document extractor. */
  extract?: (file: {
    itemId: string;
    name: string;
    mimeType: string;
    url: string;
    bytes: Buffer;
    signal?: AbortSignal;
  }) => Promise<DriveExtraction | undefined>;
}
export interface GraphSyncResult {
  batches: CaptureBatch[];
  requests: number;
  changed: boolean;
  /** Per reader: `unauthorized` (token not renewable), `consent` (403), or another failure. */
  failures: Partial<Record<GraphStream, GraphFailure>>;
  /** The first failure, for a one-word status. */
  failure?: GraphFailure;
  /**
   * Advances the delta links and watermarks. Call only after the batches are saved, so a crash
   * between the two re-reads the changes instead of losing them.
   */
  commit(): Promise<void>;
}
export function graphSourceIds(accountScope: string, folders: string[] = ["inbox"]) {
  const scope = hashId(accountScope).slice(0, 16);
  return {
    calendar: `calendar:outlook-graph:${scope}`,
    mail: Object.fromEntries(folders.map((f) => [f, `mail:outlook:${scope}:${f.toLowerCase()}`])) as Record<string, string>,
    onenote: `notes:onenote:${scope}`,
    drive: `notes:onedrive:${scope}`,
  };
}
/** Stored scopes of Graph sources start with this; the drift guard treats their deletions as real. */
export const GRAPH_SCOPE_PREFIX = "graph_";
function mailStart(folder: string, now: Date): string {
  const since = new Date(now.getTime() - MAIL_WINDOW_DAYS * 86400000).toISOString();
  // OData system options written as Graph documents them (a literal $, commas unencoded).
  return `${GRAPH_ROOT}/me/mailFolders/${encodeURIComponent(folder)}/messages/delta?$select=${MAIL_SELECT.join(",")}&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;
}
function calendarStart(now: Date): string {
  const url = new URL(`${GRAPH_ROOT}/me/calendarView/delta`);
  url.searchParams.set(
    "startDateTime",
    new Date(now.getTime() - CALENDAR_PAST_DAYS * 86400000).toISOString(),
  );
  url.searchParams.set(
    "endDateTime",
    new Date(now.getTime() + CALENDAR_AHEAD_DAYS * 86400000).toISOString(),
  );
  return url.href;
}
function driveStart(): string {
  return `${GRAPH_ROOT}/me/drive/root/delta?$select=id,name,file,folder,size,parentReference,lastModifiedDateTime,webUrl,cTag,deleted`;
}
function removed(item: Record<string, unknown>): boolean {
  return Boolean(item["@removed"]) || Boolean(item.deleted);
}
/**
 * Mail, calendar, OneNote and OneDrive for one account. Each reader runs alone: one reader's
 * failure (for example a scope UW did not grant) never stops or erases another. Batches are
 * complete sets, emitted only when something changed.
 */
export async function syncGraph(options: GraphSyncOptions): Promise<GraphSyncResult> {
  const now = (options.now ?? (() => new Date()))();
  const folders = (options.folders ?? ["inbox"]).filter((f) => wellKnownFolder.test(f));
  const ids = graphSourceIds(options.accountScope, folders);
  const streams = new Set(options.streams ?? ["mail", "calendar"]);
  const policy: GraphPolicy = {
    transport: options.transport,
    signal: options.signal,
    sleep: options.sleep,
    count: { requests: 0 },
    limit: limiter(GRAPH_CONCURRENCY),
  };
  let followUps = options.maxFollowUps ?? 10;
  let contentReads = options.maxContentReads ?? 10;
  const batches: CaptureBatch[] = [];
  const pendingState: [string, string | null][] = [];
  const meetingsFromMail: { messageId: string; event: Record<string, unknown>; cancelled: boolean }[] = [];
  const failures: Partial<Record<GraphStream, GraphFailure>> = {};
  const observedAt = now.toISOString();
  const knownLists =
    options.context.knownLists ??
    knownListsFrom(
      Object.values(ids.mail)
        .flatMap((id) => options.previous(id))
        .flatMap((r) => (r.mail ? [r.mail] : [])),
    );
  const context: MailContext = { ...options.context, knownLists };
  const setLater = (key: string, value: string | null) => pendingState.push([key, value]);

  /** One delta stream: resume from its link, or start fresh (first sync, 410, or re-base). */
  async function stream(
    key: string,
    start: () => string,
    prefer: string | undefined,
    rebaseAfterDays?: number,
  ): Promise<{ items: Record<string, unknown>[]; fresh: boolean }> {
    let link = await options.state.get(`graph:delta:${key}`);
    if (link && rebaseAfterDays !== undefined) {
      const at = Date.parse((await options.state.get(`graph:at:${key}`)) ?? "");
      if (!Number.isFinite(at) || now.getTime() - at > rebaseAfterDays * 86400000) link = undefined;
    }
    if (link) {
      try {
        const round = await deltaRound(policy, checkedGraphUrl(link), prefer);
        setLater(`graph:delta:${key}`, round.deltaLink);
        return { items: round.items, fresh: false };
      } catch (error) {
        if (!(error instanceof GraphError && error.code === "resync")) throw error;
      }
    }
    const round = await deltaRound(policy, start(), prefer);
    setLater(`graph:delta:${key}`, round.deltaLink);
    setLater(`graph:at:${key}`, observedAt);
    return { items: round.items, fresh: true };
  }
  async function followUp(url: string): Promise<Record<string, unknown> | undefined> {
    if (followUps <= 0) return undefined;
    followUps--;
    try {
      const body = await graphGet(policy, checkedGraphUrl(url), PREFER_UTC);
      return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
    } catch (error) {
      if (error instanceof GraphError && (error.code === "unauthorized" || error.code === "consent"))
        throw error;
      return undefined;
    }
  }
  function batch(source: CaptureBatch["source"], resources: ResourceInput[]): CaptureBatch {
    return captureBatchSchema.parse({
      source,
      observedAt,
      resources,
      complete: true,
      status: "ok",
      stats: { records: resources.length, durationMs: Math.max(0, Date.now() - now.getTime()) },
    });
  }
  async function mailFolder(folder: string) {
    const sourceId = ids.mail[folder]!;
    const { items, fresh } = await stream(`mail:${folder.toLowerCase()}`, () => mailStart(folder, now), PREFER_PAGE);
    if (!fresh && !items.length) return;
    const current = new Map<string, ResourceInput>(
      fresh ? [] : options.previous(sourceId).map((r) => [r.mail?.messageId ?? r.externalId, r]),
    );
    for (const item of items) {
      const id = str(item.id, 1000);
      if (!id) continue;
      if (removed(item)) {
        current.delete(id);
        continue;
      }
      // An invite: its event (for the agenda) and its message type, one follow-up read.
      let extra: Record<string, unknown> = {};
      if (/eventMessage/i.test(str(item["@odata.type"], 200) ?? "")) {
        const detail = await followUp(
          `${GRAPH_ROOT}/me/messages/${encodeURIComponent(id)}?$expand=microsoft.graph.eventMessage/event`,
        );
        if (detail) {
          extra = { meetingMessageType: detail.meetingMessageType };
          const event = detail.event as Record<string, unknown> | undefined;
          if (event && typeof event === "object")
            meetingsFromMail.push({
              messageId: id,
              event,
              cancelled: detail.meetingMessageType === "meetingCancelled",
            });
        }
      }
      let listId: string | undefined;
      const from = str(
        (item.from as { emailAddress?: { address?: unknown } } | undefined)?.emailAddress?.address,
        320,
      )?.toLowerCase();
      const probe = { ...item, ...extra };
      const first = mailRecord(probe, folder, context);
      // A List-Id is read on demand (one small header read) only where it can change the answer.
      if (
        first?.mail?.category === "general" &&
        from &&
        (from.endsWith(".wisc.edu") || from.endsWith("@wisc.edu")) &&
        !knownLists.has(from)
      ) {
        const headers = await followUp(
          `${GRAPH_ROOT}/me/messages/${encodeURIComponent(id)}?$select=internetMessageHeaders`,
        );
        const list = (headers?.internetMessageHeaders as { name?: unknown; value?: unknown }[] | undefined)
          ?.find((h) => typeof h?.name === "string" && h.name.toLowerCase() === "list-id");
        if (typeof list?.value === "string") listId = list.value.slice(0, 500);
      }
      const prior = current.get(id);
      const record = listId ? mailRecord(probe, folder, context, { listId }) : first;
      if (!record) continue;
      // A gist written by the student's AI client survives a metadata change of the same message.
      if (prior?.mail?.gist && !record.mail?.gist && record.mail) {
        record.mail.gist = prior.mail.gist;
        record.text = prior.mail.gist;
      }
      current.set(id, record);
    }
    const kept = [...current.values()]
      .sort((a, b) => (b.mail!.receivedAt < a.mail!.receivedAt ? -1 : 1))
      .slice(0, MAX_STORED_MESSAGES);
    batches.push(
      batch(
        {
          id: sourceId,
          label: `Outlook mail · ${folder}`,
          kind: "mail",
          accountScope: options.accountScope,
          courseId: OUTLOOK_MAIL_COURSE_ID,
          scope: `${GRAPH_SCOPE_PREFIX}mail_${folder.toLowerCase()}`,
        },
        kept,
      ),
    );
  }
  async function calendar() {
    const { items, fresh } = await stream(
      "calendar",
      () => calendarStart(now),
      `${PREFER_PAGE}, ${PREFER_UTC}`,
      CALENDAR_REBASE_DAYS,
    );
    if (!fresh && !items.length && !meetingsFromMail.length) return;
    const current = new Map<string, ResourceInput>(
      fresh ? [] : options.previous(ids.calendar).map((r) => [r.externalId, r]),
    );
    const byUid = (uid: string) =>
      [...current.values()].find((r) => r.calendar?.iCalUId === uid)?.externalId;
    for (const item of items) {
      const id = str(item.id, 1000);
      if (!id) continue;
      if (removed(item) || item.isCancelled === true) {
        current.delete(graphEventKey(id));
        continue;
      }
      const record = eventRecord(item);
      if (!record) continue;
      const prior = current.get(record.externalId);
      if (prior?.calendar?.sourceMailId && record.calendar)
        record.calendar.sourceMailId = prior.calendar.sourceMailId;
      current.set(record.externalId, record);
    }
    // Invites from mail: create or refresh the agenda entry; a cancellation removes it. Exchange
    // adds the invite to the calendar as tentative, so the same meeting also arrives from the
    // calendar delta: deduplicated by iCalUId (and by the event id, which is the same event).
    for (const meeting of meetingsFromMail) {
      const eventId = str(meeting.event.id, 1000);
      const uid = str(meeting.event.iCalUId, 1000);
      const key = (uid && byUid(uid)) ?? (eventId ? graphEventKey(eventId) : undefined);
      if (!key) continue;
      if (meeting.cancelled) {
        current.delete(key);
        continue;
      }
      const prior = current.get(key);
      if (prior?.calendar) {
        current.set(key, {
          ...prior,
          calendar: { ...prior.calendar, entryKind: "meeting", sourceMailId: meeting.messageId.slice(0, 1000) },
        });
        continue;
      }
      const record = eventRecord(meeting.event, { sourceMailId: meeting.messageId });
      if (record) current.set(record.externalId, record);
    }
    batches.push(
      batch(
        {
          id: ids.calendar,
          label: "Outlook calendar (Microsoft)",
          kind: "calendar",
          accountScope: options.accountScope,
          courseId: OUTLOOK_CALENDAR_COURSE_ID,
          scope: `${GRAPH_SCOPE_PREFIX}calendar`,
        },
        [...current.values()],
      ),
    );
  }
  /**
   * OneNote has no delta: list the pages (metadata only, paged) and read a page's HTML only when
   * it is new or its lastModifiedDateTime passed its notebook's watermark.
   */
  async function onenote() {
    const pages: Record<string, unknown>[] = [];
    let url: string | undefined = `${GRAPH_ROOT}/me/onenote/pages?$select=${ONENOTE_SELECT}&$top=100`;
    for (let page = 0; url && page < 50; page++) {
      const body = (await graphGet(policy, url)) as DeltaPage;
      for (const item of body?.value ?? [])
        if (item && typeof item === "object") pages.push(item as Record<string, unknown>);
      url = typeof body?.["@odata.nextLink"] === "string" ? checkedGraphUrl(body["@odata.nextLink"]) : undefined;
    }
    const stored = new Map(
      options.previous(ids.onenote).map((r) => [r.notes?.itemId ?? r.externalId, r]),
    );
    const watermarks = new Map<string, number>();
    const next = new Map<string, ResourceInput>();
    let changed = false;
    for (const page of pages) {
      const id = str(page.id, 1000);
      if (!id) continue;
      const notebookId = str((page.parentNotebook as { id?: unknown } | undefined)?.id, 400) ?? "none";
      const notebook = str((page.parentNotebook as { displayName?: unknown } | undefined)?.displayName, 300);
      const section = str((page.parentSection as { displayName?: unknown } | undefined)?.displayName, 300);
      const modifiedMs = Date.parse(str(page.lastModifiedDateTime) ?? "");
      const modified = Number.isFinite(modifiedMs) ? new Date(modifiedMs).toISOString() : undefined;
      if (!watermarks.has(notebookId)) {
        const mark = Date.parse((await options.state.get(`graph:at:onenote:${hashId(notebookId)}`)) ?? "");
        watermarks.set(notebookId, Number.isFinite(mark) ? mark : -Infinity);
      }
      const prior = stored.get(id);
      const stale =
        !prior ||
        prior.notes?.pending === true ||
        (Number.isFinite(modifiedMs) && modifiedMs > watermarks.get(notebookId)!) ||
        prior.notes?.lastModified !== modified;
      let text = prior?.text ?? "";
      let pending = prior?.notes?.pending ?? !prior;
      if (stale) {
        if (contentReads > 0) {
          contentReads--;
          const html = await graphGet(
            policy,
            checkedGraphUrl(`${GRAPH_ROOT}/me/onenote/pages/${encodeURIComponent(id)}/content`),
            undefined,
            true,
          );
          text = oneNoteText(typeof html === "string" ? html : "");
          pending = false;
        } else pending = true;
      }
      const web = (page.links as { oneNoteWebUrl?: { href?: unknown } } | undefined)?.oneNoteWebUrl?.href;
      const record = resourceInputSchema.parse({
        externalId: `onenote:${hashId(id)}`,
        kind: "material",
        courseId: UNMAPPED_COURSE_ID,
        courseName: "Unmapped notes",
        title: str(page.title, 500) ?? "Untitled page",
        url: safeLink(web, "https://www.onenote.com/notebooks"),
        text,
        ...(modified ? { updatedAt: modified } : {}),
        notes: {
          sourceSubtype: "onenote",
          itemId: id,
          ...(notebook ? { notebook } : {}),
          ...(section ? { section } : {}),
          ...(modified ? { lastModified: modified } : {}),
          ...(pending ? { pending: true } : {}),
        },
        deadlines: [],
      });
      if (!prior || prior.text !== record.text || prior.title !== record.title || prior.notes?.lastModified !== modified || Boolean(prior.notes?.pending) !== pending)
        changed = true;
      next.set(id, record);
    }
    for (const id of stored.keys()) if (!next.has(id)) changed = true;
    // Watermark per notebook: the newest page whose content is now read.
    const newest = new Map<string, number>();
    for (const page of pages) {
      const id = str(page.id, 1000);
      const notebookId = str((page.parentNotebook as { id?: unknown } | undefined)?.id, 400) ?? "none";
      const ms = Date.parse(str(page.lastModifiedDateTime) ?? "");
      if (!id || !Number.isFinite(ms) || next.get(id)?.notes?.pending) continue;
      newest.set(notebookId, Math.max(newest.get(notebookId) ?? -Infinity, ms));
    }
    for (const [notebookId, ms] of newest)
      if (ms > (watermarks.get(notebookId) ?? -Infinity))
        setLater(`graph:at:onenote:${hashId(notebookId)}`, new Date(ms).toISOString());
    if (!changed) return;
    batches.push(
      batch(
        {
          id: ids.onenote,
          label: "OneNote",
          kind: "notes",
          accountScope: options.accountScope,
          courseId: UNMAPPED_COURSE_ID,
          scope: `${GRAPH_SCOPE_PREFIX}onenote`,
        },
        [...next.values()],
      ),
    );
  }
  /**
   * OneDrive files the student links (Word and PowerPoint online, PDF, Markdown): drive delta,
   * MIME-filtered, ≤25 MB, content read only when new or changed (its cTag moved).
   */
  async function drive() {
    const { items, fresh } = await stream("drive", driveStart, undefined);
    const stored = options.previous(ids.drive);
    const hasPending = stored.some((r) => r.notes?.pending);
    if (!fresh && !items.length && !hasPending) return;
    const current = new Map<string, ResourceInput>(
      fresh ? [] : stored.map((r) => [r.notes?.itemId ?? r.externalId, r]),
    );
    for (const item of items) {
      const id = str(item.id, 1000);
      if (!id) continue;
      if (removed(item)) {
        current.delete(id);
        continue;
      }
      const name = str(item.name, 500);
      const file = item.file as { mimeType?: unknown } | undefined;
      if (!name || !file || !driveFileWanted({ name, file })) {
        current.delete(id);
        continue;
      }
      const parentPath = str((item.parentReference as { path?: unknown } | undefined)?.path, 2000);
      const size = typeof item.size === "number" ? item.size : undefined;
      const cTag = str(item.cTag, 500);
      const prior = current.get(id);
      const same = prior?.notes?.cTag && prior.notes.cTag === cTag && !prior.notes.pending;
      const modifiedMs = Date.parse(str(item.lastModifiedDateTime) ?? "");
      const modified = Number.isFinite(modifiedMs) ? new Date(modifiedMs).toISOString() : undefined;
      const mimeType = str(file.mimeType, 200) ?? (/\.md$/i.test(name) ? "text/markdown" : "application/octet-stream");
      current.set(
        id,
        resourceInputSchema.parse({
          externalId: `onedrive:${hashId(id)}`,
          kind: "material",
          courseId: UNMAPPED_COURSE_ID,
          courseName: "Unmapped notes",
          title: name,
          url: safeLink(item.webUrl, "https://www.office.com/"),
          text: same ? prior!.text : "",
          ...(same && prior!.parts ? { parts: prior!.parts } : {}),
          ...(same && prior!.document ? { document: prior!.document } : {}),
          ...(modified ? { updatedAt: modified } : {}),
          notes: {
            sourceSubtype: "onedrive",
            itemId: id,
            ...(parentPath ? { path: parentPath.replace(/^\/drive\/root:?/, "") || "/" } : {}),
            mimeType,
            ...(size !== undefined ? { sizeBytes: size } : {}),
            ...(modified ? { lastModified: modified } : {}),
            ...(cTag ? { cTag } : {}),
            ...(same ? {} : { pending: true }),
          },
          deadlines: [],
        }),
      );
    }
    // Download what is new or changed (≤25 MB), within this sync's budget; the rest stays pending.
    for (const [id, record] of current) {
      if (!record.notes?.pending) continue;
      if ((record.notes.sizeBytes ?? 0) > DRIVE_MAX_BYTES || !options.extract) {
        current.set(id, { ...record, notes: { ...record.notes, pending: false } });
        continue;
      }
      if (contentReads <= 0) break;
      contentReads--;
      const content = await graphGet(
        policy,
        checkedGraphUrl(`${GRAPH_ROOT}/me/drive/items/${encodeURIComponent(id)}/content`),
        undefined,
        "binary",
      );
      const bytes = Buffer.isBuffer(content) ? content : Buffer.alloc(0);
      if (bytes.length > DRIVE_MAX_BYTES) {
        current.set(id, { ...record, notes: { ...record.notes, pending: false } });
        continue;
      }
      const extracted = await options.extract({
        itemId: id,
        name: record.title,
        mimeType: record.notes.mimeType ?? "application/octet-stream",
        url: record.url,
        bytes,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      current.set(
        id,
        resourceInputSchema.parse({
          ...record,
          text: extracted?.text.slice(0, 200000) ?? "",
          ...(extracted?.parts ? { parts: extracted.parts } : {}),
          ...(extracted?.document ? { document: extracted.document } : {}),
          notes: { ...record.notes, pending: false },
        }),
      );
    }
    batches.push(
      batch(
        {
          id: ids.drive,
          label: "OneDrive",
          kind: "notes",
          accountScope: options.accountScope,
          courseId: UNMAPPED_COURSE_ID,
          scope: `${GRAPH_SCOPE_PREFIX}onedrive`,
        },
        [...current.values()],
      ),
    );
  }
  async function run(name: GraphStream, task: () => Promise<unknown>) {
    if (!streams.has(name)) return;
    const before = batches.length;
    const state = pendingState.length;
    try {
      await task();
    } catch (error) {
      if (options.signal?.aborted) throw error;
      failures[name] = error instanceof GraphError ? error.code : "unavailable";
      // A failed reader keeps what is stored: nothing partial from it is written or committed.
      batches.splice(before);
      pendingState.splice(state);
    }
  }
  // Mail first: invites it finds are applied to the calendar in the same round.
  await run("mail", () => Promise.all(folders.map(mailFolder)));
  if (Object.values(failures).includes("unauthorized"))
    return result();
  // One reader at a time: a failed reader's rollback touches only its own batches.
  await run("calendar", calendar);
  await run("onenote", onenote);
  await run("drive", drive);
  return result();
  function result(): GraphSyncResult {
    const first = Object.values(failures)[0];
    const state = [...pendingState];
    return {
      batches,
      requests: policy.count.requests,
      changed: batches.length > 0,
      failures,
      ...(first ? { failure: first } : {}),
      async commit() {
        for (const [key, value] of state) await options.state.set(key, value);
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// The app's own OneDrive folder (Files.ReadWrite.AppFolder): lecture notes the student edits in
// Word online. Every call goes through main's proxy; the token never leaves main.
// ---------------------------------------------------------------------------------------------
export interface AppFolderItem {
  id: string;
  webUrl: string;
  eTag: string;
}
function appPolicy(transport: GraphTransport, signal?: AbortSignal): GraphPolicy {
  return { transport, signal, count: { requests: 0 }, limit: limiter(GRAPH_CONCURRENCY) };
}
function appItem(value: unknown): AppFolderItem {
  const item = value as { id?: unknown; webUrl?: unknown; eTag?: unknown } | undefined;
  if (typeof item?.id !== "string" || typeof item.webUrl !== "string" || typeof item.eTag !== "string")
    throw new GraphError("invalid");
  return { id: item.id, webUrl: item.webUrl, eTag: item.eTag };
}
/** Writes one file at `path` inside Apps/<app> (simple upload). */
export async function appFolderPut(
  transport: GraphTransport,
  path: string,
  bytes: Buffer,
  contentType: string,
  signal?: AbortSignal,
): Promise<AppFolderItem> {
  const clean = path.replace(/^\/+/, "");
  if (!clean || clean.includes("..") || /[:\\]/.test(clean) || clean.length > 400)
    throw new GraphError("invalid");
  if (!APP_FOLDER_TYPES.has(contentType)) throw new GraphError("invalid");
  if (bytes.length > DRIVE_MAX_BYTES) throw new GraphError("invalid");
  const encoded = clean.split("/").map(encodeURIComponent).join("/");
  const url = checkedGraphUrl(`${GRAPH_ROOT}/me/drive/special/approot:/${encoded}:/content`, "PUT");
  const response = await graphSend(appPolicy(transport, signal), {
    url,
    method: "PUT",
    bodyBase64: bytes.toString("base64"),
    contentType,
  });
  return appItem(response.value);
}
/** Reads one app-folder file; with `ifNoneMatch` an unchanged file answers 304 (no bytes). */
export async function appFolderGet(
  transport: GraphTransport,
  id: string,
  ifNoneMatch?: string,
  signal?: AbortSignal,
): Promise<{ status: 304 } | { status: 200; bytes: Buffer; eTag: string | undefined }> {
  const url = checkedGraphUrl(`${GRAPH_ROOT}/me/drive/items/${encodeURIComponent(id)}/content`);
  const response = await graphSend(
    appPolicy(transport, signal),
    { url, binary: true, ...(ifNoneMatch ? { ifNoneMatch } : {}) },
    "binary",
  );
  if (response.status === 304) return { status: 304 };
  return { status: 200, bytes: response.value as Buffer, eTag: response.headers.etag };
}
/**
 * Changes inside Apps/<app> since `deltaLink` (or everything, without one). Returns the items
 * and the next link to keep.
 */
export async function appFolderDelta(
  transport: GraphTransport,
  deltaLink?: string,
  signal?: AbortSignal,
): Promise<{ items: { id: string; name?: string; eTag?: string; deleted: boolean; webUrl?: string }[]; deltaLink: string }> {
  const round = await deltaRound(
    appPolicy(transport, signal),
    deltaLink ? checkedGraphUrl(deltaLink) : `${GRAPH_ROOT}/me/drive/special/approot/delta`,
    undefined,
  );
  return {
    deltaLink: round.deltaLink,
    items: round.items.flatMap((item) => {
      const id = str(item.id, 1000);
      if (!id) return [];
      return [
        {
          id,
          ...(str(item.name, 500) ? { name: str(item.name, 500) } : {}),
          ...(str(item.eTag, 500) ? { eTag: str(item.eTag, 500) } : {}),
          ...(str(item.webUrl) ? { webUrl: str(item.webUrl) } : {}),
          deleted: removed(item),
        },
      ];
    }),
  };
}
