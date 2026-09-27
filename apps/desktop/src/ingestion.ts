import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  resourceInputSchema,
  type Store,
  type CaptureBatch,
  type Resource,
  type ResourceInput,
} from "@magic/contracts";
import {
  canvasConnector,
  fetchCanvasActivitySummary,
} from "../../../packages/connectors/src/canvas";
import { CanvasHttp } from "../../../packages/connectors/src/canvas-http";
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
export function createIngestion(store: Store, host: IngestionHost) {
  const now = host.now ?? (() => new Date()),
    origin = "https://canvas.wisc.edu";
  const client = host.client ?? createPublicClient();
  let activeStart = 0,
    firstValueMs: number | undefined,
    nextWeekInstructionsMs: number | undefined;
  let rateLimitRemaining: number | undefined, requestCost: number | undefined;
  let probeRequests = 0; // owner: T33: requests made by the hot tick and the content probe
  const sourceIds = new Set<string>();
  function hasIncompleteRead() {
    const included = courseInclusion(store);
    return store
      .sources()
      .some(
        (source) =>
          sourceIds.has(source.id) &&
          source.status !== "ok" &&
          included({
            sourceId: source.id,
            courseId: source.courseId,
          } as Resource),
      );
  }
  function save(batch: CaptureBatch) {
    const previous = store.sources().find((s) => s.id === batch.source.id);
    if (previous && batch.observedAt <= previous.lastAttemptAt)
      batch = {
        ...batch,
        observedAt: new Date(
          Date.parse(previous.lastAttemptAt) + 1,
        ).toISOString(),
      };
    store.ingest(batch);
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
  async function documents(signal: AbortSignal) {
    const settings = store.ingestionSettings(),
      manager = createDocumentManager({
        directory: join(host.directory, "documents"),
        client,
        downloadConcurrency: settings.downloadConcurrency,
        maxBytes: settings.maxFileBytes,
        extractor: host.extractor,
      });
    const sources = new Map(store.sources().map((s) => [s.id, s])),
      included = courseInclusion(store);
    const files = store
      .resources()
      .filter(
        (r) =>
          r.file?.id &&
          !r.document &&
          sources.get(r.sourceId)?.scope === "files" &&
          !r.file.locked &&
          included(r),
      );
    const dueUrls = new Set(
      store
        .resources()
        .filter(
          (r) =>
            r.dueAt && Date.parse(r.dueAt) <= now().getTime() + 14 * 86400000,
        )
        .flatMap((r) => r.links ?? [])
        .map((l) => (typeof l === "string" ? l : l.url)),
    );
    files.sort(
      (a, b) => Number(dueUrls.has(b.url)) - Number(dueUrls.has(a.url)),
    );
    const http = new CanvasHttp({
      fetch: host.canvasFetch,
      metadataConcurrency: settings.metadataConcurrency,
      scheduler: scheduler(), // owner: T17
    });
    let index = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(settings.downloadConcurrency, files.length) },
        async () => {
          while (index < files.length) {
            const file = files[index++]!,
              source = sources.get(file.sourceId)!;
            const prior = store
              .resources()
              .find(
                (r) =>
                  r.document?.fileId === file.file?.id &&
                  r.courseId === file.courseId &&
                  sources.get(r.sourceId)?.accountScope === source.accountScope,
              );
            const documentSource = {
              id: `documents:${source.accountScope}:${file.courseId}:${file.externalId}`,
              label: `${file.courseName} · ${file.title}`.slice(0, 200),
              kind: "canvas" as const,
              accountScope: source.accountScope,
              courseId: file.courseId,
              scope: `document:${file.externalId}`,
            };
            try {
              signal.throwIfAborted();
              // This fresh URL is issued by the authenticated Canvas API, not by page content.
              const metadata = await http.request(
                `${origin}/api/v1/files/${file.file!.id}`,
                signal,
              );
              const value = metadata.data as { id?: unknown; url?: unknown };
              if (
                String(value?.id) !== file.file!.id ||
                typeof value.url !== "string"
              )
                throw new Error("file_metadata_invalid");
              const download = new URL(value.url);
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
              const extracted = await manager.capture({
                id: file.file!.id!,
                sourceUrl: file.url,
                downloadUrl: download.href,
                allowedDownloadOrigins: [
                  origin,
                  download.origin,
                  "https://instructure-uploads.s3.amazonaws.com",
                ],
                filename: file.file!.displayName ?? file.title,
                contentType: file.file!.contentType,
                updatedAt: file.updatedAt ?? undefined,
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
                dueSoon: dueUrls.has(file.url),
                signal,
              });
              save({
                source: documentSource,
                observedAt: now().toISOString(),
                complete: extracted.status === "ok",
                status: extracted.status === "ok" ? "ok" : "partial",
                resources:
                  extracted.status !== "ok" && prior?.text
                    ? [inputResource(prior)]
                    : [
                        {
                          ...inputResource(file),
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
            } catch {
              signal.throwIfAborted();
              save({
                source: documentSource,
                observedAt: now().toISOString(),
                complete: false,
                status: http.needsSignIn ? "needs_sign_in" : "partial",
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
  }
  async function external(signal: AbortSignal, force: boolean) {
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
            const http = new CanvasHttp({ fetch: host.canvasFetch });
            try {
              const result = await http.request(
                `${origin}/api/v1/courses/${course.courseId}/pages/${match[2]}`,
                signal,
              );
              const page = result.data as { title?: unknown; body?: unknown };
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
        }).pull(signal))
          save(batch);
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
        const response = await host.spaceFetch!(url, { method: "GET", signal: signal ?? null });
        return {
          status: response.status,
          location: response.headers.get("location"),
          body: await response.text().catch(() => ""),
        };
      }
    : undefined;
  function accessDeps(accountScope: string, courseId: string, signal: AbortSignal) {
    const sources = store
      .sources()
      .filter((s) => s.kind === "canvas" && s.accountScope === accountScope && s.courseId === courseId);
    return {
      session: sessionTransport,
      public: publicAccessTransport(client),
      now,
      signal,
      canvas(space: CourseSpace): Pick<SpaceAccess, "state" | "reason"> {
        if (space.readState === "read") return { state: "readable" };
        const scope =
          space.foundIn === "tab" && space.kind === "canvas_tab" ? "course" : canvasScope[space.kind];
        const status = sources.find((s) => s.scope === scope)?.status;
        if (status === "needs_sign_in") return { state: "needs-uw-signin", reason: "canvas_session" };
        if (status === "inaccessible" || status === "not_published" || status === "error")
          return { state: "blocked", reason: status };
        return { state: "readable", ...(status ? {} : { reason: "not_read_yet" }) };
      },
    };
  }
  async function inventory(only: Set<string> | undefined, signal: AbortSignal) {
    const s = store.ingestionSettings();
    const http = new CanvasHttp({ fetch: host.canvasFetch, metadataConcurrency: s.metadataConcurrency, scheduler: scheduler() });
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
      const read = await readCanvasInventory(http, { id: course.courseId }, stored, signal);
      if (read.status === "needs_sign_in") break;
      const key = `${source.accountScope}:${course.courseId}`;
      if (read.moduleHash) moduleHashes.set(key, read.moduleHash);
      // A failed list keeps what the last inventory found for it (spaces are missing, not deleted).
      const previous = spaces.get(key) ?? [];
      const merged = read.status === "ok"
        ? read.spaces
        : [...read.spaces, ...previous.filter((old) => !read.spaces.some((x) => x.url === old.url))];
      const checked = await checkSpaceAccess(merged, accessDeps(source.accountScope, course.courseId, signal));
      spaces.set(key, checked);
      host.onSpaces?.(source.accountScope, course.courseId, checked);
    }
  }
  /** D41: recheck on the content probe (what isn't readable) and after a sign-in (everything). */
  async function recheckAccess(signal: AbortSignal) {
    const all = recheckAll;
    recheckAll = false;
    for (const [key, list] of spaces) {
      const [accountScope, courseId] = [key.slice(0, key.lastIndexOf(":")), key.slice(key.lastIndexOf(":") + 1)];
      const checked = await checkSpaceAccess(list, {
        ...accessDeps(accountScope, courseId, signal),
        only: (space) => all || space.access.state !== "readable",
      });
      spaces.set(key, checked);
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
      const http = new CanvasHttp({ fetch: host.canvasFetch, scheduler: scheduler() });
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
      const ids = [...new Set(courses().map(({ resource }) => resource.courseId))];
      const probe = await fetchCanvasContentProbe(http, ids, signal, s.metadataConcurrency);
      probeRequests += probe.requests;
      if (probe.status === "needs_sign_in") markExpired();
      else await recheckAccess(signal); // owner: T05b: D41 recheck on the content probe
      return {
        needsSignIn: probe.status === "needs_sign_in",
        courses: probe.courses,
        complete: probe.status === "ok",
      };
    },
    async warm(courseIds, signal) {
      // A moved course that is not included (for example a to-do from an excluded site) is not read.
      const included = new Set(courses().map(({ resource }) => resource.courseId));
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
  async function canvasRead(only: Set<string> | undefined, signal: AbortSignal) {
    let needsSignIn = false;
    const s = store.ingestionSettings();
    for await (const batch of canvasConnector({
      fetch: host.canvasFetch,
      metadataConcurrency: s.metadataConcurrency,
      scheduler: scheduler(), // owner: T17
      collectComments: s.collectComments,
      selectedTerm: s.selectedTerm,
      courseOverrides: store.courseOverrides(),
      knownResources: store.resources(),
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
      await documents(signal);
      await inventory(only, signal); // owner: T05b (D32, D41)
    }
    await feeds(signal);
    return { needsSignIn, complete: !hasIncompleteRead() };
  }
  // end owner: T33
  function recordRun(run: Parameters<Parameters<typeof createRefreshCoordinator>[0]["record"]>[0]) {
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
    signInRead: { at: number; run: Awaited<ReturnType<typeof coordinator.tick>> } | undefined;
  function tick(trigger: "manual" | "background" = "background") {
    if (trigger === "manual" && signInRead && now().getTime() - signInRead.at < 60_000) {
      const { run } = signInRead;
      signInRead = undefined;
      return Promise.resolve(run);
    }
    const running = coordinator.tick(trigger);
    if (signInPending) {
      signInPending = false;
      const claimed = trigger;
      void running.then((run) => {
        if (run?.action === "refreshed" && !run.needsSignIn) {
          if (claimed === "background") signInRead = { at: now().getTime(), run };
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
      recheckAll = true;
      signInPending = true; // owner: T17
      signInRead = undefined; // owner: T17
      coordinator.reconnected();
    },
    spaces: () => [...spaces.values()].flat(),
    accessSummary: () => accessSummary([...spaces.values()].flat()),
    recheckAccess,
    moduleHashes: () => new Map(moduleHashes),
    probeRequests: () => probeRequests, // owner: T33
    // end owner: T05b
  };
}
