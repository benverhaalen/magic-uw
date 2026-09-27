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
} from "../../../packages/connectors/src/gitlab";
import { courseInclusion } from "../../../packages/core/src/access";
import { createRefreshCoordinator } from "../../../packages/core/src/refresh";
// owner: T33. Per-course freshness probes (D37).
import {
  fetchCanvasContentProbe,
  fetchCanvasHotProbe,
} from "../../../packages/connectors/src/canvas-selection";
// end owner: T33
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
  /** owner: T05b. A course's inventory with access states; the data builder stores it in course_spaces. */
  onSpaces?(accountScope: string, courseId: string, spaces: CourseSpace[]): void;
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
  let fileBudgetMs = 120000;
  async function documents(signal: AbortSignal, only?: Set<string>) {
    const settings = store.ingestionSettings();
    const manager = createDocumentManager({
      directory: join(host.directory, "documents"),
      client,
      downloadConcurrency: settings.downloadConcurrency,
      maxBytes: settings.maxFileBytes,
      extractor: host.extractor,
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
      last: string;
    };
    const jobs: Job[] = [];
    for (const { resource: course, source } of courses()) {
      if (only && !only.has(course.courseId)) continue;
      const rows = all.filter(
        (r) =>
          r.courseId === course.courseId &&
          sources.get(r.sourceId)?.accountScope === source.accountScope,
      );
      const urgent = urgentFileIds(rows, origin, now().getTime());
      const ids = new Set(rows.flatMap((r) => referencedFileIds(r, origin)));
      for (const id of ids) {
        const key = `${source.accountScope}:${course.courseId}:${id}`;
        if (attemptedFiles.has(key)) continue;
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
          urgent: urgent.has(id),
          priorFile: rows.find((r) => r.file?.id === id && !r.document),
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
        a.last.localeCompare(b.last) || a.source.id.localeCompare(b.source.id),
    );
    const urgent = jobs.filter((j) => j.urgent),
      rest = jobs.filter((j) => !j.urgent),
      ordered: Job[] = [];
    while (urgent.length || rest.length) {
      ordered.push(...urgent.splice(0, 3), ...rest.splice(0, 1));
      if (!urgent.length) ordered.push(...rest.splice(0));
    }
    const started = performance.now();
    let index = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(settings.downloadConcurrency, ordered.length) },
        async () => {
          while (
            index < ordered.length &&
            attemptedFiles.size < 100 &&
            performance.now() - started < fileBudgetMs &&
            !http.needsSignIn
          ) {
            const job = ordered[index++]!;
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
            const prior = all.find(
              (r) =>
                r.document?.fileId === job.id &&
                r.courseId === job.course.courseId &&
                sources.get(r.sourceId)?.accountScope === job.account,
            );
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
              if (typeof raw.url !== "string")
                throw new Error("file_metadata_invalid");
              const download = new URL(raw.url);
              if (
                download.protocol !== "https:" ||
                download.username ||
                download.password ||
                !(
                  download.origin === origin ||
                  download.hostname.endsWith(".canvas-user-content.com") ||
                  download.hostname === "instructure-uploads.s3.amazonaws.com"
                )
              )
                throw new Error("download_host_unverified");
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
                downloadUrl: download.href,
                allowedDownloadOrigins: [
                  origin,
                  download.origin,
                  "https://instructure-uploads.s3.amazonaws.com",
                ],
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
              // Save the current extraction state even if empty: old text cannot masquerade as the new version.
              save({
                source: documentSource,
                observedAt: now().toISOString(),
                complete: extracted.status === "ok",
                status: extracted.status === "ok" ? "ok" : "partial",
                resources: [
                  {
                    ...file,
                    text: extracted.text,
                    parts: extracted.parts,
                    document: extracted.document,
                  },
                ],
                diagnostics: extracted.diagnostics.map((code) => ({
                  code,
                  path: [],
                  severity: "warning",
                })),
              });
            } catch (error) {
              signal.throwIfAborted();
              if (!stillIncluded()) continue;
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
                  diagnostics: [
                    {
                      code: "document_read_incomplete",
                      path: [],
                      severity: "warning",
                    },
                  ],
                });
            }
          }
        },
      ),
    );
    fileBudgetMs = Math.max(0, fileBudgetMs - (performance.now() - started));
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
      const seeds = [
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
      const publicSource = store
        .sources()
        .find(
          (s) =>
            s.kind === "web" &&
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
            .filter((r) => sources.get(r.sourceId)?.kind === "web")
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
      const projects = [
        ...new Set(
          resources
            .flatMap((r) => r.links ?? [])
            .map((l) => gitlabProjectFromUrl(typeof l === "string" ? l : l.url))
            .filter((v): v is string => !!v),
        ),
      ];
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
      const checked = await checkSpaceAccess(
        hydrateCourseSpaces(
          store,
          source.accountScope,
          course.courseId,
          merged,
        ),
        accessDeps(source.accountScope, course.courseId, signal),
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
  /** D41: recheck on the content probe (what isn't readable) and after a sign-in (everything). */
  async function recheckAccess(signal: AbortSignal) {
    const all = recheckAll;
    recheckAll = false;
    for (const [key, list] of spaces) {
      const [accountScope, courseId] = [
        key.slice(0, key.lastIndexOf(":")),
        key.slice(key.lastIndexOf(":") + 1),
      ];
      const checked = await checkSpaceAccess(list, {
        ...accessDeps(accountScope, courseId, signal),
        only: (space) =>
          all ||
          space.route === "canvas_session" ||
          space.access.state !== "readable",
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
      fileBudgetMs = 120000;
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
  // owner: T33. One Canvas read: every included course (full), or only the given ones (warm).
  async function canvasRead(
    only: Set<string> | undefined,
    signal: AbortSignal,
  ) {
    let needsSignIn = false;
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
    }
    if (needsSignIn) markExpired();
    else {
      needsSignIn = await documents(signal, only);
      if (!needsSignIn) await inventory(only, signal); // owner: T05b (D32, D41)
    }
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
    spaces: () => [...spaces.values()].flat(),
    accessSummary: () => accessSummary([...spaces.values()].flat()),
    recheckAccess,
    moduleHashes: () => new Map(moduleHashes),
    probeRequests: () => probeRequests, // owner: T33
    // end owner: T05b
  };
}
