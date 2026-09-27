/**
 * Host triage (the operator, 2026-09-27: "not all sites need connection; they should be
 * efficiently scanned and evaluated for what's needed"). Before the crawler fetches anything,
 * every outside host a course links from Canvas gets one decision, from Canvas evidence only:
 *
 * - `sync`: the course's own site; crawled each sync and organized by recipes (`site-recipes`);
 * - `read_once`: a document the course points at; read when the student opens the linking item;
 * - `link_only`: a platform, tool, form or meeting; never read, shown as a link with its access state;
 * - `ignore`: boilerplate or noise (campus-service links in a syllabus, embedded media); hidden.
 *
 * Code decides from where Canvas links the host (syllabus, module, assignment, announcement,
 * page, discussion), how many items link it, the anchor texts, whether the address names the
 * course (its number, or an instructor's `~name` path) and the known-platform table (D40). Hosts
 * code cannot settle go to the student's AI in one batched call that carries only host, paths,
 * anchor texts and link locations, never page content; its answer is cached against those
 * signals. A student's choice always wins. Decisions and reasons are kept in the recipe store
 * (`extraction_recipes`, keyed by host and a hash of the course), so no table is added.
 */
import { createHash } from "node:crypto";
import type { Resource, SourceHealth } from "@magic/contracts";
import { z } from "zod";
import type { ModelRunner } from "../../runner/src/index";
import { memoryArtifactStore, memoryLedgerStore, type ArtifactStore, type LedgerStore } from "../../packs/core/src/index";
import { sqlLedgerStore } from "../../packs/core/src/learning-stores";
import { hostDecisions, hostsPack, type HostDecision, type HostsAnswer } from "../../packs/site/src/index";
import { isBlockedContentHost } from "../../connectors/src/external";
import { anchorTexts } from "../../connectors/src/recipes";
import { classifyHost } from "../../connectors/src/space-hosts";
import { createSiteSender, type SiteStore } from "./site-recipes";
import type { CourseCoreStore } from "@magic/contracts";

export type { HostDecision };
export const linkLocations = ["syllabus", "module", "assignment", "announcement", "page", "discussion", "other"] as const;
export type LinkLocation = (typeof linkLocations)[number];
export interface HostSignals {
  host: string;
  /** Distinct link targets on the host (no query or fragment), at most 20. */
  urls: string[];
  locations: Partial<Record<LinkLocation, number>>;
  /** Canvas resources that link the host. */
  items: string[];
  /** Anchor texts and module-item titles, at most 12. */
  anchors: string[];
  /**
   * Paths and texts seen only in messages (announcements, activity). Code's rules read them; the
   * model never does, since they are communications, not course text.
   */
  messageUrls: string[];
  messageAnchors: string[];
}
export type DecidedBy = "code" | "model" | "student" | "default";
export interface HostTriage {
  host: string;
  decision: HostDecision;
  reason: string;
  by: DecidedBy;
}
export interface TriageReport {
  hosts: HostTriage[];
  counts: Record<HostDecision, number>;
  /** Hosts code left open this run (decided by the model, a cached answer, or the default). */
  ambiguous: number;
  modelCalls: number;
  tokens: { in: number; cached: number; out: number };
  receiptIds: string[];
}

const TRIAGE_FORMAT = "site-triage/v1";
const recordSchema = z
  .object({
    format: z.literal(TRIAGE_FORMAT),
    decision: z.enum(hostDecisions),
    reason: z.string().max(500),
    by: z.enum(["code", "model", "student", "default"]),
    signalsHash: z.string().max(64),
    decidedAt: z.string().max(40),
  })
  .strict();
type TriageRecord = z.infer<typeof recordSchema>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** The recipe store's layout slot for a course's triage: a hash, so no course ID is stored. */
export const triageKey = (accountScope: string, courseId: string) => `triage:${sha(`${accountScope}:${courseId}`).slice(0, 32)}`;

// ---------------------------------------------------------------- signals (Canvas only)
function locationOf(r: Resource, source: SourceHealth | undefined): LinkLocation {
  const scope = source?.scope.split(":")[0] ?? "";
  if (r.externalId === "syllabus" || scope === "syllabus") return "syllabus";
  if (r.moduleItem || scope === "module-items") return "module";
  if (r.kind === "assignment" || scope === "quizzes") return "assignment";
  // Before the message check: a discussion topic is stored as a message but is not an announcement.
  if (scope === "discussions") return "discussion";
  if (r.kind === "message" || scope === "announcements") return "announcement";
  if (scope === "page" || scope === "pages" || scope === "linked-page" || /\/pages\//.test(r.url)) return "page";
  return "other";
}
function normal(url: string): string {
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  return u.href;
}

/** Every outside host a course's Canvas content links, with where and how it is linked. */
export function hostSignals(store: SiteStore, course: { accountScope: string; courseId: string }): HostSignals[] {
  const sources = new Map(store.sources().map((s) => [s.id, s]));
  const hosts = new Map<string, HostSignals & { seenItems: Set<string> }>();
  for (const r of store.resources()) {
    const source = sources.get(r.sourceId);
    if (r.deleted || r.courseId !== course.courseId || source?.accountScope !== course.accountScope || source.kind !== "canvas") continue;
    let origin = "";
    try {
      origin = new URL(r.url).origin;
    } catch {
      continue;
    }
    const anchors = r.rawHtml ? anchorTexts(r.rawHtml, r.url) : new Map<string, string[]>();
    const links = (r.links ?? []).map((l) => (typeof l === "string" ? { url: l } : l)) as { url: string; text?: string }[];
    if (r.moduleItem?.externalUrl) links.push({ url: r.moduleItem.externalUrl, text: r.moduleItem.title ?? r.title });
    for (const link of links) {
      let url: URL;
      try {
        url = new URL(link.url);
      } catch {
        continue;
      }
      if (!/^https?:$/.test(url.protocol) || url.origin === origin || classifyHost(url.hostname).rule.kind.startsWith("canvas")) continue;
      const host = url.hostname.toLowerCase();
      const h = hosts.get(host) ?? { host, urls: [], locations: {}, items: [], anchors: [], messageUrls: [], messageAnchors: [], seenItems: new Set<string>() };
      hosts.set(host, h);
      const message = r.kind === "message";
      const urls = message ? h.messageUrls : h.urls;
      const texts = message ? h.messageAnchors : h.anchors;
      const target = normal(url.href);
      if (!urls.includes(target) && urls.length < 20) urls.push(target);
      if (!h.seenItems.has(r.id)) {
        h.seenItems.add(r.id);
        h.items.push(r.id);
        const where = locationOf(r, source);
        h.locations[where] = (h.locations[where] ?? 0) + 1;
      }
      for (const text of [link.text, ...(anchors.get(target) ?? [])])
        if (text && text.trim() && !texts.includes(text.trim()) && texts.length < 12) texts.push(text.trim().slice(0, 80));
    }
  }
  return [...hosts.values()].map(({ seenItems: _seen, ...h }) => h).sort((a, b) => a.host.localeCompare(b.host));
}
const signalsHash = (s: HostSignals) =>
  sha(JSON.stringify([[...s.urls].sort(), [...s.messageUrls].sort(), linkLocations.map((l) => s.locations[l] ?? 0), [...s.anchors].sort(), [...s.messageAnchors].sort()])).slice(0, 32);

// ---------------------------------------------------------------- code's rules
export interface CourseIdentity {
  /** Course numbers, as in "COMP SCI 564" or a cross-listing. */
  numbers: string[];
  /** Instructor surnames, lowercased, for `~name` paths. */
  surnames: string[];
}
/** Hosts the D40 table does not list but that are never course content. */
const EXTRA: { match: string; decision: HostDecision; reason: string }[] = [
  { match: ".zoom.us", decision: "link_only", reason: "a meeting link" },
  { match: ".webex.com", decision: "link_only", reason: "a meeting link" },
  { match: "teams.microsoft.com", decision: "link_only", reason: "a meeting link" },
  { match: "forms.gle", decision: "link_only", reason: "a form" },
  { match: "forms.office.com", decision: "link_only", reason: "a form" },
  { match: "www.google.com", decision: "ignore", reason: "a search page" },
  { match: "prairielearn.cs.wisc.edu", decision: "link_only", reason: "PrairieLearn: a homework platform with its own sign-in" },
  { match: ".prairielearn.com", decision: "link_only", reason: "PrairieLearn: a homework platform with its own sign-in" },
];
const MEDIA = /\.(?:png|jpe?g|gif|svg|webp|ico|bmp|tiff?|mp3|mp4|m4a|mov|webm|wav|ogg|woff2?|ttf|css|js)$/i;
const CDN = /(?:^|\.)(?:cdn|cdnapisec|static|assets?|media|img|images?)[.-]|(?:^|\.)s3[.-][a-z0-9.-]*amazonaws\.com$|^upload\.wikimedia\.org$|(?:^|\.)cloudfront\.net$/i;
const SITE_WORDS = /\b(?:course (?:web ?site|web ?page|page|site|home ?page)|class (?:web ?site|page|site)|schedule|calendar|lecture (?:notes|slides)|slides|homework|assignments?)\b/i;
const STUDENT_WRITABLE: LinkLocation[] = ["discussion"];
const CONTENT: LinkLocation[] = ["module", "assignment", "announcement", "page", "discussion"];
const matchHost = (m: string, host: string) => (m.startsWith(".") ? host === m.slice(1) || host.endsWith(m) : host === m);

/** The address names the course: a path segment or host label with its number, or an instructor's `~name`. */
export function namesCourse(url: string, id: CourseIdentity): string | null {
  const u = new URL(url);
  const parts = [...u.hostname.split("."), ...decodeURIComponent(u.pathname).toLowerCase().split("/").filter(Boolean)];
  for (const n of id.numbers)
    if (parts.some((p) => new RegExp(`^~?(?:[a-z]{1,10}[-_]?)?${n}(?:[-_.][a-z0-9]+)*$`, "i").test(p))) return `the course number ${n}`;
  for (const name of id.surnames)
    if (name.length >= 4 && parts.some((p) => p === `~${name}` || p === name || p.startsWith(`~${name}`))) return `the instructor's page (~${name})`;
  return null;
}
function docLike(url: string): boolean {
  const path = new URL(url).pathname;
  const segments = path.split("/").filter(Boolean);
  return /\.(?:pdf|html?|txt|md|docx?|pptx?)$/i.test(path) || segments.length >= 2 || segments.some((s) => (s.match(/-/g)?.length ?? 0) >= 2);
}
function where(s: HostSignals): string {
  const parts = linkLocations.filter((l) => s.locations[l]).map((l) => `${l}${(s.locations[l] ?? 0) > 1 ? ` ×${s.locations[l]}` : ""}`);
  return `linked from ${parts.join(", ")}`;
}

/** Code's decision, or the reason it is left to judgment. Deterministic and free. */
export function decideByCode(signals: HostSignals, id: CourseIdentity): { decision: HostDecision; reason: string } | { ambiguous: string } {
  // Code reads every signal, message ones included: nothing here leaves the device.
  const s = { ...signals, urls: [...signals.urls, ...signals.messageUrls], anchors: [...signals.anchors, ...signals.messageAnchors] };
  const host = s.host;
  if (isBlockedContentHost(host))
    return /^(?:login|idp|accounts)\./.test(host)
      ? { decision: "ignore", reason: "a sign-in page" }
      : { decision: "link_only", reason: "a social or short link the app never reads" };
  const known = classifyHost(host);
  if (!known.jev && known.rule.treatment === "link") return { decision: "link_only", reason: `${known.rule.name}: opened in its own site (D40)` };
  if (!known.jev && known.rule.kind === "code") return { decision: "link_only", reason: `${known.rule.name}: read by the code connector when the course links a project` };
  const extra = EXTRA.find((e) => matchHost(e.match, host));
  if (extra) return { decision: extra.decision, reason: extra.reason };
  if (CDN.test(host) || s.urls.every((u) => MEDIA.test(new URL(u).pathname)))
    return { decision: "ignore", reason: "embedded media or files, shown where Canvas embeds them" };
  // Discussions are student-writable, and the app does not record who posted, so a link seen only
  // there is never taken for the course's own site, whatever its address names.
  if (linkLocations.every((l) => !s.locations[l] || STUDENT_WRITABLE.includes(l)))
    return { decision: "link_only", reason: `linked only from a discussion, where students post; ${where(s)}` };
  const owned = s.urls.map((u) => namesCourse(u, id)).find(Boolean);
  if (owned) return { decision: "sync", reason: `the course's own site: its address names ${owned}; ${where(s)}` };
  const locations = linkLocations.filter((l) => s.locations[l]);
  const syllabusOnly = locations.length === 1 && locations[0] === "syllabus";
  const fromContent = CONTENT.some((l) => s.locations[l]);
  const uw = host === "wisc.edu" || host.endsWith(".wisc.edu");
  const siteWords = s.anchors.some((a) => SITE_WORDS.test(a));
  if (uw) {
    if (syllabusOnly && !siteWords) return { decision: "ignore", reason: "a campus-service link in the syllabus" };
    if (siteWords) return { ambiguous: `a UW site whose link reads like a course site; ${where(s)}` };
    if (s.items.length >= 3) return { ambiguous: `a UW site many items link; ${where(s)}` };
    if (fromContent && s.urls.some(docLike)) return { decision: "read_once", reason: `a UW page the course points at; ${where(s)}` };
    return { decision: "link_only", reason: `a UW site the course mentions; ${where(s)}` };
  }
  if (siteWords || s.items.length >= 3) return { ambiguous: `linked often or like a course site; ${where(s)}` };
  if (syllabusOnly) return { decision: "link_only", reason: "mentioned in the syllabus" };
  if (fromContent && s.urls.every(docLike)) return { decision: "read_once", reason: `a document the course points at; ${where(s)}` };
  return { ambiguous: `a tool or a site: its address alone doesn't say; ${where(s)}` };
}

/** The course numbers and instructor surnames code matches addresses against. */
export function courseIdentity(store: SiteStore, course: { accountScope: string; courseId: string }): CourseIdentity {
  const sources = new Map(store.sources().map((s) => [s.id, s]));
  const record = store
    .resources()
    .find((r) => !r.deleted && r.kind === "course" && r.courseId === course.courseId && sources.get(r.sourceId)?.accountScope === course.accountScope);
  const text = `${record?.course?.courseCode ?? ""} ${record?.courseName ?? ""}`;
  return {
    numbers: [...new Set(text.match(/(?<!\d)\d{3}(?!\d)/g) ?? [])],
    surnames: [...new Set((record?.course?.instructors ?? []).map((n) => n.trim().split(/\s+/).pop()!.toLowerCase().replace(/[^a-z-]/g, "")).filter((n) => n.length >= 4))],
  };
}

// ---------------------------------------------------------------- the service
export interface SiteTriageDeps {
  store: SiteStore;
  /** The student's own client, or null: ambiguous hosts stay links until it can judge them. */
  runner?: () => ModelRunner | null | Promise<ModelRunner | null>;
  artifacts?: ArtifactStore;
  ledger?: LedgerStore;
  now?: () => Date;
}

export function createSiteTriage(deps: SiteTriageDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const artifacts = deps.artifacts ?? memoryArtifactStore();
  const courseOf = (ref: string) => {
    const at = ref.lastIndexOf(":");
    return at > 0 ? { accountScope: ref.slice(0, at), courseId: ref.slice(at + 1) } : null;
  };
  const ledger =
    deps.ledger ?? (store.addLedgerEntry && store.ledger ? sqlLedgerStore(store as Pick<CourseCoreStore, "addLedgerEntry" | "ledger">, courseOf) : memoryLedgerStore());
  const { sendPack } = createSiteSender({ store, now, artifacts, ledger });

  function stored(host: string, key: string): { version: number; record: TriageRecord } | null {
    const row = store.extractionRecipe(host, key);
    const parsed = row ? recordSchema.safeParse(row.recipe) : null;
    return row && parsed?.success ? { version: row.version, record: parsed.data } : null;
  }
  function persist(host: string, key: string, next: Omit<TriageRecord, "format" | "decidedAt">) {
    const old = stored(host, key);
    const r = old?.record;
    if (r && r.decision === next.decision && r.by === next.by && r.signalsHash === next.signalsHash && r.reason === next.reason) return;
    const version = (store.extractionRecipe(host, key)?.version ?? 0) + 1;
    store.putExtractionRecipe({
      id: `tri_${sha(`${host}|${key}|${version}`).slice(0, 24)}`,
      host,
      layoutHash: key,
      version,
      recipe: { format: TRIAGE_FORMAT, ...next, decidedAt: now().toISOString() },
      validatedAt: now().toISOString(),
    });
  }

  /** Decide every outside host of a course. Code first; one batched call for the rest. */
  async function decide(course: { accountScope: string; courseId: string }, signal?: AbortSignal): Promise<TriageReport> {
    const key = triageKey(course.accountScope, course.courseId);
    const id = courseIdentity(store, course);
    const report: TriageReport = { hosts: [], counts: { ignore: 0, link_only: 0, read_once: 0, sync: 0 }, ambiguous: 0, modelCalls: 0, tokens: { in: 0, cached: 0, out: 0 }, receiptIds: [] };
    const open: { s: HostSignals; hash: string; reason: string; saved: TriageRecord | undefined }[] = [];
    const signals = hostSignals(store, course);
    for (const s of signals) {
      const hash = signalsHash(s);
      const saved = stored(s.host, key)?.record;
      if (saved?.by === "student") {
        report.hosts.push({ host: s.host, decision: saved.decision, reason: saved.reason, by: "student" });
        continue;
      }
      const code = decideByCode(s, id);
      if ("decision" in code) {
        persist(s.host, key, { decision: code.decision, reason: code.reason, by: "code", signalsHash: hash });
        report.hosts.push({ host: s.host, ...code, by: "code" });
        continue;
      }
      report.ambiguous++;
      // A judgment made for the same host, paths, anchors and locations is reused: no call.
      if (saved?.by === "model" && saved.signalsHash === hash) {
        report.hosts.push({ host: s.host, decision: saved.decision, reason: saved.reason, by: "model" });
        continue;
      }
      open.push({ s, hash, reason: code.ambiguous, saved });
    }
    // Only hosts with course-text evidence are sent; one seen only in messages stays a link.
    const sendable = open.filter(({ s }) => s.urls.length > 0);
    const runner = sendable.length ? await deps.runner?.() : null;
    let answer: HostsAnswer | null = null;
    if (sendable.length && runner) {
      const batch = sendable.slice(0, 40);
      const lines = batch.map(({ s }, i) => {
        const paths = s.urls.slice(0, 4).map((u) => new URL(u).pathname.slice(0, 80) || "/").join(", ");
        const anchors = s.anchors.slice(0, 4).map((a) => JSON.stringify(a)).join(", ");
        const counts = linkLocations.filter((l) => s.locations[l] && l !== "announcement").map((l) => `${l}×${s.locations[l]}`).join(", ");
        const items = s.items.filter((rid) => store.resource(rid)?.kind !== "message").length;
        return `h${i}: host=${s.host} paths=${paths}${anchors ? ` texts=${anchors}` : ""} linked from: ${counts} (${items} items)`;
      });
      const linking = [...new Set(batch.flatMap(({ s }) => s.items))]
        .map((rid) => store.resource(rid))
        .filter((r): r is Resource => !!r && r.kind !== "message");
      const sent = await sendPack(runner, hostsPack, linking, course, { ids: batch.map((_, i) => `h${i}`) }, { sourceId: "hosts", text: lines.join("\n") }, "Decide how the app treats outside websites the course links", report.receiptIds, signal, {
        skeleton: "Outside websites a course links from Canvas, listed by code.",
        policy: "Not applicable: this call decides which links the app reads and writes no coursework.",
      });
      report.modelCalls += sent.calls;
      report.tokens = sent.usage;
      if (sent.result.status === "done") answer = sent.result.artifact.output as HostsAnswer;
    }
    open.forEach(({ s, hash, reason, saved }) => {
      const i = sendable.findIndex((x) => x.s === s);
      const judged = i >= 0 && i < 40 ? answer?.hosts.find((h) => h.id === `h${i}`)?.decision : undefined;
      if (judged) {
        const why = `your AI judged it from how Canvas links it (${reason.split("; ").pop()})`;
        persist(s.host, key, { decision: judged, reason: why, by: "model", signalsHash: hash });
        report.hosts.push({ host: s.host, decision: judged, reason: why, by: "model" });
      } else if (saved?.by === "model") {
        // No judgment now (the AI is off or the call failed): the earlier judgment stands, so an
        // outage never downgrades a synced host. Its stale hash asks again next time.
        report.hosts.push({ host: s.host, decision: saved.decision, reason: saved.reason, by: "model" });
      } else {
        const why = `not decided yet (${reason}); kept as a link until your AI can judge it`;
        persist(s.host, key, { decision: "link_only", reason: why, by: "default", signalsHash: hash });
        report.hosts.push({ host: s.host, decision: "link_only", reason: why, by: "default" });
      }
    });
    report.hosts.sort((a, b) => a.host.localeCompare(b.host));
    for (const h of report.hosts) report.counts[h.decision]++;
    return report;
  }

  /** The student's choice for a host; it wins over code and the model until changed again. */
  function override(course: { accountScope: string; courseId: string }, host: string, decision: HostDecision) {
    persist(host.toLowerCase(), triageKey(course.accountScope, course.courseId), { decision, reason: "your choice", by: "student", signalsHash: "" });
  }

  /** Stored decisions for the hosts the course links now (no rule or model runs). */
  function decisions(course: { accountScope: string; courseId: string }): Map<string, HostTriage> {
    const key = triageKey(course.accountScope, course.courseId);
    const out = new Map<string, HostTriage>();
    for (const s of hostSignals(store, course)) {
      const r = stored(s.host, key)?.record;
      if (r) out.set(s.host, { host: s.host, decision: r.decision, reason: r.reason, by: r.by });
    }
    return out;
  }

  return { decide, override, decisions };
}

/** The crawler's seeds: only links on hosts decided `sync`. Nothing else is fetched by a sync. */
export function syncSeeds(urls: string[], decisions: Map<string, { decision: HostDecision }>): string[] {
  return urls.filter((u) => {
    try {
      return decisions.get(new URL(u).hostname.toLowerCase())?.decision === "sync";
    } catch {
      return false;
    }
  });
}
/** Links of one item to read on demand: hosts decided `read_once`, at most `limit`. */
export function readOnceTargets(resource: Resource, decisions: Map<string, { decision: HostDecision }>, limit = 5): string[] {
  const urls = (resource.links ?? []).map((l) => (typeof l === "string" ? l : l.url));
  if (resource.moduleItem?.externalUrl) urls.push(resource.moduleItem.externalUrl);
  return [...new Set(urls)]
    .filter((u) => {
      try {
        return decisions.get(new URL(u).hostname.toLowerCase())?.decision === "read_once";
      } catch {
        return false;
      }
    })
    .slice(0, limit);
}
