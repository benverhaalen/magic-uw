/**
 * Course websites into the same system as Canvas (plan D32 step 4; spec A5).
 *
 * The external crawler (`connectors/src/external.ts`) already reads a course's linked sites
 * politely: seeds from course content, folder scope, robots.txt, GET only, budgets. This module
 * reads only what that crawler stored and never opens a connection itself, so it cannot POST,
 * submit a form, click, or launch an LTI tool.
 *
 * Per stored page:
 * 1. code makes the outline and the layout fingerprint (`recipes.ts`);
 * 2. a stored recipe for (host, layout) is replayed by code: 0 model calls, 0 tokens;
 * 3. an unknown layout costs one call to the student's own AI (the `site-recipe` pack, pass
 *    tier, through consent, scrubbing and a receipt, like every pack); code checks the answer
 *    against the page and the call retries once with the failed checks, then gives up and the
 *    page stays link-only (no escalation: the recipe is cheap to try again next week);
 * 4. a replay that no longer fits marks the recipe stale and regenerates it once;
 * 5. rows code cannot place go to Jev as typed judgments, else to one batched call of the
 *    student's AI, else stay unplaced;
 * 6. items become resources under a `site` source: one organized digest per page (searchable,
 *    passages, and page-level deadline evidence), an assignment resource for work Canvas does not
 *    list, and exam dates as calendar entries. A date for work Canvas already lists is page
 *    evidence against the Canvas item, so a disagreement is shown, never applied silently.
 */
import { createHash } from "node:crypto";
import {
  aiRecipientSchema,
  resourceInputSchema,
  type CaptureBatch,
  type CourseCoreStore,
  type Resource,
  type ResourceInput,
  type Store,
} from "@magic/contracts";
import { maySend } from "@magic/domain";
import { JudgmentBudgetError, judgmentResultSchema, type JudgmentGateway, type KindJudgment } from "@magic/ai";
import type { ExtractionAnchors } from "../../domain/src/deadline-extraction";
import { identifiersIn } from "../../domain/src/deadline-extraction";
import { RunnerError, type BackendCall, type ClientId, type ModelRunner } from "../../runner/src/index";
import {
  buildPrompt,
  memoryArtifactStore,
  memoryLedgerStore,
  type ArtifactStore,
  type CourseFrame,
  type LedgerRecord,
  type LedgerStore,
  type PackSpec,
} from "../../packs/core/src/index";
import { sqlLedgerStore } from "../../packs/core/src/learning-stores";
import { recipePack, rowsPack, type RowsAnswer } from "../../packs/site/src/index";
import {
  applyRecipe,
  compileRecipe,
  itemKey,
  snapshotPage,
  storedRecipeSchema,
  RECIPE_FORMAT,
  type SiteItem,
  type RecipeAnswer,
  siteItemKinds,
  type SiteItemKind,
  type StoredRecipe,
} from "../../connectors/src/recipes";
import { isBlockedContentHost, isLoginHtml } from "../../connectors/src/external";
import { classifyHost } from "../../connectors/src/space-hosts";
import { contentCategories } from "./access";
import { termFromName } from "./deadline-evidence";
import { buildReceipt, egressFor } from "./egress";
import { payloadScrubber } from "./identity";
import { runPack } from "./jobs/pack";
import type { JobHandler } from "./jobs/registry";

export type SiteStore = Store &
  Pick<CourseCoreStore, "putExtractionRecipe" | "extractionRecipe" | "recordRecipeUse"> &
  Partial<Pick<CourseCoreStore, "courseSpaces" | "addLedgerEntry" | "ledger">>;

export interface SiteBudgets {
  /** Stored pages read per site per run; the rest keep their previous items. */
  pagesPerSite: number;
  /** Recipe calls (new layouts and regenerations) per course per run. */
  newLayoutsPerRun: number;
  /** Rows per page sent to Jev or the student's AI for placement. */
  leftoversPerPage: number;
  /** A layout whose recipe failed is tried again after this many days. */
  failedRetryDays: number;
}
export const DEFAULT_SITE_BUDGETS: SiteBudgets = { pagesPerSite: 40, newLayoutsPerRun: 6, leftoversPerPage: 24, failedRetryDays: 7 };

export interface SiteRecipeDeps {
  store: SiteStore;
  /** The student's own client, or null (no recipe calls; stored recipes still replay). */
  runner: () => ModelRunner | null | Promise<ModelRunner | null>;
  /** Jev's gateway (`assignment.kind.v1`), when configured. */
  jev?: JudgmentGateway;
  /** Core's save → enqueue hook, so the new items get passages and links like any capture. */
  onSaved?: (sourceId: string) => void;
  artifacts?: ArtifactStore;
  ledger?: LedgerStore;
  now?: () => Date;
  budgets?: Partial<SiteBudgets>;
}

export type PageRoute = "replayed" | "generated" | "regenerated" | "unchanged" | "link_only" | "skipped";
export interface SitePageReport {
  url: string;
  host: string;
  layoutHash: string | null;
  recipeId: string | null;
  route: PageRoute;
  reason?: string;
  items: number;
  /** Provider-reported tokens for this page's recipe call(s); 0 on replay. */
  tokens: { in: number; cached: number; out: number };
  modelCalls: number;
  /** Estimated tokens of the HTML and of the outline the model would read (4 chars per token). */
  htmlTokens: number;
  snapshotTokens: number;
  /** Estimated tokens of the whole prompt sent (system prefix + outline), when a call was made. */
  promptTokens: number;
  checkErrors?: string[];
}
export interface SiteRunReport {
  course: { accountScope: string; courseId: string };
  pages: SitePageReport[];
  recipes: { generated: number; regenerated: number; replayed: number; failed: number; unchanged: number };
  tokens: { in: number; cached: number; out: number };
  modelCalls: number;
  leftovers: { total: number; byJev: number; byModel: number; cached: number; unplaced: number };
  jevCalls: number;
  items: Record<SiteItemKind | "unplaced", number>;
  /** Assignment rows that name a Canvas assignment: their dates are page evidence against it. */
  matchedCanvas: number;
  sourceIds: string[];
  receiptIds: string[];
  durationMs: number;
}

class GiveUp extends Error {}
class Blocked extends Error {}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const recipientOf: Record<ClientId, string> = {
  claude: "claude", anthropic: "claude", codex: "codex", openai: "chatgpt", openrouter: "openrouter", gemini: "gemini", local: "local",
};
const ROW_VERSION = "site.row.kind.v1";
const zero = () => ({ in: 0, cached: 0, out: 0 });
const MAX_BATCH = 2000;

/** The resource a stored page came from: crawled HTML under a `web` source. */
export const isSitePage = (r: Resource) => r.kind === "material" && !!r.rawHtml && !!r.crawl && !r.deleted;
export const siteSourceId = (accountScope: string, courseId: string, host: string) =>
  `site:${sha(`${accountScope}:${courseId}:${host}`).slice(0, 24)}`;

/** Jev's kind distribution → a placement, only when it is confident (provisional, uncalibrated). */
function placeFromJev(j: KindJudgment): SiteItemKind | null {
  const p = j.probabilities[j.kind] ?? 0;
  if (p < 0.7) return null;
  if (j.kind === "reading") return "reading";
  return j.kind === "other" ? null : "assignment";
}

const RECIPE_FRAME = {
  skeleton: "A course website page, outlined by code.",
  policy: "Not applicable: this call maps page structure and writes no coursework.",
};
export interface SiteSendContext {
  store: SiteStore;
  now: () => Date;
  artifacts: ArtifactStore;
  ledger: LedgerStore;
}
/** One checked, consented, receipted call for the course-website packs (recipes, rows, host triage). */
export function createSiteSender(ctx: SiteSendContext) {
  const { store, now, artifacts, ledger } = ctx;
/** The shared send path's steps: permission, the held-preview policy, a receipt per send. */
function authorizer(resourceIds: string[], purpose: string, receiptIds: string[]) {
  return (recipient: string, categories: string[], payload?: unknown) => {
    const parsed = aiRecipientSchema.safeParse(recipient);
    if (!parsed.success) return { allowed: false, reason: "This recipient is not supported." };
    const permission = maySend(store.privacy(), recipient, categories);
    if (payload === undefined) return permission;
    const m = {
      recipient: parsed.data,
      purpose,
      categories,
      resourceIds,
      characters: JSON.stringify(payload).length,
      allowed: permission.allowed,
      reason: permission.reason,
      payload,
    };
    const at = now().toISOString();
    const decision = egressFor(store).check(m, { at, background: true });
    if (decision.status === "blocked") {
      receiptIds.push(decision.receiptId);
      return { allowed: false, reason: decision.reason };
    }
    if (decision.status === "preview_required") {
      receiptIds.push(decision.previewId);
      return { allowed: false, reason: decision.reason };
    }
    const receipt = buildReceipt(m, "sent", at);
    store.addReceipt(receipt);
    receiptIds.push(receipt.id);
    return { allowed: true, reason: permission.reason };
  };
}

/** One checked call through the student's client; retries once on failed checks, never escalates. */
async function sendPack<I, O>(
  runner: ModelRunner,
  pack: PackSpec<I, O>,
  from: Resource[],
  course: { accountScope: string; courseId: string },
  input: I,
  passage: { sourceId: string; text: string },
  purpose: string,
  receiptIds: string[],
  signal?: AbortSignal,
  frameText: { skeleton: string; policy: string } = RECIPE_FRAME,
) {
  const hosted = runner.client !== "local";
  const scrubber = payloadScrubber(store, hosted, course.accountScope);
  const scrub = (v: string) => scrubber.field(v, course.courseId);
  const categories = [...new Set([...pack.categories, ...from.flatMap(contentCategories)])];
  const authorize = authorizer(from.map((r) => r.id).slice(0, 200), purpose, receiptIds);
  const frame: CourseFrame = {
    courseId: `${course.accountScope}:${course.courseId}`,
    course: "Course website",
    skeleton: frameText.skeleton,
    policy: frameText.policy,
  };
  const passages = [{ sourceId: passage.sourceId, text: passage.text }];
  const prompt = buildPrompt(pack, frame, input, passages);
  let calls = 0;
  let usage = zero();
  const counting: LedgerStore = {
    append(r: LedgerRecord) {
      // Every attempt's provider usage, including a retry and an answer that failed the checks.
      if (!("outcome" in r && r.outcome === "cache_hit")) {
        calls++;
        usage = add(usage, r.usage);
      }
      ledger.append(r);
    },
    list: (f) => ledger.list(f),
  };
  const beforeCall = (call: BackendCall): BackendCall => {
    // Retry once at the pass tier with the failed checks, then give up (no escalation).
    if (call.tier !== pack.tier) throw new GiveUp();
    const outgoing = { ...call, courseId: hosted ? undefined : call.courseId, systemPrompt: scrub(call.systemPrompt), input: scrub(call.input) };
    const permission = authorize(recipientOf[runner.client], categories, { systemPrompt: outgoing.systemPrompt, input: outgoing.input, jsonSchema: outgoing.jsonSchema });
    if (!permission.allowed) throw new Blocked(permission.reason);
    return outgoing;
  };
  const promptTokens = Math.ceil((prompt.systemPrompt.length + prompt.input.length) / 4);
  try {
    const result = await runPack(
      { runner, artifacts, ledger: counting, authorize: (r, c) => authorize(r, [...new Set([...c, ...categories])]), beforeCall, now: () => now().getTime() },
      { ...pack, categories },
      frame,
      input,
      passages,
      { lane: "background", scope: "site", ...(signal ? { signal } : {}) },
    );
    return { result, calls, usage, promptTokens };
  } catch (error) {
    if (error instanceof GiveUp) return { result: { status: "gave_up" as const }, calls, usage, promptTokens };
    if (error instanceof Blocked) return { result: { status: "blocked" as const, reason: error.message }, calls, usage, promptTokens };
    if (error instanceof RunnerError) return { result: { status: "failed" as const, message: error.studentMessage }, calls, usage, promptTokens };
    throw error;
  }
}
  return { authorizer, sendPack };
}

export function createSiteRecipes(deps: SiteRecipeDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const budgets = { ...DEFAULT_SITE_BUDGETS, ...deps.budgets };
  const artifacts = deps.artifacts ?? memoryArtifactStore();
  const courseOf = (ref: string) => {
    const at = ref.lastIndexOf(":");
    return at > 0 ? { accountScope: ref.slice(0, at), courseId: ref.slice(at + 1) } : null;
  };
  const ledger =
    deps.ledger ?? (store.addLedgerEntry && store.ledger ? sqlLedgerStore(store as Pick<CourseCoreStore, "addLedgerEntry" | "ledger">, courseOf) : memoryLedgerStore());
  const { authorizer, sendPack } = createSiteSender({ store, now, artifacts, ledger });

  async function ingestCourse(course: { accountScope: string; courseId: string }, signal?: AbortSignal): Promise<SiteRunReport> {
    const started = Date.now();
    const report: SiteRunReport = {
      course,
      pages: [],
      recipes: { generated: 0, regenerated: 0, replayed: 0, failed: 0, unchanged: 0 },
      tokens: zero(),
      modelCalls: 0,
      leftovers: { total: 0, byJev: 0, byModel: 0, cached: 0, unplaced: 0 },
      jevCalls: 0,
      items: { schedule: 0, assignment: 0, reading: 0, material: 0, staff: 0, announcement: 0, unplaced: 0 },
      matchedCanvas: 0,
      sourceIds: [],
      receiptIds: [],
      durationMs: 0,
    };
    const sources = new Map(store.sources().map((s) => [s.id, s]));
    const all = store.resources();
    const inCourse = (r: Resource) => r.courseId === course.courseId && sources.get(r.sourceId)?.accountScope === course.accountScope;
    // The crawler's own source only: pages read once on demand (triage `read_once`) never get recipes.
    const pages = all.filter((r) => inCourse(r) && sources.get(r.sourceId)?.kind === "web" && sources.get(r.sourceId)?.scope === "course_websites" && isSitePage(r));
    if (!pages.length) return { ...report, durationMs: Date.now() - started };

    // Only hosts the course itself points at: the crawler's seeds and the inventory's readable spaces.
    const allowedHosts = new Set<string>();
    for (const p of pages) if ((p.crawl?.depth ?? 0) === 0) allowedHosts.add(new URL(p.url).hostname);
    for (const s of store.courseSpaces?.(course) ?? [])
      if (s.storeOrLink === "store" && (s.route === "public" || s.route === "uw-session")) allowedHosts.add(s.host);

    const canvasAssignments = all.filter(
      (r) => inCourse(r) && !r.deleted && r.kind === "assignment" && sources.get(r.sourceId)?.kind === "canvas" && sources.get(r.sourceId)?.scope !== "submissions",
    );
    const courseRecord = all.find((r) => inCourse(r) && r.kind === "course" && !r.deleted)?.course;
    const term =
      courseRecord?.startAt && courseRecord.endAt && Date.parse(courseRecord.endAt) > Date.parse(courseRecord.startAt)
        ? { start: courseRecord.startAt, end: courseRecord.endAt }
        : termFromName(courseRecord?.termName ?? undefined);
    const courseName = all.find((r) => inCourse(r) && r.kind === "course" && !r.deleted)?.courseName ?? pages[0]!.courseName;
    // Course numbers (564 in "COMP SCI 564" or a cross-listing "CS/ECE 552"): a course's own site
    // names one in its address or title.
    const numbers = [...new Set(`${courseRecord?.courseCode ?? ""} ${courseName}`.match(/(?<!\d)\d{3}(?!\d)/g) ?? [])];

    const byHost = new Map<string, Resource[]>();
    for (const page of pages) {
      const host = new URL(page.url).hostname;
      byHost.set(host, [...(byHost.get(host) ?? []), page]);
    }
    const regenerated = new Set<string>();
    let calls = 0;
    const runner = await deps.runner();

    for (const [host, hostPages] of [...byHost].sort((a, b) => a[0].localeCompare(b[0]))) {
      signal?.throwIfAborted();
      const sourceId = siteSourceId(course.accountScope, course.courseId, host);
      const previous = all.filter((r) => r.sourceId === sourceId && !r.deleted);
      const previousByPage = new Map<string, Resource[]>();
      for (const r of previous) {
        const page = r.provenance?.sourceUrl ?? "";
        previousByPage.set(page, [...(previousByPage.get(page) ?? []), r]);
      }
      const out: ResourceInput[] = [];
      let changed = false;
      const ordered = [...hostPages].sort((a, b) => (a.crawl?.depth ?? 0) - (b.crawl?.depth ?? 0) || a.url.localeCompare(b.url));
      for (const [index, page] of ordered.entries()) {
        signal?.throwIfAborted();
        const keep = () => out.push(...(previousByPage.get(page.url) ?? []).map(toInput));
        const base: SitePageReport = { url: page.url, host, layoutHash: null, recipeId: null, route: "skipped", items: 0, tokens: zero(), modelCalls: 0, htmlTokens: 0, snapshotTokens: 0, promptTokens: 0 };
        if (!allowedHosts.has(host) || isBlockedContentHost(host)) {
          report.pages.push({ ...base, reason: "The course does not link this host." });
          continue;
        }
        // A known platform (Piazza, Box, YouTube...) stays a link; an unknown host (a GitHub Pages
        // or personal course site) is exactly what recipes are for.
        const hostClass = classifyHost(host);
        if (!hostClass.jev && hostClass.rule.treatment === "link") {
          report.pages.push({ ...base, reason: "A platform the app links to (D40); its pages are not organized." });
          continue;
        }
        if (isLoginHtml(page.rawHtml!)) {
          // A failed capture (an expired session) never erases the page's earlier items.
          keep();
          report.pages.push({ ...base, reason: "The stored page is a sign-in page; previous items kept." });
          continue;
        }
        if (index >= budgets.pagesPerSite) {
          keep();
          report.pages.push({ ...base, reason: "Over this sync's page budget; previous items kept." });
          continue;
        }
        const prevDigest = previousByPage.get(page.url)?.find((r) => r.externalId.startsWith("digest:"));
        // Unchanged page whose layout's recipe is still valid: decided from the digest alone,
        // before any HTML parse.
        const prevLayout = /; layout=([^;\s]+)/.exec(prevDigest?.provenance?.contentType ?? "")?.[1];
        if (prevLayout && prevDigest?.crawl?.contentHash === page.contentHash) {
          const known = store.extractionRecipe(host, prevLayout);
          const valid = known ? storedRecipeSchema.safeParse(known.recipe) : null;
          if (known && valid?.success && valid.data.status === "valid" && prevDigest.provenance?.contentType === recipeTag(known.id, prevLayout)) {
            keep();
            report.pages.push({ ...base, layoutHash: prevLayout, route: "unchanged", recipeId: known.id, items: previousByPage.get(page.url)?.length ?? 0 });
            report.recipes.unchanged++;
            continue;
          }
        }
        const snap = snapshotPage(page.rawHtml!, page.url);
        const pageReport: SitePageReport = { ...base, layoutHash: snap.layoutHash, htmlTokens: snap.htmlTokens, snapshotTokens: snap.snapshotTokens };
        report.pages.push(pageReport);
        const anchors: ExtractionAnchors = {
          ...(term ? { term } : {}),
          ...(page.crawl?.observedAt ?? page.crawl?.fetchedAt ? { sourceDate: (page.crawl?.observedAt ?? page.crawl?.fetchedAt)! } : {}),
        };
        // Code gates before any recipe call: nothing structured to map, or (for a layout with no
        // recipe yet) a page that does not name this course, such as a UW service page a syllabus
        // links to. Those stay stored as plain pages by the crawler, as before.
        if (!snap.blocks.length) {
          keep();
          pageReport.reason = "No tables, lists or sections to organize.";
          continue;
        }
        const stored = store.extractionRecipe(host, snap.layoutHash);
        const parsed = stored ? storedRecipeSchema.safeParse(stored.recipe) : null;
        let recipe: { id: string; version: number; recipe: StoredRecipe } | null =
          stored && parsed?.success ? { id: stored.id, version: stored.version, recipe: parsed.data } : null;
        if (!recipe && numbers.length && !namesCourse(page, snap, numbers)) {
          keep();
          pageReport.reason = "The page's address and title do not name this course.";
          continue;
        }

        // Unchanged page and the same valid recipe: nothing to do, not even a replay.
        if (recipe?.recipe.status === "valid" && prevDigest?.crawl?.contentHash === page.contentHash && prevDigest.provenance?.contentType === recipeTag(recipe.id, snap.layoutHash)) {
          keep();
          pageReport.route = "unchanged";
          pageReport.recipeId = recipe.id;
          pageReport.items = previousByPage.get(page.url)?.length ?? 0;
          report.recipes.unchanged++;
          continue;
        }
        let items: SiteItem[] | null = null;
        if (recipe?.recipe.status === "valid") {
          const replay = applyRecipe(snap.root, recipe.recipe, anchors);
          store.recordRecipeUse(recipe.id, !replay.errors.length);
          if (!replay.errors.length) {
            items = replay.items;
            pageReport.route = "replayed";
            pageReport.recipeId = recipe.id;
            report.recipes.replayed++;
          } else {
            pageReport.checkErrors = replay.errors;
            const key = `${host}|${snap.layoutHash}`;
            if (regenerated.has(key) || calls >= budgets.newLayoutsPerRun) {
              keep();
              pageReport.route = "link_only";
              pageReport.reason = "The layout's recipe no longer fits and was already regenerated this sync; previous items kept.";
              continue;
            }
            regenerated.add(key);
            store.putExtractionRecipe({ id: recipe.id, host, layoutHash: snap.layoutHash, version: recipe.version, recipe: { ...recipe.recipe, status: "stale" }, validatedAt: null });
            recipe = null;
            pageReport.route = "regenerated";
          }
        } else if (recipe?.recipe.status === "failed") {
          const failedAt = Date.parse(recipe.recipe.failedAt ?? "");
          if (Number.isFinite(failedAt) && now().getTime() - failedAt < budgets.failedRetryDays * 86_400_000) {
            keep();
            pageReport.route = "link_only";
            pageReport.recipeId = recipe.id;
            pageReport.reason = "This layout could not be mapped recently; the page stays a link.";
            continue;
          }
        }
        if (!items) {
          const route = pageReport.route === "regenerated" ? "regenerated" : "generated";
          if (calls >= budgets.newLayoutsPerRun) {
            keep();
            pageReport.route = "link_only";
            pageReport.reason = "Over this sync's budget for new layouts; tried next sync.";
            continue;
          }
          if (!runner) {
            keep();
            pageReport.route = "link_only";
            pageReport.reason = "Connect your AI to organize this site; the page stays a link until then.";
            continue;
          }
          calls++;
          const generated = await generate(runner, page, course, snap, anchors, host, (stored?.version ?? 0) + 1, report.receiptIds, signal);
          pageReport.tokens = generated.tokens;
          pageReport.modelCalls = generated.calls;
          pageReport.promptTokens = generated.promptTokens;
          report.modelCalls += generated.calls;
          report.tokens = add(report.tokens, generated.tokens);
          if (!generated.ok) {
            keep();
            pageReport.route = "link_only";
            pageReport.reason = generated.reason;
            if (generated.checkErrors) pageReport.checkErrors = generated.checkErrors;
            if (generated.stored) report.recipes.failed++;
            continue;
          }
          items = generated.items;
          recipe = generated.recipe;
          pageReport.route = route;
          pageReport.recipeId = generated.recipe.id;
          report.recipes[route]++;
        }
        const placed = await placeLeftovers(runner, page, course, items, report, prevDigest, signal);
        const resources = toResources(page, placed, recipeTag(recipe!.id, snap.layoutHash), canvasAssignments, report);
        pageReport.items = placed.length;
        out.push(...resources);
        changed = true;
      }
      // Items of pages that disappeared from the crawl leave with them.
      if (previous.some((r) => !hostPages.some((p) => p.url === r.provenance?.sourceUrl))) changed = true;
      if (!changed || !out.length && !previous.length) continue;
      save({
        source: {
          id: sourceId,
          label: `${hostPages[0]!.courseName} website: ${host}`.slice(0, 200),
          kind: "site",
          accountScope: course.accountScope,
          courseId: course.courseId,
          scope: `site_items:${host}`,
        },
        observedAt: now().toISOString(),
        complete: true,
        status: "ok",
        resources: dedupe(out).slice(0, MAX_BATCH),
      });
      report.sourceIds.push(sourceId);
    }
    report.durationMs = Date.now() - started;
    return report;
  }

  function save(batch: CaptureBatch) {
    const previous = store.sources().find((s) => s.id === batch.source.id);
    if (previous && batch.observedAt <= previous.lastAttemptAt)
      batch = { ...batch, observedAt: new Date(Date.parse(previous.lastAttemptAt) + 1).toISOString() };
    store.ingest(batch);
    deps.onSaved?.(batch.source.id);
  }

  async function generate(
    runner: ModelRunner,
    page: Resource,
    course: { accountScope: string; courseId: string },
    snap: ReturnType<typeof snapshotPage>,
    anchors: ExtractionAnchors,
    host: string,
    version: number,
    receiptIds: string[],
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; recipe: { id: string; version: number; recipe: StoredRecipe }; items: SiteItem[]; tokens: SitePageReport["tokens"]; calls: number; promptTokens: number }
    | { ok: false; reason: string; stored: boolean; checkErrors?: string[]; tokens: SitePageReport["tokens"]; calls: number; promptTokens: number }
  > {
    let lastErrors: string[] = [];
    const check = (answer: RecipeAnswer) => {
      const compiled = compileRecipe(answer, snap);
      if (!compiled.recipe) return (lastErrors = compiled.errors);
      return (lastErrors = applyRecipe(snap.root, compiled.recipe, anchors).errors);
    };
    const pack = { ...recipePack, checks: [(o: RecipeAnswer) => check(o)] };
    const sent = await sendPack(runner, pack, [page], course, { outline: snap.text }, { sourceId: "page", text: snap.text }, "Map a course website page's layout to a reusable extraction recipe", receiptIds, signal);
    const id = `rcp_${sha(`${host}|${snap.layoutHash}|${version}`).slice(0, 24)}`;
    const r = sent.result;
    const tokens = sent.usage;
    if (r.status === "done") {
      const compiled = compileRecipe(r.artifact.output, snap);
      if (compiled.recipe) {
        const recipe: StoredRecipe = { ...compiled.recipe, status: "valid", generatedBy: { client: r.artifact.client, model: r.artifact.model.slice(0, 200) }, tokens: { in: tokens.in, out: tokens.out }, failedAt: null };
        // The cached answer was checked against its own page; check it against this one too.
        const replay = applyRecipe(snap.root, recipe, anchors);
        if (!replay.errors.length) {
          store.putExtractionRecipe({ id, host, layoutHash: snap.layoutHash, version, recipe, validatedAt: now().toISOString() });
          return { ok: true, recipe: { id, version, recipe }, items: replay.items, tokens, calls: sent.calls, promptTokens: sent.promptTokens };
        }
        lastErrors = replay.errors;
      } else lastErrors = compiled.errors;
    }
    if (r.status === "blocked") return { ok: false, reason: r.reason, stored: false, tokens, calls: sent.calls, promptTokens: sent.promptTokens };
    if (r.status === "paused" || r.status === "failed")
      return { ok: false, reason: r.message, stored: false, tokens, calls: sent.calls, promptTokens: sent.promptTokens };
    // The answer failed code's checks twice: remember that, so the next syncs don't pay again.
    const failed: StoredRecipe = { format: RECIPE_FORMAT, status: "failed", pageKind: "other", collections: [], generatedBy: null, tokens: { in: 0, out: 0 }, failedAt: now().toISOString() };
    store.putExtractionRecipe({ id, host, layoutHash: snap.layoutHash, version, recipe: failed, validatedAt: null });
    return { ok: false, reason: "The page's layout could not be mapped; it stays a link.", stored: true, checkErrors: lastErrors, tokens, calls: sent.calls, promptTokens: sent.promptTokens };
  }

  /** Jev first (typed, per row), else one batched call of the student's AI, else unplaced. */
  async function placeLeftovers(
    runner: ModelRunner | null,
    page: Resource,
    course: { accountScope: string; courseId: string },
    items: SiteItem[],
    report: SiteRunReport,
    previous: Resource | undefined,
    signal?: AbortSignal,
  ): Promise<SiteItem[]> {
    const open = items.filter((i) => i.kind === null);
    report.leftovers.total += open.length;
    if (!open.length) return items;
    // Judgments hold one page version (the store ties them to the page's content hash).
    const keyOf = (i: SiteItem) => `site-row:${page.id}:${page.contentHash.slice(0, 16)}:${sha(i.text).slice(0, 32)}`;
    const placed = new Map<SiteItem, SiteItemKind | null>();
    // Across versions, the previous organized page is the cache: a row whose exact line already
    // sits under a kind's heading keeps that kind, so an edit elsewhere on the page costs nothing.
    const earlier = new Map<string, Set<string>>();
    for (const part of previous?.parts ?? []) {
      const kind = SECTION_KIND.get(part.section ?? "");
      if (kind) earlier.set(kind, new Set(part.text.split("\n")));
    }
    for (const item of open) {
      const kind = siteItemKinds.find((k) => earlier.get(k)?.has(lineFor(item, k)));
      if (kind) {
        placed.set(item, kind);
        report.leftovers.cached++;
      }
    }
    for (const item of open) {
      if (placed.has(item)) continue;
      const cached = store.judgment(keyOf(item));
      const kind = (cached?.result as { kind?: string } | undefined)?.kind;
      if (cached && cached.questionVersion === ROW_VERSION) {
        placed.set(item, kind && kind !== "none" ? (kind as SiteItemKind) : null);
        report.leftovers.cached++;
      }
    }
    const remember = (item: SiteItem, kind: SiteItemKind | null, model: string, extra: unknown) =>
      store.putJudgment({ key: keyOf(item), resourceId: page.id, inputHash: page.contentHash, model: model.slice(0, 200) || "unknown", questionVersion: ROW_VERSION, result: { kind: kind ?? "none", extra }, createdAt: now().toISOString() });
    let pending = open.filter((i) => !placed.has(i)).slice(0, budgets.leftoversPerPage);
    const hostedScrub = payloadScrubber(store, true, course.accountScope);
    if (pending.length && deps.jev && maySend(store.privacy(), "jev", ["course_text"]).allowed) {
      const authorize = authorizer([page.id], "Place a course website row (assignment, reading or other)", report.receiptIds);
      for (const item of pending) {
        signal?.throwIfAborted();
        const payload = {
          course: hostedScrub.field(page.courseName, course.courseId),
          title: hostedScrub.field(item.title, course.courseId),
          text: hostedScrub.field(item.text, course.courseId),
          policy: "",
        };
        if (!authorize("jev", ["course_text"], payload).allowed) break;
        const call = new AbortController();
        const abort = () => call.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, 20_000);
        try {
          report.jevCalls++;
          const judgment = judgmentResultSchema.parse(await deps.jev.evaluate(payload, call.signal));
          const kind = placeFromJev(judgment);
          placed.set(item, kind);
          remember(item, kind, judgment.model, { jev: judgment.kind, p: judgment.probabilities[judgment.kind] });
          if (kind) report.leftovers.byJev++;
        } catch (error) {
          store.addReceipt(
            buildReceipt(
              { recipient: "jev", purpose: "Place a course website row (assignment, reading or other)", categories: ["course_text"], resourceIds: [page.id], characters: JSON.stringify(payload).length },
              "failed",
              now().toISOString(),
            ),
          );
          // A budget refusal or an outage leaves the rest unplaced for now; nothing is guessed.
          if (error instanceof JudgmentBudgetError || !signal?.aborted) break;
          throw error;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        }
      }
      pending = [];
    }
    if (pending.length && runner) {
      const ids = pending.map((_, i) => `r${i}`);
      const text = pending.map((item, i) => `r${i}: ${item.text.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
      const sent = await sendPack(runner, rowsPack, [page], course, { ids }, { sourceId: "rows", text }, "Place course website rows that code could not", report.receiptIds, signal);
      report.modelCalls += sent.calls;
      report.tokens = add(report.tokens, sent.usage);
      const r = sent.result;
      if (r.status === "done") {
        const answer = r.artifact.output as RowsAnswer;
        pending.forEach((item, i) => {
          const kind = answer.items.find((x) => x.id === `r${i}`)?.kind ?? "none";
          const k = kind === "none" ? null : (kind as SiteItemKind);
          placed.set(item, k);
          remember(item, k, r.artifact.model, null);
          if (k) report.leftovers.byModel++;
        });
      }
    }
    return items.map((i) => (i.kind === null && placed.get(i) ? { ...i, kind: placed.get(i)! } : i));
  }

  /** A Canvas assignment this row names: one shared identifier (HW3) or the same title. */
  function canvasMatch(title: string, canvas: Resource[]): Resource | null {
    const ids = identifiersIn(title);
    if (ids.length) {
      const hits = canvas.filter((c) => identifiersIn(c.title).some((x) => ids.includes(x)));
      if (hits.length === 1) return hits[0]!;
    }
    const t = norm(title);
    const exact = canvas.filter((c) => norm(c.title) === t);
    if (exact.length === 1) return exact[0]!;
    if (t.length < 6) return null;
    const near = canvas.filter((c) => norm(c.title).length >= 6 && (` ${norm(c.title)} `.includes(` ${t} `) || ` ${t} `.includes(` ${norm(c.title)} `)));
    return near.length === 1 ? near[0]! : null;
  }

  function toResources(page: Resource, items: SiteItem[], tag: string, canvas: Resource[], report: SiteRunReport): ResourceInput[] {
    const observedAt = page.crawl?.observedAt ?? page.crawl?.fetchedAt ?? now().toISOString();
    const provenance = { sourceUrl: page.url, discoveredFrom: page.url, contentType: tag, contentHash: page.contentHash, observedAt };
    const crawl = { discoveredFrom: page.url, contentType: "text/html", contentHash: page.contentHash, observedAt };
    const common = { courseId: page.courseId, courseName: page.courseName, provenance, crawl, createdAt: observedAt };
    const urlOf = (item: SiteItem) => item.links.map((l) => l.url).find((u) => resourceInputSchema.shape.url.safeParse(u).success) ?? page.url;
    const out: ResourceInput[] = [];
    const seen = new Map<string, number>();
    const key = (kind: string, title: string) => {
      const k = `${kind}|${norm(title)}`;
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      return itemKey(page.url, kind, title, n);
    };
    const lines: Record<SiteItemKind | "unplaced", string[]> = { schedule: [], assignment: [], reading: [], material: [], staff: [], announcement: [], unplaced: [] };
    for (const item of items) {
      report.items[item.kind ?? "unplaced"]++;
      lines[item.kind ?? "unplaced"].push(lineFor(item, item.kind ?? "unplaced"));
      if (item.kind === "assignment") {
        const match = canvasMatch(item.title, canvas);
        if (match) {
          report.matchedCanvas++;
          continue;
        }
        out.push({
          ...common,
          externalId: `assignment:${key("assignment", item.title)}`,
          kind: "assignment",
          title: item.title.slice(0, 500),
          url: urlOf(item),
          text: item.text,
          links: item.links.map((l) => ({ url: l.url, text: l.text })),
          points: item.points,
          submitted: null,
          deadlines: item.date
            ? [{ value: item.date.value, kind: "due", quote: item.text.slice(0, 4000), authority: "document", scopeConfirmed: true }]
            : [],
          policy: { mode: "unknown", evidence: "" },
        });
      } else if (item.kind === "schedule") {
        // Exams belong on the agenda; ordinary class topics stay in the organized page.
        if (item.date && /\b(?:exam|midterm|final|quiz|test)\b/i.test(item.title)) {
          const dayOnly = item.date.precision === "day";
          const local = new Date(Date.parse(item.date.value) + chicagoOffset(item.date.value)).toISOString().slice(0, 10);
          out.push({
            ...common,
            externalId: `event:${key("event", item.title)}`,
            kind: "event",
            title: item.title.slice(0, 500),
            url: page.url,
            text: item.text,
            links: item.links.map((l) => ({ url: l.url, text: l.text })),
            calendar: { uid: `site-${key("uid", item.title)}`, start: dayOnly ? local : item.date.value, allDay: dayOnly },
            deadlines: [],
            points: null,
            submitted: null,
            policy: { mode: "unknown", evidence: "" },
          });
        }
      }
    }
    // One section per kind; each is a part, so passages carry the section as their heading.
    let text = "";
    const parts: { text: string; section: string; start: number; end: number }[] = [];
    for (const [kind, list] of Object.entries(lines) as [SiteItemKind | "unplaced", string[]][]) {
      if (!list.length) continue;
      const block = `${SECTIONS[kind]}\n${list.join("\n")}`;
      const start = text ? text.length + 2 : 0;
      if (start + block.length > 200000) break;
      text = text ? `${text}\n\n${block}` : block;
      parts.push({ text: block, section: SECTIONS[kind], start, end: start + block.length });
    }
    if (text) {
      const links = [...new Map(items.flatMap((i) => i.links).map((l) => [l.url, l])).values()].slice(0, 4000);
      out.unshift({
        ...common,
        externalId: `digest:${sha(page.url).slice(0, 24)}`,
        kind: "material",
        title: `${(page.title || "Course website").slice(0, 440)} (organized)`,
        url: page.url,
        text,
        parts,
        links: links.map((l) => ({ url: l.url, text: l.text })),
        deadlines: [],
        points: null,
        submitted: null,
        policy: { mode: "unknown", evidence: "" },
      });
    }
    return out.flatMap((r) => {
      const parsed = resourceInputSchema.safeParse(r);
      return parsed.success ? [parsed.data] : [];
    });
  }

  return { ingestCourse };
}

const SECTIONS: Record<SiteItemKind | "unplaced", string> = {
  schedule: "Schedule", assignment: "Assignments", reading: "Readings", material: "Slides and materials",
  staff: "Staff and office hours", announcement: "Announcements", unplaced: "Other items",
};
const SECTION_KIND = new Map(Object.entries(SECTIONS).map(([k, v]) => [v, k]));
/**
 * One organized line per item. An assignment reads "<title>: due <the page's own date phrase>",
 * which the deadline grammar re-reads as page evidence for a Canvas item of that name.
 * Announcement bodies stay on the crawled page: a site's news never becomes a "changed due
 * date" claim against Canvas.
 */
function lineFor(item: SiteItem, kind: SiteItemKind | "unplaced"): string {
  const when = item.date ? item.date.text : "";
  if (kind === "assignment") return `- ${item.title}${when ? `: due ${when}` : ""}${item.points !== null ? `. ${item.points} points` : ""}`;
  if (kind === "schedule" || kind === "announcement") return `- ${when ? `${when}: ` : ""}${item.title}`;
  if (kind === "staff") return `- ${item.title}${item.detail && item.detail !== item.title ? `: ${item.detail}` : ""}`;
  if (kind === "unplaced") return `- ${item.title}`;
  return `- ${item.title}${when ? ` (${when})` : ""}`;
}

/** The page's address, title or first heading carries one of the course's numbers. */
function namesCourse(page: Resource, snap: { title: string; text: string }, numbers: string[]): boolean {
  const firstHeading = /^h[1-6] (.*)$/m.exec(snap.text)?.[1] ?? "";
  const where = `${decodeURIComponent(new URL(page.url).pathname)} ${snap.title} ${page.title} ${firstHeading}`;
  return numbers.some((n) => new RegExp(`(?<!\\d)${n}(?!\\d)`).test(where));
}

/**
 * Provenance names the layout and the recipe that organized the page (MIME parameters on the
 * page's type), so an unchanged page is recognized without parsing its HTML again.
 */
const recipeTag = (id: string, layoutHash: string) => `text/html; layout=${layoutHash}; recipe=${id}`;
function add(a: SitePageReport["tokens"], b: SitePageReport["tokens"]) {
  return { in: a.in + b.in, cached: a.cached + b.cached, out: a.out + b.out };
}
function chicagoOffset(iso: string): number {
  const at = Date.parse(iso);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(at / 1000) * 1000;
}
function toInput(r: Resource): ResourceInput {
  return resourceInputSchema.strip().parse(r);
}
function dedupe(resources: ResourceInput[]): ResourceInput[] {
  const seen = new Set<string>();
  return resources.filter((r) => (seen.has(r.externalId) ? false : (seen.add(r.externalId), true)));
}

export const SITE_RECIPE_JOB = "site.recipe";
/**
 * The job: a crawled course-site page saved or changed → organize that course's site pages.
 * Replays and unchanged pages cost nothing; only a new layout calls the student's AI.
 */
export function siteRecipeJob(deps: Omit<SiteRecipeDeps, "store">): JobHandler {
  // One pass per course crawl: a crawl saving N pages queues N jobs, and the first pass already
  // covers every page, so a job whose course's site pages are the same as the last pass's (ids
  // and content hashes) does nothing. The new-layout budget is then per sync, not per job.
  const lastPass = new Map<string, string>();
  return {
    kind: SITE_RECIPE_JOB,
    subject: "resource",
    owner: "site-recipes",
    ready: true,
    onSave: (r) => isSitePage(r),
    async run(job, { store, signal }) {
      const r = store.resource(job.resourceId);
      if (!r || r.deleted || r.contentHash !== job.inputHash || !isSitePage(r)) return { status: "done" };
      const source = store.sources().find((s) => s.id === r.sourceId);
      if (!source || source.kind !== "web" || source.scope !== "course_websites") return { status: "done" };
      if (!("extractionRecipe" in store)) return { status: "done" };
      const key = `${source.accountScope}:${r.courseId}`;
      const siteSources = new Set(
        store.sources().filter((s) => s.kind === "web" && s.scope === "course_websites" && s.accountScope === source.accountScope).map((s) => s.id),
      );
      const fingerprint = store
        .resources()
        .filter((p) => p.courseId === r.courseId && siteSources.has(p.sourceId) && isSitePage(p))
        .map((p) => `${p.id}@${p.contentHash}`)
        .sort()
        .join("|");
      if (lastPass.get(key) === fingerprint) return { status: "done" };
      lastPass.set(key, fingerprint);
      try {
        await createSiteRecipes({ ...deps, store: store as SiteStore }).ingestCourse({ accountScope: source.accountScope, courseId: r.courseId }, signal);
      } catch (error) {
        lastPass.delete(key); // a failed or aborted pass is retried in full
        throw error;
      }
      return { status: "done" };
    },
  };
}
