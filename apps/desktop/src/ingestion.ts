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
import { calendarConnector } from "../../../packages/connectors/src/calendar";
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
import {
  linkExactEvidence,
  evidenceFor,
} from "../../../packages/core/src/evidence";
import { canvasContent } from "../../../packages/connectors/src/canvas-content";

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
    return { changed };
  }
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
  const coordinator = createRefreshCoordinator({
    now,
    begin() {
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
    hasSources: () => store.sources().some((s) => s.kind === "canvas"),
    feeds,
    async probe(signal) {
      const result = await fetchCanvasActivitySummary(
        { fetch: host.canvasFetch },
        signal,
      );
      if (result.status === "needs_sign_in") markExpired();
      return {
        needsSignIn: result.status === "needs_sign_in",
        signature: result.hash,
      };
    },
    async full(signal) {
      let needsSignIn = false;
      const s = store.ingestionSettings();
      for await (const batch of canvasConnector({
        fetch: host.canvasFetch,
        metadataConcurrency: s.metadataConcurrency,
        collectComments: s.collectComments,
        selectedTerm: s.selectedTerm,
        courseOverrides: store.courseOverrides(),
        knownResources: store.resources(),
        now,
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
      else await documents(signal);
      await feeds(signal);
      return { needsSignIn, complete: !hasIncompleteRead() };
    },
    external,
    record(run) {
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
    },
  });
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
  return { ...coordinator, markExpired };
}
