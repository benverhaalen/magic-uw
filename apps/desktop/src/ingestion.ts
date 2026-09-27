import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  resourceInputSchema,
  type Store,
  type CourseCoreStore,
  type CaptureBatch,
  type Resource,
  type ResourceInput,
} from "@magic/contracts";
import {
  canvasConnector,
  fetchCanvasActivitySummary,
} from "../../../packages/connectors/src/canvas";
import {
  fileSchema,
  pageSchema,
} from "../../../packages/connectors/src/canvas-models";
import {
  canvasFileId,
  referencedFileIds,
  urgentFileIds,
} from "../../../packages/connectors/src/canvas-references";
import {
  persistCourseSpaces,
  hydrateCourseSpaces,
} from "./course-space-storage";
import {
  createCanvasModuleRun,
  type CanvasModuleRun,
} from "../../../packages/connectors/src/canvas-modules";
import {
  CanvasFailure,
  CanvasHttp,
} from "../../../packages/connectors/src/canvas-http";
import {
  createFetchScheduler,
  DEFAULT_HOST_CONCURRENCY,
  type FetchScheduler,
} from "../../../packages/connectors/src/fetch-scheduler"; // owner: T17
import {
  calendarConnector,
  outlookCalendarConnector,
} from "../../../packages/connectors/src/calendar";
import { OUTLOOK_CALENDAR_COURSE_ID } from "@magic/contracts";
// owner: T30. Outlook, OneNote and OneDrive through Microsoft Graph (main holds the token).
import { mkdir, writeFile } from "node:fs/promises";
import {
  streamsFor,
  syncGraph,
  type DeltaState,
  type DriveExtraction,
  type GraphStream,
  type GraphSyncResult,
  type GraphTransport,
} from "../../../packages/connectors/src/graph";
import type { FeedValidators } from "../../../packages/connectors/src/network";
import { createLocalDocumentExtractor } from "../../../packages/connectors/src/documents";
// end owner: T30
import {
  externalCourseConnector,
  contentHash,
  cleanLink,
} from "../../../packages/connectors/src/external";
// owner: site-recipes. Host triage: only `sync` hosts are crawled; `read_once` on demand.
import { readOnceTargets, syncSeeds, type HostDecision } from "../../../packages/core/src/site-triage";
import {
  createPublicClient,
  type PublicClient,
} from "../../../packages/connectors/src/network";
import {
  createDocumentManager,
  type DocumentExtractor,
} from "../../../packages/connectors/src/documents";
import {
  gitlabConnector,
  gitlabProjectFromUrl,
  gitlabProjectsForCourse,
} from "../../../packages/connectors/src/gitlab";
import { courseInclusion } from "../../../packages/core/src/access";
import { createRefreshCoordinator } from "../../../packages/core/src/refresh";
// owner: T33. Per-course freshness probes (D37).
import {
  canvasCourseCode,
  fetchCanvasContentProbe,
  fetchCanvasHotProbe,
  type SelectableCanvasCourse,
} from "../../../packages/connectors/src/canvas-selection";
// end owner: T33
// fix/current-courses-only: the student's UW enrollment corroborates Canvas's current courses.
import type { PlanningCrosslist, PlanningSubject } from "../../../packages/contracts/src/planning";
import {
  buildCourseIdentityTable,
  canonicalizeCourseKey,
  resolveCourseIdentity,
} from "../../../packages/domain/src/planning";
import {
  linkExactEvidence,
  evidenceFor,
} from "../../../packages/core/src/evidence";
import { canvasContent } from "../../../packages/connectors/src/canvas-content";
// owner: T05b. D32 inventory and D41 access.
import {
  accessSummary,
  checkSpaceAccess,
  publicAccessTransport,
  readCanvasInventory,
  type AccessTransport,
  type CourseSpace,
  type SpaceAccess,
} from "../../../packages/connectors/src/canvas-inventory";
// end owner: T05b
// owner: acquisition. Course-file acquisition (RC1-RC4): session downloads, real causes, the
// extraction pool, cheap skips, text-first order and the first-sync budget.
import {
  canvasFileDownloadPath,
  throwIfCause,
} from "../../../packages/connectors/src/canvas-file-download";
import {
  causeDiagnostic,
  causeFromError,
  causeFromExtraction,
  documentTrialEvent,
  extractionKind,
  trialLogDocument,
  type DocumentHostClass,
} from "../../../packages/connectors/src/document-causes";
import { createExtractPool, type ExtractPool } from "../../../packages/connectors/src/extract-pool";
import { createOcrBackfill, detectOsOcrEngine } from "../../../packages/connectors/src/ocr-os";
import type { LocalOcrAdapter } from "../../../packages/connectors/src/documents";
import { rm } from "node:fs/promises";
import { MaterialReadError } from "../../../packages/connectors/src/network";
import { existsSync } from "node:fs";
/**
 * How course files are acquired. `ACQUISITION_APP` is what the desktop host (worker.ts) uses:
 * main's session file route and the extraction threads exist only there. A host without them
 * (tests, tools) gets `ACQUISITION_DEFAULTS`. `ACQUISITION_BEFORE` is the earlier behaviour, kept
 * for the perf comparison (evals/perf, suite "documents").
 */
export interface AcquisitionOptions {
  /** "session": main follows the redirect chain in the Canvas session; "signed": the public client. */
  download: "session" | "signed";
  /** Extraction in a worker_threads pool, off the utility loop. */
  pool: boolean;
  /** Within each urgency tier, small and text files before large PDFs. */
  textFirst: boolean;
  /** Skip a list row whose updated_at and size match the stored document, before any request. */
  skipUnchanged: boolean;
  /** The first sync of an account (no stored course document yet) gets a larger budget. */
  firstSync?: { files: number; ms: number };
  /** Steady-state caps: files attempted and wall time per sync. */
  steady: { files: number; ms: number };
  /** Document loops in flight; downloads are also capped by the shared scheduler (6 per host). */
  loops?: number;
  /** "ocr-pending": raw bytes are deleted once text is extracted (kept only while OCR is due). */
  retainBytes?: "all" | "ocr-pending";
  /** Background OCR of `needs_ocr` documents with the OS engine; pages per run. 0 turns it off. */
  ocrPagesPerRun?: number;
}
export const ACQUISITION_DEFAULTS: AcquisitionOptions = {
  download: "signed",
  pool: false,
  textFirst: true,
  skipUnchanged: true,
  steady: { files: 100, ms: 120_000 },
};
export const ACQUISITION_APP: AcquisitionOptions = {
  download: "session",
  pool: true,
  textFirst: true,
  skipUnchanged: true,
  firstSync: { files: 400, ms: 300_000 },
  steady: { files: 100, ms: 120_000 },
  loops: 9,
  retainBytes: "ocr-pending",
  ocrPagesPerRun: 30,
};
export const ACQUISITION_BEFORE: AcquisitionOptions = {
  download: "signed",
  pool: false,
  textFirst: false,
  skipUnchanged: false,
  steady: { files: 100, ms: 120_000 },
};
/** Text and Office first, then unknown, then PDF, then images; by size within each. */
function documentWeight(file: Resource | undefined): number {
  const name = file?.file?.displayName ?? file?.title ?? "",
    type = file?.file?.contentType ?? "",
    kind = extractionKind(name, type),
    size = file?.file?.size ?? 5 * 1024 * 1024;
  const tier = !file ? 1 : kind === "pdf" ? 2 : kind === "image" ? 3 : 0;
  return tier * 1e9 + Math.min(size, 1e9 - 1);
}
// end owner: acquisition

export interface IngestionHost {
  canvasFetch(url: string, init?: RequestInit): Promise<Response>;
  gitlabFetch?(url: string, init?: RequestInit): Promise<Response>;
  secrets(
    operation: "list" | "set",
    key?: string,
    value?: string,
  ): Promise<Record<string, string> | void>;
  directory: string;
  client?: PublicClient;
  now?: () => Date;
  extractor?: DocumentExtractor;
  /** owner: T05b. The save → enqueue hook; core enqueues the registered jobs for this source. */
  onSaved?(sourceId: string): void;
  /** owner: T05b. D41's session check: main's `source-fetch` service "space" (GET, no redirects). */
  spaceFetch?(url: string, init?: RequestInit): Promise<Response>;
  /**
   * owner: site-recipes. Host triage from Canvas evidence (no fetch): the crawler reads only hosts
   * decided `sync`. Absent (tests, older hosts), every seed is crawled as before.
   */
  triage?(accountScope: string, courseId: string, signal?: AbortSignal): Promise<Map<string, { decision: HostDecision }>>;
  /**
   * owner: site-recipes. The stored triage decisions (no rule re-run, no model call). Opening an
   * item reads its `read_once` links by these, so an open never costs a triage call. Absent,
   * `triage` decides.
   */
  triageDecisions?(accountScope: string, courseId: string): Map<string, { decision: HostDecision }>;
  /** owner: T05b. A course's inventory with access states; the data builder stores it in course_spaces. */
  onSpaces?(accountScope: string, courseId: string, spaces: CourseSpace[]): void;
  /** owner: acquisition. Overrides of ACQUISITION_DEFAULTS (tests and the perf comparison). */
  acquisition?: Partial<AcquisitionOptions>;
  /** owner: acquisition. The built extract-worker.cjs; without it extraction stays in-process. */
  extractWorkerScript?: string;
  /** owner: acquisition. The configured Tesseract adapter, the OCR fallback. */
  ocr?: LocalOcrAdapter;
  /**
   * owner: T30. Microsoft Graph through main: `transport` is main's proxy (the token never
   * reaches the worker), `state` the vault's delta links, `scopes` what the student granted.
   */
  graph?: {
    transport: GraphTransport;
    state: DeltaState;
    scopes(): string[];
    onSynced?(result: Pick<GraphSyncResult, "requests" | "changed" | "failures"> & { at: string }): void;
  };
}
export function inputResource(resource: Resource): ResourceInput {
  return resourceInputSchema.parse(
    Object.fromEntries(
      Object.keys(resourceInputSchema.shape)
        .filter((key) => key in resource)
        .map((key) => [
          key,
          (resource as unknown as Record<string, unknown>)[key],
        ]),
    ),
  );
}
/** One owner schedules reads; only the main process can attach the app-owned UW session. */
export function createIngestion(
  store: Store & CourseCoreStore,
  host: IngestionHost,
) {
  const now = host.now ?? (() => new Date()),
    origin = "https://canvas.wisc.edu";
  const client = host.client ?? createPublicClient();
  let activeStart = 0,
    firstValueMs: number | undefined,
    nextWeekInstructionsMs: number | undefined;
  let rateLimitRemaining: number | undefined, requestCost: number | undefined;
  let probeRequests = 0; // owner: T33: requests made by the hot tick and the content probe
  const sourceIds = new Set<string>();
  let moduleRun: CanvasModuleRun | undefined;
  function hasIncompleteRead() {
    const included = courseInclusion(store);
    return store.sources().some(
      (source) =>
        sourceIds.has(source.id) &&
        source.status !== "ok" &&
        included({
          sourceId: source.id,
          courseId: source.courseId,
        } as Resource),
    );
  }
  const observedPages = new Set<string>();
  let reconnecting = false;
  function save(batch: CaptureBatch) {
    if (reconnecting) return;
    const previous = store.sources().find((s) => s.id === batch.source.id);
    if (previous && batch.observedAt <= previous.lastAttemptAt)
      batch = {
        ...batch,
        observedAt: new Date(
          Date.parse(previous.lastAttemptAt) + 1,
        ).toISOString(),
      };
    store.ingest(batch);
    if (
      batch.source.kind === "canvas" &&
      batch.status === "ok" &&
      (batch.source.scope?.startsWith("page:") ||
        batch.source.scope?.startsWith("linked-page:")) &&
      !batch.diagnostics?.some((d) => d.code === "unchanged_page_reused")
    ) {
      for (const resource of batch.resources)
        if (resource.rawHtml !== undefined)
          observedPages.add(`${batch.source.accountScope}:${resource.url}`);
    }
    host.onSaved?.(batch.source.id); // owner: T05b
    sourceIds.add(batch.source.id);
    rateLimitRemaining = batch.stats?.rateLimitRemaining ?? rateLimitRemaining;
    requestCost = batch.stats?.requestCost ?? requestCost;
    if (
      firstValueMs === undefined &&
      batch.resources.some((r) => r.kind === "assignment" || r.kind === "event")
    )
      firstValueMs = Math.max(0, performance.now() - activeStart);
  }
  function courses() {
    const included = courseInclusion(store),
      sources = new Map(store.sources().map((s) => [s.id, s]));
    return store
      .resources()
      .filter(
        (r) =>
          r.kind === "course" &&
          r.course &&
          sources.get(r.sourceId)?.scope === "course" &&
          included(r),
      )
      .map((resource) => ({
        resource,
        source: sources.get(resource.sourceId)!,
      }));
  }
  async function feeds(signal: AbortSignal) {
    let changed = false;
    const secrets = (await host.secrets("list")) ?? {};
    for (const { resource, source } of courses()) {
      signal.throwIfAborted();
      const key = `calendar:${source.accountScope}:${resource.courseId}`,
        feedUrl = secrets[key];
      if (!feedUrl) continue;
      const before = store
        .resources()
        .filter((r) => r.calendar && r.courseId === resource.courseId)
        .map((r) => r.contentHash)
        .sort()
        .join(":");
      for await (const batch of calendarConnector({
        feedUrl,
        canvasOrigin: origin,
        accountScope: source.accountScope,
        courseId: resource.courseId,
        courseName: resource.courseName,
        client,
        now,
      }).pull(signal))
        save(batch);
      const after = store
        .resources()
        .filter((r) => r.calendar && r.courseId === resource.courseId)
        .map((r) => r.contentHash)
        .sort()
        .join(":");
      changed ||= before !== after;
    }
    // The student's published Outlook calendar, if they connected one.
    const outlookHashes = () =>
      store
        .resources()
        .filter((r) => r.courseId === OUTLOOK_CALENDAR_COURSE_ID && !r.deleted)
        .map((r) => r.contentHash)
        .sort()
        .join(":");
    const outlookBefore = outlookHashes();
    const outlookUrl = secrets["calendar:outlook"];
    const outlook = outlookCalendarConnector({
      feedUrl: outlookUrl ?? "",
      accountScope: "local",
      client,
      now,
      // owner: T30: If-None-Match / If-Modified-Since; a 304 is no work.
      validators: {
        get: () => (outlookUrl ? icsValidators.get(outlookUrl) : undefined),
        set: (value) => {
          if (outlookUrl) icsValidators.set(outlookUrl, value);
        },
      },
    });
    // owner: T30: the Microsoft calendar, when connected, replaces the published link's read.
    if (outlookUrl && graphCalendarConnected()) {
      // The Graph calendar is fresher and carries the same meetings: the ICS copy would show
      // them twice. The link stays in the vault as the fallback; no request is made.
      if (store.sources().some((s) => s.id === outlook.id)) store.removeSource(outlook.id);
    } else if (outlookUrl) {
      for await (const batch of outlook.pull(signal)) save(batch);
    } else if (store.sources().some((s) => s.id === outlook.id)) {
      // Disconnected by the student: delete the meetings outright. An empty "read" would be
      // treated as a suspicious drop by the drift guard and keep them on screen.
      store.removeSource(outlook.id);
    }
    changed ||= outlookBefore !== outlookHashes();
    return { changed };
  }
  // owner: T30. Graph: the ICS fallback's validators, the calendar check, and the sync step.
  const icsValidators = new Map<string, FeedValidators>();
  function graphCalendarConnected(): boolean {
    if (!host.graph || !streamsFor(host.graph.scopes()).includes("calendar")) return false;
    return store
      .sources()
      .some((s) => s.scope === "graph_calendar" && (s.status === "ok" || s.status === "partial"));
  }
  let onenoteAt = 0;
  async function graph(signal: AbortSignal, trigger: "manual" | "background") {
    if (!host.graph) return;
    const granted = streamsFor(host.graph.scopes());
    if (!granted.length) return;
    // Mail, calendar and OneDrive ride every run (a delta with nothing new is one request each);
    // OneNote has no delta, so its page list is read at most hourly unless asked.
    const streams: GraphStream[] = granted.filter(
      (s) => s !== "onenote" || trigger === "manual" || now().getTime() - onenoteAt >= 60 * 60_000,
    );
    if (streams.includes("onenote")) onenoteAt = now().getTime();
    const included = courseInclusion(store);
    const directory = courses()
      .filter(({ resource }) => included(resource))
      .map(({ resource, source }) => ({
        courseId: resource.courseId,
        accountScope: source.accountScope,
        courseName: resource.courseName,
        ...(resource.course?.courseCode ? { courseCode: resource.course.courseCode } : {}),
      }));
    // Local only: the advisor's name from planning, compared in code here and never stored.
    const advisorNames = (store.planningRecords?.() ?? [])
      .flatMap((r) => (r.kind === "advisor" && !r.deleted ? [r.displayName] : []));
    const result = await syncGraph({
      transport: host.graph.transport,
      state: host.graph.state,
      accountScope: "local",
      previous: (sourceId) =>
        store
          .resources()
          .filter((r) => r.sourceId === sourceId && !r.deleted)
          .map(inputResource),
      context: { courses: directory, advisorNames, canvasOrigin: origin },
      streams,
      now,
      signal,
      extract: (file) => extractDriveFile(file),
    });
    // Reconnect can cancel while the final Graph response is resolving. Never advance
    // its cursor for batches that the cancelled generation cannot save.
    signal.throwIfAborted();
    for (const batch of result.batches) save(batch);
    await result.commit();
    host.graph.onSynced?.({
      at: now().toISOString(),
      requests: result.requests,
      changed: result.changed,
      failures: result.failures,
    });
  }
  async function extractDriveFile(file: {
    itemId: string;
    name: string;
    mimeType: string;
    bytes: Buffer;
    signal?: AbortSignal;
  }): Promise<DriveExtraction | undefined> {
    const folder = join(host.directory, "documents", "onedrive");
    await mkdir(folder, { recursive: true });
    const extension = (file.name.match(/.[A-Za-z0-9]{1,8}$/)?.[0] ?? "").toLowerCase();
    const path = join(folder, `${createHash("sha256").update(file.itemId).digest("hex").slice(0, 32)}${extension}`);
    await writeFile(path, file.bytes, { mode: 0o600 });
    const extracted = await (host.extractor ?? createLocalDocumentExtractor()).extract(path, {
      contentType: file.mimeType,
      filename: file.name,
      ...(file.signal ? { signal: file.signal } : {}),
    });
    return {
      text: extracted.text,
      parts: extracted.parts,
      document: {
        localPath: path,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        sizeBytes: file.bytes.length,
        extractionStatus: extracted.status,
        pages: extracted.pages,
      },
    };
  }
  // end owner: T30
  // Resumable from persisted resource links and per-file source attempts, without a second job system.
  const attemptedFiles = new Set<string>();
  // owner: acquisition
  const acquisition: AcquisitionOptions = { ...ACQUISITION_DEFAULTS, ...host.acquisition };
  let fileBudgetMs = acquisition.steady.ms,
    fileBudgetFiles = acquisition.steady.files,
    budgetChosen = false;
  let lastDocumentRun = { skipped: 0, attempted: 0, deferred: 0 };
  let extractPool: ExtractPool | undefined;
  function documentExtractor(): DocumentExtractor | undefined {
    if (!acquisition.pool) return host.extractor;
    const script =
      host.extractWorkerScript ??
      (typeof __dirname === "string" ? join(__dirname, "extract-worker.cjs") : undefined);
    return (extractPool ??= createExtractPool({
      ...(script && existsSync(script) ? { workerScript: script } : {}),
      ...(host.extractor ? { fallback: host.extractor } : {}),
    }));
  }
  // Background OCR of text-less documents (ocr-os.ts): presence-gated by the engine probe,
  // bounded per run, one run at a time, and a version check before its result is saved.
  const ocr = createOcrBackfill({
    engine: () => detectOsOcrEngine(),
    ...(host.ocr ? { tesseract: host.ocr } : {}),
    maxPagesPerRun: acquisition.ocrPagesPerRun ?? 0,
    candidates: () =>
      store
        .resources()
        .filter(
          (r) =>
            !r.deleted &&
            r.document?.extractionStatus === "needs_ocr" &&
            r.document.localPath &&
            existsSync(r.document.localPath),
        )
        .map((r) => ({
          key: `${r.id}|${r.contentHash}`,
          localPath: r.document!.localPath!,
          filename: r.file?.displayName ?? r.title,
          ...(r.file?.contentType ? { contentType: r.file.contentType } : {}),
          pages: r.document!.pages ?? [],
        })),
    save(candidate, result) {
      const cut = candidate.key.lastIndexOf("|"),
        id = candidate.key.slice(0, cut),
        version = candidate.key.slice(cut + 1);
      const current = store.resource(id);
      const source = current && store.sources().find((s) => s.id === current.sourceId);
      if (!current || !source || current.deleted || current.contentHash !== version) return;
      const { id: sourceId, label, kind, accountScope, courseId, scope } = source;
      if (result.status === "ok" && retainOcrBytes() === "ocr-pending")
        void rm(candidate.localPath, { force: true }).catch(() => {});
      save({
        source: { id: sourceId, label, kind, accountScope, courseId, scope },
        observedAt: now().toISOString(),
        complete: true,
        status: "ok",
        resources: [
          {
            ...inputResource(current),
            text: result.text,
            parts: result.parts,
            document: {
              ...current.document!,
              ...(result.status === "ok" && retainOcrBytes() === "ocr-pending" ? { localPath: undefined } : {}),
              extractionStatus: result.status,
              pages: result.pages,
            },
          },
        ],
        diagnostics: result.status === "ok" ? [] : [causeDiagnostic({ cause: "needs_ocr" })],
      });
      trialLogDocument({
        event: "document",
        hostClass: "cache",
        status: result.status,
        cause: result.status === "ok" ? `ocr.${result.engine ?? "none"}` : "needs_ocr",
      });
    },
  });
  const retainOcrBytes = () => acquisition.retainBytes ?? "all";
  function startOcr() {
    if (!acquisition.ocrPagesPerRun || ocr.running) return;
    void ocr.run().catch(() => {});
  }
  // end owner: acquisition
  async function documents(signal: AbortSignal, only?: Set<string>, skipCourses?: Set<string>) {
    const settings = store.ingestionSettings();
    const manager = createDocumentManager({
      directory: join(host.directory, "documents"),
      client,
      // owner: acquisition: the manager's slots cover download and extraction; the scheduler and
      // the pool bound each separately.
      downloadConcurrency: acquisition.pool ? 8 : settings.downloadConcurrency,
      maxBytes: settings.maxFileBytes,
      extractor: documentExtractor(),
      retainBytes: acquisition.retainBytes ?? "all",
    });
    const http = new CanvasHttp({
      fetch: host.canvasFetch,
      metadataConcurrency: settings.metadataConcurrency,
      scheduler: scheduler(), // owner: T17
    });
    const sources = new Map(store.sources().map((s) => [s.id, s]));
    const included = courseInclusion(store);
    const all = store.resources().filter((r) => !r.deleted && included(r));
    type Job = {
      id: string;
      course: Resource;
      account: string;
      source: CaptureBatch["source"];
      priorFile?: Resource;
      urgent: boolean;
      syllabus?: boolean; // owner: acquisition
      last: string;
    };
    const jobs: Job[] = [];
    // owner: acquisition: the earlier documents, indexed once per run (was a scan per file).
    const priorDocuments = new Map<string, Resource>(),
      listRows = new Map<string, Resource>();
    for (const r of all) {
      const account = sources.get(r.sourceId)?.accountScope;
      if (r.document?.fileId) priorDocuments.set(`${account}:${r.courseId}:${r.document.fileId}`, r);
      if (r.file?.id && !r.document) listRows.set(`${account}:${r.courseId}:${r.file.id}`, r);
    }
    let skipped = 0;
    if (!budgetChosen) {
      // The first sync of an account (no course document stored yet) gets the larger budget.
      budgetChosen = true;
      if (acquisition.firstSync && !all.some((r) => r.document?.fileId)) {
        fileBudgetMs = acquisition.firstSync.ms;
        fileBudgetFiles = acquisition.firstSync.files;
      }
    }
    // end owner: acquisition
    for (const { resource: course, source } of courses()) {
      if (only && !only.has(course.courseId)) continue;
      if (skipCourses?.has(course.courseId)) continue; // owner: acquisition (RC4)
      const rows = all.filter(
        (r) =>
          r.courseId === course.courseId &&
          sources.get(r.sourceId)?.accountScope === source.accountScope,
      );
      const urgent = urgentFileIds(rows, origin, now().getTime());
      const ids = new Set(rows.flatMap((r) => referencedFileIds(r, origin)));
      // owner: acquisition: syllabus files first (team packet backend/12): a file named or linked
      // as the syllabus, or linked from the Canvas syllabus body, is urgent, ahead of due-soon.
      const syllabusIds = new Set<string>();
      for (const r of rows) {
        if (/\/assignments\/syllabus$/.test(r.url) || /syllabus/i.test(r.title))
          for (const id of referencedFileIds(r, origin)) syllabusIds.add(id);
        for (const link of r.links ?? [])
          if (typeof link !== "string" && /syllabus/i.test(`${link.text ?? ""} ${link.url}`)) {
            const id = canvasFileId(link.url, origin, course.courseId);
            if (id) syllabusIds.add(id);
          }
      }
      for (const id of ids) {
        const key = `${source.accountScope}:${course.courseId}:${id}`;
        if (attemptedFiles.has(key)) continue;
        // owner: acquisition: an unchanged list row (same updated_at and size as the stored
        // document, whose file is still on disk) needs no metadata request and no download.
        const listed = listRows.get(key),
          stored = priorDocuments.get(key)?.document;
        if (
          acquisition.skipUnchanged &&
          listed?.file?.updatedAt &&
          listed.file.size !== undefined &&
          stored?.updatedAt === listed.file.updatedAt &&
          stored.sizeBytes === listed.file.size &&
          (stored.extractionStatus === "ok" ||
            stored.extractionStatus === "unsupported" ||
            (stored.extractionStatus !== "error" && !!stored.localPath && existsSync(stored.localPath)))
        ) {
          skipped++;
          continue;
        }
        const scope = `file:${id}`;
        const fileSource = {
          id: `canvas:${source.accountScope}:${course.courseId}:${scope}`,
          label: `${course.courseName} · linked file ${id}`.slice(0, 200),
          kind: "canvas" as const,
          accountScope: source.accountScope,
          courseId: course.courseId,
          scope,
        };
        jobs.push({
          id,
          course,
          account: source.accountScope,
          source: fileSource,
          urgent: urgent.has(id) || syllabusIds.has(id),
          syllabus: syllabusIds.has(id) || /syllabus/i.test(listRows.get(key)?.file?.displayName ?? ""),
          priorFile: listRows.get(key), // owner: acquisition: indexed once
          last: sources
            .get(fileSource.id)
            ?.diagnostics?.some((d) => d.code === "file_budget_deferred")
            ? ""
            : (sources.get(fileSource.id)?.lastAttemptAt ?? ""),
        });
      }
    }
    // Interleave urgency with oldest checks so undated material cannot starve.
    jobs.sort(
      (a, b) =>
        a.last.localeCompare(b.last) ||
        // owner: acquisition: small and text files before large PDFs within a tier.
        (acquisition.textFirst ? documentWeight(a.priorFile) - documentWeight(b.priorFile) : 0) ||
        a.source.id.localeCompare(b.source.id),
    );
    const urgent = [
        ...jobs.filter((j) => j.syllabus), // owner: acquisition: syllabus ahead of due-soon
        ...jobs.filter((j) => j.urgent && !j.syllabus),
      ],
      rest = jobs.filter((j) => !j.urgent && !j.syllabus),
      ordered: Job[] = [];
    while (urgent.length || rest.length) {
      ordered.push(...urgent.splice(0, 3), ...rest.splice(0, 1));
      if (!urgent.length) ordered.push(...rest.splice(0));
    }
    const started = performance.now();
    let index = 0;
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            acquisition.loops ?? settings.downloadConcurrency,
            ordered.length,
          ),
        },
        async () => {
          while (
            index < ordered.length &&
            attemptedFiles.size < fileBudgetFiles &&
            performance.now() - started < fileBudgetMs &&
            !http.needsSignIn
          ) {
            const job = ordered[index++]!;
            const fileStarted = performance.now(); // owner: acquisition
            let hostClass: DocumentHostClass = "unknown";
            const key = `${job.account}:${job.course.courseId}:${job.id}`;
            attemptedFiles.add(key);
            const documentSource = {
              id: `documents:${job.account}:${job.course.courseId}:${job.id}`,
              label: `${job.course.courseName} · document ${job.id}`.slice(
                0,
                200,
              ),
              kind: "canvas" as const,
              accountScope: job.account,
              courseId: job.course.courseId,
              scope: `document:${job.id}`,
            };
            const prior = priorDocuments.get(`${job.account}:${job.course.courseId}:${job.id}`); // owner: acquisition
            const stillIncluded = () =>
              store
                .sources()
                .some(
                  (s) =>
                    s.accountScope === job.account &&
                    s.courseId === job.course.courseId &&
                    s.scope === "course",
                ) && courseInclusion(store)(job.course);
            try {
              signal.throwIfAborted();
              const response = await http.request(
                `${origin}/api/v1/files/${job.id}`,
                signal,
                undefined,
                0,
                { fresh: true },
              );
              const raw = response.data as Record<string, unknown>;
              const metadata = fileSchema.safeParse(raw);
              if (
                !metadata.success ||
                metadata.data.id !== job.id ||
                (raw.context_type === "Course" &&
                  String(raw.context_id) !== job.course.courseId) ||
                (raw.course_id !== undefined &&
                  String(raw.course_id) !== job.course.courseId)
              )
                throw new Error("file_metadata_invalid");
              if (!stillIncluded()) continue;
              const value = metadata.data;
              const file = resourceInputSchema.parse({
                externalId: job.id,
                kind: "material",
                courseId: job.course.courseId,
                courseName: job.course.courseName,
                title: value.display_name,
                text: "",
                url: `${origin}/courses/${job.course.courseId}/files/${job.id}`,
                updatedAt: value.updated_at,
                file: {
                  id: job.id,
                  folderId: value.folder_id,
                  displayName: value.display_name,
                  contentType: value["content-type"],
                  size: value.size,
                  updatedAt: value.updated_at,
                  locked: value.locked_for_user ?? value.locked,
                  hidden: value.hidden,
                },
              });
              save({
                source: job.source,
                observedAt: now().toISOString(),
                complete: true,
                status: "ok",
                resources: [file],
              });
              if (file.file?.locked)
                throw new CanvasFailure("inaccessible", "file_locked");
              // owner: acquisition: reference-only (docs/pipeline-details.md, storage policy): video
              // and audio, and files over the size cap, keep their metadata and link; no download.
              const referenceOnly =
                /^(?:video|audio)\//i.test(value["content-type"] ?? "")
                  ? ("reference_only" as const)
                  : (value.size ?? 0) > settings.maxFileBytes
                    ? ("too_large" as const)
                    : undefined;
              if (referenceOnly) {
                trialLogDocument(
                  documentTrialEvent({ cause: referenceOnly }, { hostClass: "unknown", status: "skipped", ms: performance.now() - fileStarted }),
                );
                save({
                  source: documentSource,
                  observedAt: now().toISOString(),
                  complete: true,
                  status: "ok",
                  resources: [file],
                  diagnostics: [causeDiagnostic({ cause: referenceOnly })],
                });
                continue;
              }
              if (typeof raw.url !== "string")
                throw new MaterialReadError("file_metadata_invalid");
              // owner: acquisition. "session": main fetches /courses/:cid/files/:id/download in
              // the Canvas session and follows the redirects itself (canvas-file-download.ts).
              // "signed": the earlier public-client download of the API's URL.
              const download = new URL(raw.url);
              const sessionUrl = canvasFileDownloadPath(origin, job.course.courseId, job.id);
              if (
                acquisition.download === "signed" &&
                (download.protocol !== "https:" ||
                  download.username ||
                  download.password ||
                  !(
                    download.origin === origin ||
                    download.hostname.endsWith(".canvas-user-content.com") ||
                    download.hostname === "instructure-uploads.s3.amazonaws.com"
                  ))
              )
                throw new MaterialReadError("download_host_unverified", { host: download.hostname });
              // end owner: acquisition
              const current = store
                .resources()
                .find(
                  (r) =>
                    r.sourceId === job.source.id && r.externalId === job.id,
                )!;
              const version = current.contentHash;
              const extracted = await manager.capture({
                id: job.id,
                sourceUrl: file.url,
                ...(acquisition.download === "session"
                  ? {
                      // owner: acquisition: through the shared scheduler, not the 2-per-host cap.
                      download: async () => {
                        const response = await scheduler().run(
                          origin,
                          () => host.canvasFetch(sessionUrl, { signal }),
                          { priority: job.urgent ? 0 : 1, signal },
                        );
                        throwIfCause(response);
                        hostClass =
                          (response.headers.get("x-magic-host-class") as DocumentHostClass | null) ??
                          "canvas";
                        return { response, url: sessionUrl, redirects: [] };
                      },
                    }
                  : {
                      downloadUrl: download.href,
                      allowedDownloadOrigins: [
                        origin,
                        download.origin,
                        "https://instructure-uploads.s3.amazonaws.com",
                      ],
                    }),
                filename: value.filename ?? value.display_name,
                contentType: value["content-type"],
                updatedAt: value.updated_at,
                previous: prior?.document,
                cached:
                  prior?.text && prior.document?.extractionStatus === "ok"
                    ? {
                        text: prior.text,
                        parts: prior.parts ?? [],
                        pages: prior.document.pages ?? [],
                        status: "ok",
                      }
                    : undefined,
                dueSoon: job.urgent,
                signal,
              });
              signal.throwIfAborted();
              if (
                !stillIncluded() ||
                !store
                  .resources()
                  .some(
                    (r) =>
                      r.id === current.id &&
                      !r.deleted &&
                      r.contentHash === version,
                  )
              )
                continue;
              // owner: acquisition: the real cause; a text-less PDF is a complete read whose
              // document is `needs_ocr` (its own status), not a source left partial forever.
              const outcome = causeFromExtraction(
                extracted,
                extractionKind(value.filename ?? value.display_name, value["content-type"]),
              );
              const readComplete = extracted.status === "ok" || outcome.cause === "needs_ocr";
              trialLogDocument(
                documentTrialEvent(outcome, {
                  hostClass: extracted.skipped ? "cache" : hostClass,
                  status: extracted.status,
                  bytes: extracted.document.sizeBytes,
                  ms: performance.now() - fileStarted,
                }),
              );
              // Save the current extraction state even if empty: old text cannot masquerade as the new version.
              save({
                source: documentSource,
                observedAt: now().toISOString(),
                complete: readComplete,
                status: readComplete ? "ok" : "partial",
                resources: [
                  {
                    ...file,
                    text: extracted.text,
                    parts: extracted.parts,
                    document: extracted.document,
                  },
                ],
                diagnostics: [
                  ...(outcome.cause === "ok" ? [] : [causeDiagnostic(outcome)]),
                  ...extracted.diagnostics
                    .filter((code) => /^[a-z0-9_.-]{1,100}$/i.test(code))
                    .map((code) => ({ code, path: [], severity: "warning" as const })),
                ],
              });
            } catch (error) {
              signal.throwIfAborted();
              if (!stillIncluded()) continue;
              // owner: acquisition (RC3): the real cause, host only, in place of the catch-all.
              const outcome = http.needsSignIn ? { cause: "needs_sign_in" as const } : causeFromError(error);
              trialLogDocument(
                documentTrialEvent(outcome, {
                  hostClass,
                  status: "failed",
                  ms: performance.now() - fileStarted,
                }),
              );
              const status = http.needsSignIn
                ? "needs_sign_in"
                : error instanceof CanvasFailure &&
                    error.status === "inaccessible"
                  ? "inaccessible"
                  : "partial";
              for (const source of [job.source, documentSource])
                save({
                  source,
                  observedAt: now().toISOString(),
                  complete: false,
                  status,
                  resources: [],
                  diagnostics: [causeDiagnostic(outcome)], // owner: acquisition
                });
            }
          }
        },
      ),
    );
    fileBudgetMs = Math.max(0, fileBudgetMs - (performance.now() - started));
    lastDocumentRun = { skipped, attempted: index, deferred: Math.max(0, ordered.length - index) }; // owner: acquisition
    if (index < ordered.length) {
      for (const job of ordered.slice(index))
        save({
          source: job.source,
          observedAt: now().toISOString(),
          complete: false,
          status: "partial",
          resources: [],
          diagnostics: [
            { code: "file_budget_deferred", path: [], severity: "warning" },
          ],
        });
    }
    if (http.needsSignIn) markExpired();
    return http.needsSignIn;
  }
  async function revalidatePages(signal: AbortSignal) {
    const sources = new Map(store.sources().map((s) => [s.id, s]));
    const included = courseInclusion(store),
      all = store.resources().filter((r) => !r.deleted && included(r));
    type PageJob = {
      url: string;
      parent: Resource;
      prior?: Resource;
      source: CaptureBatch["source"];
      depth: number;
    };
    const queue: PageJob[] = [],
      queued = new Set<string>();
    function enqueue(url: string, parent: Resource, depth: number) {
      const match =
        /^https:\/\/canvas\.wisc\.edu\/courses\/(\d+)\/pages\/([a-zA-Z0-9_%.-]+)$/.exec(
          url,
        );
      const parentSource = sources.get(parent.sourceId);
      if (
        !match ||
        match[1] !== parent.courseId ||
        !parentSource ||
        depth > 3 ||
        queued.size >= 2000
      )
        return;
      const key = `${parentSource.accountScope}:${url}`;
      if (queued.has(key) || observedPages.has(key)) return;
      queued.add(key);
      const prior = all.find(
        (r) =>
          r.url === url &&
          r.rawHtml !== undefined &&
          sources.get(r.sourceId)?.accountScope === parentSource.accountScope,
      );
      const oldSource = prior && sources.get(prior.sourceId);
      const scope = `linked-page:${contentHash(url)}`;
      const source = oldSource
        ? {
            id: oldSource.id,
            label: oldSource.label,
            kind: oldSource.kind,
            accountScope: oldSource.accountScope,
            courseId: oldSource.courseId,
            scope: oldSource.scope,
          }
        : {
            id: `canvas:${parentSource.accountScope}:${parent.courseId}:${scope}`,
            label: `${parent.courseName} · linked page`.slice(0, 200),
            kind: "canvas" as const,
            accountScope: parentSource.accountScope,
            courseId: parent.courseId,
            scope,
          };
      queue.push({ url, parent, prior, source, depth });
    }
    for (const row of all) {
      if (row.rawHtml !== undefined) enqueue(row.url, row, 0);
      for (const link of row.links ?? [])
        enqueue(typeof link === "string" ? link : link.url, row, 0);
    }
    queue.sort((a, b) =>
      (sources.get(a.source.id)?.lastAttemptAt ?? "").localeCompare(
        sources.get(b.source.id)?.lastAttemptAt ?? "",
      ),
    );
    const http = new CanvasHttp({
      fetch: host.canvasFetch,
      metadataConcurrency: store.ingestionSettings().metadataConcurrency,
      scheduler: scheduler(),
    });
    const started = performance.now();
    for (
      let index = 0;
      index < queue.length &&
      index < 20 &&
      performance.now() - started < 60000 &&
      !http.needsSignIn;
      index++
    ) {
      const job = queue[index]!,
        { source, prior } = job;
      try {
        const path = new URL(job.url).pathname;
        const response = await http.request(
          `${origin}/api/v1${path}`,
          signal,
          undefined,
          1,
          { fresh: true },
        );
        const page = pageSchema.parse(response.data);
        if (page.body == null) throw new Error("missing_page_body");
        if (`/courses/${source.courseId}/pages/${page.url}` !== path)
          throw new Error("page_identity_mismatch");
        signal.throwIfAborted();
        if (
          !store
            .sources()
            .some(
              (s) =>
                s.accountScope === source.accountScope &&
                s.courseId === source.courseId &&
                s.scope === "course",
            ) ||
          !courseInclusion(store)(job.parent)
        )
          continue;
        if (
          prior &&
          !store
            .resources()
            .some(
              (r) =>
                r.id === prior.id &&
                !r.deleted &&
                r.contentHash === prior.contentHash,
            )
        )
          continue;
        const input = resourceInputSchema.parse({
          ...(prior ? inputResource(prior) : {}),
          externalId: prior?.externalId ?? page.page_id,
          kind: "material",
          courseId: source.courseId,
          courseName: job.parent.courseName,
          url: job.url,
          title: page.title,
          updatedAt: page.updated_at,
          ...canvasContent(page.body, job.url),
        });
        save({
          source,
          observedAt: now().toISOString(),
          complete: true,
          status: "ok",
          resources: [input],
        });
        // Retain parent account context while extending the bounded frontier.
        for (const link of input.links ?? [])
          enqueue(
            typeof link === "string" ? link : link.url,
            job.parent,
            job.depth + 1,
          );
      } catch (error) {
        signal.throwIfAborted();
        if (
          !store
            .sources()
            .some(
              (s) =>
                s.accountScope === source.accountScope &&
                s.courseId === source.courseId &&
                s.scope === "course",
            )
        )
          continue;
        save({
          source,
          observedAt: now().toISOString(),
          complete: false,
          status: http.needsSignIn
            ? "needs_sign_in"
            : error instanceof CanvasFailure && error.status === "inaccessible"
              ? "inaccessible"
              : "partial",
          resources: [],
        });
      }
    }
    if (http.needsSignIn) markExpired();
    return http.needsSignIn;
  }
  /**
   * owner: site-recipes. A `read_once` link, read when the student opens the item that links it:
   * at most five pages, GET only, robots and the public client's checks as in a sync, depth 0.
   * Pages already read stay as they are ("once"); they land in their own `linked_pages` source,
   * never in the crawler's, so a sync never re-reads or deletes them.
   */
  async function readLinked(resourceId: string, signal?: AbortSignal): Promise<{ read: number }> {
    const item = store.resource(resourceId);
    const sources = new Map(store.sources().map((s) => [s.id, s]));
    const source = item && sources.get(item.sourceId);
    if (!item || item.deleted || !source || source.kind !== "canvas" || !host.triage) return { read: 0 };
    const decided = host.triageDecisions
      ? host.triageDecisions(source.accountScope, item.courseId)
      : await host.triage(source.accountScope, item.courseId, signal).catch(() => null);
    if (!decided) return { read: 0 };
    const onceId = `web-once:${contentHash(`${source.accountScope}:${item.courseId}`).slice(0, 24)}`;
    const earlier = store.resources().filter((r) => r.sourceId === onceId && !r.deleted);
    const targets = readOnceTargets(item, decided).filter((url) => !earlier.some((r) => r.url === url && (r.text || r.document)));
    if (!targets.length) return { read: 0 };
    const settings = store.ingestionSettings();
    const manager = createDocumentManager({
      directory: join(host.directory, "documents"),
      client,
      downloadConcurrency: settings.downloadConcurrency,
      maxBytes: settings.maxFileBytes,
      extractor: host.extractor,
    });
    const fresh: ResourceInput[] = [];
    let status: CaptureBatch["status"] = "ok";
    for await (const batch of externalCourseConnector({
      accountScope: source.accountScope,
      courseId: item.courseId,
      courseName: item.courseName,
      seeds: targets,
      client,
      maxDepth: 0,
      maxPages: targets.length,
      now,
      onDocument: async ({ url, depth, discoveredFrom, response, signal }) => {
        const result = await manager.capture({
          id: contentHash(url),
          sourceUrl: url,
          downloadUrl: url,
          allowedDownloadOrigins: [new URL(url).origin],
          filename: new URL(url).pathname.split("/").pop(),
          response,
          signal,
        });
        return resourceInputSchema.parse({
          externalId: contentHash(url),
          kind: "material",
          courseId: item.courseId,
          courseName: item.courseName,
          title: new URL(url).pathname.split("/").pop() || "Linked document",
          url,
          text: result.text,
          parts: result.parts,
          document: result.document,
          crawl: { depth, discoveredFrom, fetchedAt: now().toISOString() },
        });
      },
    }).pull(signal)) {
      fresh.push(...batch.resources);
      if (batch.status !== "ok") status = batch.status;
    }
    const kept = earlier
      .filter((r) => !fresh.some((f) => f.externalId === r.externalId))
      .map((r) => resourceInputSchema.strip().parse(r));
    save({
      source: {
        id: onceId,
        label: `${item.courseName} linked pages`.slice(0, 200),
        kind: "web",
        accountScope: source.accountScope,
        courseId: item.courseId,
        scope: "linked_pages",
      },
      observedAt: now().toISOString(),
      // A failed read never deletes an earlier one: only a clean read replaces the set.
      complete: status === "ok",
      status,
      resources: [...kept, ...fresh],
    });
    return { read: fresh.length };
  }
  async function external(signal: AbortSignal, force: boolean) {
    let capturedExternal = false,
      capturedLatePage = false;
    const settings = store.ingestionSettings();
    const sources = new Map(store.sources().map((s) => [s.id, s]));
    for (const { resource: course, source } of courses()) {
      signal.throwIfAborted();
      const resources = store
        .resources()
        .filter(
          (r) =>
            r.courseId === course.courseId &&
            sources.get(r.sourceId)?.accountScope === source.accountScope,
        );
      const linked = [
        ...new Set(
          resources
            .filter((r) => sources.get(r.sourceId)?.kind === "canvas")
            .flatMap((r) => r.links ?? [])
            .map((l) => (typeof l === "string" ? l : l.url))
            .filter((url) => {
              try {
                return (
                  new URL(url).origin !== origin && !gitlabProjectFromUrl(url)
                );
              } catch {
                return false;
              }
            }),
        ),
      ];
      // owner: site-recipes. Triage first, from Canvas evidence only: the crawl reads `sync` hosts
      // and nothing else. A failed triage reads nothing this run rather than everything.
      let seeds = linked;
      if (host.triage && linked.length) {
        const decided = await host
          .triage(source.accountScope, course.courseId, signal)
          .catch(() => null);
        signal.throwIfAborted();
        seeds = decided ? syncSeeds(linked, decided) : [];
      }
      // The crawler's own source; pages read once on demand live in `linked_pages`.
      const publicSource = store
        .sources()
        .find(
          (s) =>
            s.kind === "web" &&
            s.scope === "course_websites" &&
            s.accountScope === source.accountScope &&
            s.courseId === course.courseId,
        );
      if (
        seeds.length &&
        (force ||
          !publicSource?.lastSuccessAt ||
          now().getTime() - Date.parse(publicSource.lastSuccessAt) >=
            settings.externalRefreshHours * 3600000)
      ) {
        const manager = createDocumentManager({
          directory: join(host.directory, "documents"),
          client,
          downloadConcurrency: settings.downloadConcurrency,
          maxBytes: settings.maxFileBytes,
          extractor: host.extractor,
        });
        for await (const batch of externalCourseConnector({
          accountScope: source.accountScope,
          courseId: course.courseId,
          courseName: course.courseName,
          seeds,
          client,
          previous: resources
            .filter(
              (r) =>
                sources.get(r.sourceId)?.kind === "web" &&
                sources.get(r.sourceId)?.scope === "course_websites",
            )
            .map(inputResource),
          maxDepth: settings.crawlMaxDepth,
          maxPages: settings.crawlMaxPages,
          force,
          now,
          onCanvasLink: async (url) => {
            const u = new URL(url),
              match = u.pathname.match(
                /^\/courses\/(\d+)\/pages\/([a-zA-Z0-9_%.-]+)$/,
              );
            if (
              !match ||
              match[1] !== course.courseId ||
              resources.some((r) => r.url === url && r.text)
            )
              return;
            const linkedSource = {
              id: `canvas:${source.accountScope}:${course.courseId}:linked-page:${contentHash(url)}`,
              label: `${course.courseName} · linked page`.slice(0, 200),
              kind: "canvas" as const,
              accountScope: source.accountScope,
              courseId: course.courseId,
              scope: `linked-page:${contentHash(url)}`,
            };
            const http = new CanvasHttp({
              fetch: host.canvasFetch,
              scheduler: scheduler(),
            });
            try {
              const result = await http.request(
                `${origin}/api/v1/courses/${course.courseId}/pages/${match[2]}`,
                signal,
                undefined,
                1,
                { fresh: true },
              );
              const page = result.data as { title?: unknown; body?: unknown };
              capturedLatePage = true;
              if (
                typeof page.title !== "string" ||
                typeof page.body !== "string"
              )
                throw new Error();
              save({
                source: linkedSource,
                observedAt: now().toISOString(),
                complete: true,
                status: "ok",
                resources: [
                  resourceInputSchema.parse({
                    externalId: match[2],
                    kind: "material",
                    courseId: course.courseId,
                    courseName: course.courseName,
                    title: page.title,
                    url,
                    ...canvasContent(page.body, url),
                  }),
                ],
              });
            } catch {
              signal.throwIfAborted();
              save({
                source: linkedSource,
                observedAt: now().toISOString(),
                complete: false,
                status: http.needsSignIn ? "needs_sign_in" : "partial",
                resources: [],
              });
            }
          },
          onDocument: async ({
            url,
            depth,
            discoveredFrom,
            response,
            signal,
          }) => {
            const id = contentHash(url),
              previous = resources.find((r) => r.url === url);
            const result = await manager.capture({
              id,
              sourceUrl: url,
              downloadUrl: url,
              allowedDownloadOrigins: [new URL(url).origin],
              filename: new URL(url).pathname.split("/").pop(),
              previous: previous?.document,
              response,
              signal,
            });
            return resourceInputSchema.parse({
              externalId: id,
              kind: "material",
              courseId: course.courseId,
              courseName: course.courseName,
              title:
                new URL(url).pathname.split("/").pop() || "Course document",
              url,
              text: result.text,
              parts: result.parts,
              document: result.document,
              crawl: { depth, discoveredFrom, fetchedAt: now().toISOString() },
            });
          },
        }).pull(signal)) {
          capturedExternal ||= batch.resources.some(
            (r) =>
              !resources.some(
                (old) => old.url === r.url && old.text === r.text,
              ),
          );
          save(batch);
        }
      }
      // Projects Canvas material links to, plus any the student linked to this course by hand.
      const projects = gitlabProjectsForCourse(
        resources.flatMap((r) => r.links ?? []).map((l) => (typeof l === "string" ? l : l.url)),
        store.gitlabLinks(),
        { accountScope: source.accountScope, courseId: course.courseId },
      );
      if (host.gitlabFetch && projects.length)
        for await (const batch of gitlabConnector({
          fetch: host.gitlabFetch,
          accountScope: source.accountScope,
          courses: projects.map((projectId) => ({
            projectId,
            courseId: course.courseId,
            courseName: course.courseName,
          })),
          now,
        }).pull(signal))
          save(batch);
    }
    if (capturedLatePage && (await revalidatePages(signal))) return;
    if (capturedExternal) {
      await documents(signal); // Same-run drain only when external acquisition discovered material.
      await recheckAccess(signal);
    }
    linkExactEvidence(store);
    const included = courseInclusion(store),
      evidence = evidenceFor(store);
    const nextWeek = store
      .resources()
      .filter(
        (r) =>
          r.kind === "assignment" &&
          !r.deleted &&
          included(r) &&
          r.deadlines.some(
            (d) =>
              d.kind === "due" &&
              Date.parse(d.value) >= now().getTime() &&
              Date.parse(d.value) <= now().getTime() + 7 * 86400000,
          ),
      );
    // Observe only when each captured near-term item has instructions; absence is not zero latency.
    if (
      nextWeek.length &&
      nextWeek.every(
        (r) =>
          r.text.trim() || evidence.supporting(r).some((s) => s.text.trim()),
      )
    )
      nextWeekInstructionsMs = Math.max(0, performance.now() - activeStart);
  }
  // owner: T05b. D32 inventory and D41 access, per course. Held here until the data builder's
  // course_spaces table stores them (host.onSpaces); rechecked on the content probe and sign-in.
  const spaces = new Map<string, CourseSpace[]>();
  const moduleHashes = new Map<string, string>();
  let recheckAll = false;
  // owner: T17. One request scheduler per sync: its probes, full read, documents and inventory
  // share one per-host limit, and an identical GET within the sync is read once (the hot probe's
  // to-do list, the content probe's stream and each course's modules are reused by the full read).
  let runScheduler: FetchScheduler | undefined;
  function scheduler() {
    return (runScheduler ??= createFetchScheduler({
      concurrency: Math.min(
        DEFAULT_HOST_CONCURRENCY,
        store.ingestionSettings().metadataConcurrency,
      ),
      reuseMs: 120_000,
    }));
  }
  // end owner: T17
  const canvasScope: Partial<Record<CourseSpace["kind"], string>> = {
    canvas_page: "pages",
    canvas_file: "files",
    canvas_assignment: "assignments",
    canvas_quiz: "quizzes",
    canvas_discussion: "discussions",
    syllabus: "syllabus",
  };
  const sessionTransport: AccessTransport | undefined = host.spaceFetch
    ? async (url, signal) => {
        const response = await host.spaceFetch!(url, {
          method: "GET",
          signal: signal ?? null,
        });
        return {
          status: response.status,
          location: response.headers.get("location"),
          body: await response.text().catch(() => ""),
        };
      }
    : undefined;
  function accessDeps(
    accountScope: string,
    courseId: string,
    signal: AbortSignal,
  ) {
    const sources = store
      .sources()
      .filter(
        (s) =>
          s.kind === "canvas" &&
          s.accountScope === accountScope &&
          s.courseId === courseId,
      );
    return {
      session: sessionTransport,
      public: publicAccessTransport(client),
      now,
      signal,
      canvas(
        space: CourseSpace,
      ): Pick<SpaceAccess, "state" | "reason"> &
        Partial<Pick<SpaceAccess, "checkedAt">> {
        const expired = sources
          .filter((s) => s.status === "needs_sign_in")
          .sort((a, b) => b.lastAttemptAt.localeCompare(a.lastAttemptAt))[0];
        if (expired)
          return {
            state: "needs-uw-signin",
            reason: "canvas_session",
            checkedAt: expired.lastAttemptAt,
          };
        const fileId = canvasFileId(space.url, origin, courseId);
        const candidates = store
          .resources()
          .filter(
            (r) =>
              !r.deleted &&
              !r.document &&
              r.courseId === courseId &&
              (r.url === space.url || (fileId && r.file?.id === fileId)),
          );
        const observations = sources
          .filter(
            (s) =>
              s.scope === `file:${fileId}` ||
              ((s.scope?.startsWith("page:") ||
                s.scope?.startsWith("linked-page:")) &&
                candidates.some((r) => r.sourceId === s.id)),
          )
          .sort((a, b) => b.lastAttemptAt.localeCompare(a.lastAttemptAt));
        const latest = observations[0];
        const item = candidates.find((r) => r.sourceId === latest?.id);
        if (!latest)
          return { state: "unknown", reason: "not_verified", checkedAt: null };
        if (
          latest.diagnostics?.some((d) =>
            ["file_budget_deferred", "unchanged_page_reused"].includes(d.code),
          )
        )
          return {
            state: "unknown",
            reason: "budget_deferred",
            checkedAt: null,
          };
        if (latest.status === "inaccessible" || item?.file?.locked)
          return {
            state: "blocked",
            reason: item?.file?.locked ? "file_locked" : "not_authorized",
            checkedAt: latest.lastAttemptAt,
          };
        return {
          state: latest.status === "ok" ? "readable" : "unknown",
          reason: latest.status === "ok" ? undefined : "check_incomplete",
          checkedAt: latest.lastAttemptAt,
        };
      },
    };
  }
  async function inventory(only: Set<string> | undefined, signal: AbortSignal) {
    const s = store.ingestionSettings();
    const http = new CanvasHttp({
      fetch: host.canvasFetch,
      metadataConcurrency: s.metadataConcurrency,
      scheduler: scheduler(),
    });
    const sources = new Map(store.sources().map((x) => [x.id, x]));
    const all = store.resources();
    for (const { resource: course, source } of courses()) {
      if (only && !only.has(course.courseId)) continue;
      if (http.needsSignIn) break;
      signal.throwIfAborted();
      const stored = all.filter(
        (r) =>
          r.courseId === course.courseId &&
          sources.get(r.sourceId)?.accountScope === source.accountScope &&
          sources.get(r.sourceId)?.kind === "canvas",
      );
      const read = await readCanvasInventory(
        http,
        { id: course.courseId },
        stored,
        signal,
        moduleRun?.accountScope === source.accountScope ? moduleRun : undefined,
      );
      if (read.status === "needs_sign_in") break;
      const key = `${source.accountScope}:${course.courseId}`;
      if (read.moduleHash) moduleHashes.set(key, read.moduleHash);
      // A failed list keeps what the last inventory found for it (spaces are missing, not deleted).
      const previous = spaces.get(key) ?? [];
      const merged =
        read.status === "ok"
          ? read.spaces
          : [
              ...read.spaces,
              ...previous.filter(
                (old) => !read.spaces.some((x) => x.url === old.url),
              ),
            ];
      const probe = await probeFilter(source.accountScope, course.courseId, signal);
      const checked = await checkSpaceAccess(
        hydrateCourseSpaces(
          store,
          source.accountScope,
          course.courseId,
          merged,
        ),
        {
          ...accessDeps(source.accountScope, course.courseId, signal),
          ...(probe ? { only: probe } : {}),
        },
      );
      spaces.set(key, checked);
      persistCourseSpaces(
        store,
        source.accountScope,
        course.courseId,
        checked,
        read.status === "ok",
      );
      host.onSpaces?.(source.accountScope, course.courseId, checked);
    }
  }
  /**
   * owner: site-recipes. Host triage gates D41's access check too: only hosts the app will read
   * (`sync`, `read_once`) and Canvas's own spaces get the one plain request. `link_only` keeps the
   * host table's state without a request; `ignore` gets none. No triage host: every space, as before.
   */
  async function probeFilter(
    accountScope: string,
    courseId: string,
    signal: AbortSignal,
  ): Promise<((space: CourseSpace) => boolean) | undefined> {
    if (!host.triage) return undefined;
    const decided = await host.triage(accountScope, courseId, signal).catch(() => null);
    return (space) => {
      if (space.route === "canvas_session") return true;
      let name = "";
      try {
        name = new URL(space.url).hostname.toLowerCase();
      } catch {
        return false;
      }
      const decision = decided?.get(name)?.decision;
      return decision === "sync" || decision === "read_once";
    };
  }
  /** D41: recheck on the content probe (what isn't readable) and after a sign-in (everything). */
  async function recheckAccess(signal: AbortSignal) {
    const all = recheckAll;
    recheckAll = false;
    for (const [key, list] of spaces) {
      const [accountScope, courseId] = [
        key.slice(0, key.lastIndexOf(":")),
        key.slice(key.lastIndexOf(":") + 1),
      ];
      const probe = await probeFilter(accountScope, courseId, signal);
      const checked = await checkSpaceAccess(list, {
        ...accessDeps(accountScope, courseId, signal),
        only: (space) =>
          (!probe || probe(space)) &&
          (all ||
            space.route === "canvas_session" ||
            space.access.state !== "readable"),
      });
      spaces.set(key, checked);
      persistCourseSpaces(store, accountScope, courseId, checked);
      host.onSpaces?.(accountScope, courseId, checked);
    }
  }
  // end owner: T05b
  const coordinator = createRefreshCoordinator({
    now,
    begin() {
      runScheduler = undefined; // owner: T17: a new sync reads afresh
      activeStart = performance.now();
      firstValueMs = undefined;
      nextWeekInstructionsMs = undefined;
      sourceIds.clear();
      attemptedFiles.clear();
      observedPages.clear();
      fileBudgetMs = acquisition.steady.ms; // owner: acquisition
      fileBudgetFiles = acquisition.steady.files;
      budgetChosen = false;
      if (moduleRun) moduleRun.invalidated = true;
      moduleRun = undefined;
      rateLimitRemaining = undefined;
      requestCost = undefined;
    },
    settings() {
      const s = store.ingestionSettings();
      return {
        enabled: s.enabled,
        intervalMinutes: s.intervalMinutes,
        jitterFraction: s.jitterRatio,
        quietStartHour: s.quietHours.enabled ? s.quietHours.start : 0,
        quietEndHour: s.quietHours.enabled ? s.quietHours.end : 0,
      };
    },
    hasSources: () =>
      store.sources().some((s) => s.kind === "canvas") ||
      Boolean(host.graph?.scopes().length), // owner: T30
    feeds,
    graph, // owner: T30
    async probe(signal) {
      const result = await fetchCanvasActivitySummary(
        { fetch: host.canvasFetch, scheduler: scheduler() },
        signal,
      );
      if (result.status === "needs_sign_in") markExpired();
      return {
        needsSignIn: result.status === "needs_sign_in",
        signature: result.hash,
      };
    },
    async full(signal) {
      return canvasRead(undefined, signal);
    },
    // owner: T33. The hot tick, the content probe and the warm read of only the moved courses.
    async hot(signal) {
      const http = new CanvasHttp({
        fetch: host.canvasFetch,
        scheduler: scheduler(),
      });
      const probe = await fetchCanvasHotProbe(http, signal);
      probeRequests += probe.requests;
      if (probe.status === "needs_sign_in") markExpired();
      return {
        needsSignIn: probe.status === "needs_sign_in",
        courses: probe.courses,
        complete: probe.status === "ok",
      };
    },
    async content(signal) {
      const s = store.ingestionSettings();
      const http = new CanvasHttp({
        fetch: host.canvasFetch,
        metadataConcurrency: s.metadataConcurrency,
        scheduler: scheduler(), // owner: T17
      });
      const ids = [
        ...new Set(courses().map(({ resource }) => resource.courseId)),
      ];
      const accounts = [
        ...new Set(courses().map(({ source }) => source.accountScope)),
      ];
      moduleRun =
        accounts.length === 1 ? createCanvasModuleRun(accounts[0]!) : undefined;
      const probe = await fetchCanvasContentProbe(
        http,
        ids,
        signal,
        s.metadataConcurrency,
        moduleRun,
      );
      probeRequests += probe.requests;
      if (probe.status === "needs_sign_in") markExpired();
      else {
        if (await revalidatePages(signal))
          return { needsSignIn: true, courses: {}, complete: false };
        if (await documents(signal))
          return { needsSignIn: true, courses: {}, complete: false };
        linkExactEvidence(store);
        await recheckAccess(signal);
      }
      return {
        needsSignIn: probe.status === "needs_sign_in",
        courses: probe.courses,
        components: probe.components,
        complete: probe.status === "ok",
      };
    },
    async warm(courseIds, signal) {
      // A moved course that is not included (for example a to-do from an excluded site) is not read.
      const included = new Set(
        courses().map(({ resource }) => resource.courseId),
      );
      const read = courseIds.filter((id) => included.has(id));
      if (!read.length) return { needsSignIn: false, complete: true };
      return canvasRead(new Set(read), signal);
    },
    // end owner: T33
    external,
    record(run) {
      recordRun(run);
    },
  });
  /**
   * fix/current-courses-only. The student's UW current enrollment (Course Search & Enroll), when
   * planning has read it: a Canvas course matches an enrolled class by subject and catalog number
   * (and section, when both name one). Code only; nothing here reaches AI, Jev or MCP. Without
   * planning data, Canvas's own signals decide alone.
   */
  function planningEnrollment(): ((course: SelectableCanvasCourse) => boolean) | undefined {
    const records = (store.planningRecords?.() ?? []).filter((r) => !r.deleted);
    const enrolled = records.flatMap((r) =>
      r.kind === "enrollment_package" && r.enrollmentState === "enrolled" ? [r] : [],
    );
    if (!enrolled.length) return undefined;
    const latest = enrolled.map((r) => r.termCode).sort().at(-1);
    let table: ReturnType<typeof buildCourseIdentityTable>;
    try {
      table = buildCourseIdentityTable(
        records.flatMap((r) => (r.kind === "subject" ? [r as PlanningSubject] : [])),
        records.flatMap((r) => (r.kind === "crosslist" ? [r as PlanningCrosslist] : [])),
      );
    } catch {
      return undefined;
    }
    const byKey = new Map(
      enrolled
        .filter((r) => r.termCode === latest)
        .map((r) => [canonicalizeCourseKey(r.courseKey, table), r] as const),
    );
    return (course) => {
      const code = canvasCourseCode(course.course_code) ?? canvasCourseCode(course.name);
      if (!code) return false;
      const identity = resolveCourseIdentity({ subject: code.subject, catalog: code.catalog }, table);
      if (identity.status !== "resolved") return false;
      const match = byKey.get(canonicalizeCourseKey(identity.courseKey, table));
      if (!match) return false;
      const sections = match.sections.flatMap((s) => s.match(/(\d{3})\s*$/)?.[1] ?? []);
      return !code.sections.length || !sections.length || code.sections.some((s) => sections.includes(s));
    };
  }
  /**
   * fix/current-courses-only. Canvas's nameless date-restricted rows are never kept as courses;
   * a workspace that stored them before loses only those metadata rows (no coursework).
   */
  function retireNamelessCourses() {
    for (const r of store.resources())
      if (
        r.kind === "course" &&
        r.course?.accessRestricted &&
        /^Course \d+ \(name unavailable\)$/.test(r.courseName)
      )
        store.removeSource(r.sourceId);
  }
  /**
   * fix/current-courses-only. Discovery before the first full read: the profile and the course
   * lists only, so onboarding can show the courses and the student can choose. Background
   * reads hold until the student starts the sync (the next manual run).
   */
  const holdForChoice = (value: boolean) => {
    const settings = store.ingestionSettings();
    if (settings.awaitingCourseChoice !== value) store.setIngestionSettings({ ...settings, awaitingCourseChoice: value });
  };
  async function discover(signal = new AbortController().signal) {
    const s = store.ingestionSettings();
    for await (const batch of canvasConnector({
      fetch: host.canvasFetch,
      metadataConcurrency: s.metadataConcurrency,
      selectedTerm: s.selectedTerm,
      courseOverrides: store.courseOverrides(),
      knownResources: store.resources(),
      enrolledThisTerm: planningEnrollment(),
      now,
      catalogOnly: true,
    }).pull(signal))
      save(batch);
    retireNamelessCourses();
    holdForChoice(true);
  }
  // owner: T33. One Canvas read: every included course (full), or only the given ones (warm).
  async function canvasRead(
    only: Set<string> | undefined,
    signal: AbortSignal,
  ) {
    let needsSignIn = false;
    const signInCourses = new Set<string>(); // owner: acquisition (RC4)
    let accountSignIn = false;
    const s = store.ingestionSettings();
    for await (const batch of canvasConnector({
      onIdentity: (identity) => {
        if (!signal.aborted && !reconnecting) store.recordAutoIdentity(identity);
      },
      fetch: host.canvasFetch,
      metadataConcurrency: s.metadataConcurrency,
      scheduler: scheduler(), // owner: T17
      collectComments: s.collectComments,
      selectedTerm: s.selectedTerm,
      courseOverrides: store.courseOverrides(),
      knownResources: store.resources(),
      enrolledThisTerm: planningEnrollment(), // fix/current-courses-only
      moduleRun,
      onModuleRun: (run) => {
        if (!signal.aborted && !reconnecting) moduleRun = run;
      },
      now,
      ...(only ? { onlyCourses: [...only] } : {}), // owner: T33
      onCalendarFeed: (feed) =>
        host
          .secrets(
            "set",
            `calendar:${feed.accountScope}:${feed.courseId}`,
            feed.url,
          )
          .then(() => {}),
    }).pull(signal)) {
      save(batch);
      needsSignIn ||= batch.status === "needs_sign_in";
      // owner: acquisition (RC4): a sign-in state on one course's source no longer skips the
      // documents of every other course; only an account-level one (no course) does.
      if (batch.status === "needs_sign_in") {
        if (batch.source.courseId) signInCourses.add(batch.source.courseId);
        else accountSignIn = true;
      }
    }
    retireNamelessCourses(); // fix/current-courses-only
    if (needsSignIn && accountSignIn) markExpired();
    else {
      // documents() stops at its first sign-in answer (one request) if the session is gone.
      const documentsSignIn = await documents(signal, only, signInCourses);
      if (!documentsSignIn) startOcr(); // owner: acquisition: background, never awaited
      if (!needsSignIn && !documentsSignIn) await inventory(only, signal); // owner: T05b (D32, D41)
      if (needsSignIn && !documentsSignIn) markExpired();
      needsSignIn ||= documentsSignIn;
    }
    // end owner: acquisition
    await feeds(signal);
    return {
      needsSignIn,
      complete: !hasIncompleteRead(),
      retryNeeded: store
        .sources()
        .some(
          (s) =>
            sourceIds.has(s.id) &&
            !["ok", "inaccessible", "not_published"].includes(s.status),
        ),
    };
  }
  // end owner: T33
  function recordRun(
    run: Parameters<
      Parameters<typeof createRefreshCoordinator>[0]["record"]
    >[0],
  ) {
    store.addSyncRun({
      id: randomUUID(),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      action: run.trigger,
      status: run.needsSignIn
        ? "needs_sign_in"
        : run.action === "failed"
          ? "error"
          : hasIncompleteRead()
            ? "partial"
            : run.action === "unchanged"
              ? "unchanged"
              : "ok",
      sourceCount: sourceIds.size,
      stats: {
        durationMs: Date.parse(run.finishedAt) - Date.parse(run.startedAt),
        firstValueMs,
        nextWeekInstructionsMs,
        rateLimitRemaining,
        requestCost,
      },
      diagnostics: [],
    });
  }
  function markExpired() {
    for (const s of store.sources().filter((s) => s.kind === "canvas")) {
      const { id, label, kind, accountScope, courseId, scope } = s;
      save({
        source: { id, label, kind, accountScope, courseId, scope },
        observedAt: now().toISOString(),
        status: "needs_sign_in",
        complete: false,
        resources: [],
      });
    }
  }
  // owner: T17. One sync after sign-in. Main's `reconnected` only re-arms the coordinator; the
  // renderer's sync call (startSignIn) owns the read. If a background tick got to it first, a
  // manual call while that read runs joins it (the coordinator's own guard), and one that arrives
  // within a minute after it finished is answered by it instead of reading everything again.
  let signInPending = false,
    signInRead:
      | { at: number; run: Awaited<ReturnType<typeof coordinator.tick>> }
      | undefined;
  let reconnectBarrier: Promise<void> | undefined;
  let sessionGeneration = 0;
  function tick(
    trigger: "manual" | "background" = "background",
  ): ReturnType<typeof coordinator.tick> {
    if (reconnectBarrier) return reconnectBarrier.then(() => tick(trigger));
    // fix/current-courses-only: while the student chooses courses, only their own start reads.
    if (trigger === "background" && store.ingestionSettings().awaitingCourseChoice) return Promise.resolve(undefined);
    if (trigger === "manual") holdForChoice(false);
    const generation = sessionGeneration;
    if (
      trigger === "manual" &&
      signInRead &&
      now().getTime() - signInRead.at < 60_000
    ) {
      const { run } = signInRead;
      signInRead = undefined;
      return Promise.resolve(run);
    }
    const running = coordinator.tick(trigger);
    if (signInPending) {
      signInPending = false;
      const claimed = trigger;
      void running.then((run) => {
        if (generation !== sessionGeneration) return;
        if (run?.action === "refreshed" && !run.needsSignIn) {
          if (claimed === "background")
            signInRead = { at: now().getTime(), run };
        } else signInPending = true; // nothing was read: the next tick still owns the sign-in sync
      });
    }
    return running;
  }
  // end owner: T17
  return {
    ...coordinator,
    tick, // owner: T17
    markExpired,
    discover, // fix/current-courses-only
    // owner: T05b
    reconnected() {
      sessionGeneration++;
      reconnecting = true;
      recheckAll = true;
      signInPending = true;
      signInRead = undefined;
      if (moduleRun) moduleRun.invalidated = true;
      moduleRun = undefined;
      runScheduler = undefined;
      const barrier = coordinator.cancelAndWait().then(() => {
        if (reconnectBarrier !== barrier) return;
        coordinator.reconnected();
        reconnecting = false;
        reconnectBarrier = undefined;
      });
      reconnectBarrier = barrier;
      return barrier;
    },
    readLinked, // owner: site-recipes
    /** owner: site-recipes. The core's `ui_event` seam: opening an item reads its `read_once` links. */
    onUiEvent: async (event: { kind: string; subject: string }) => {
      if (event.kind === "open") await readLinked(event.subject).catch(() => {});
    },
    spaces: () => [...spaces.values()].flat(),
    accessSummary: () => accessSummary([...spaces.values()].flat()),
    recheckAccess,
    moduleHashes: () => new Map(moduleHashes),
    probeRequests: () => probeRequests, // owner: T33
    documentRun: () => ({ ...lastDocumentRun, pool: extractPool?.stats(), threaded: extractPool?.threaded ?? false }), // owner: acquisition
    closeExtraction: () => extractPool?.close(), // owner: acquisition
    // end owner: T05b
  };
}
