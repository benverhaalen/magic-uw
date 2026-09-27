import { judgmentFailureError } from "./judgment-errors";
import { createLocalCourseExtractor } from "@magic/ai";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema, planningCaptureSchema, type PlanningCapture } from "@magic/contracts";
import { queryRequestSchema } from "@magic/contracts"; // owner: T15
import fixture from "../../../fixtures/course.json";
import { randomUUID } from "node:crypto";
import { createLocalService } from "./local-service";
import { createIngestion, ACQUISITION_APP } from "./ingestion";
import { createLearningRouter, type StudyContext } from "../../../packages/learning/src/router";
import { createStudyContextResolver } from "./learning-context";
import { dirname, join } from "node:path";
import {
  createLocalDocumentExtractor,
  createLocalOcrAdapter,
} from "../../../packages/connectors/src/documents";
import { createWorkerClients } from "./worker-clients"; // owner: T06
import { pullPublicSubjects, pullPublicTerms } from "../../../packages/connectors/src/planning-public";
import type { UwPlanningSyncResult } from "../../../packages/connectors/src/uw-planning-sync";
// owner: pipeline
import { pipelineJobRegistry } from "../../../packages/core/src/jobs/default-registry";
import { agenda, courseGraph, createPipelineReferences, references } from "../../../packages/core/src/graph/index";
import { graphQuerySchema } from "../../../packages/contracts/src/course-core";
// end owner: pipeline
// owner: planning-perf
import { planningSourceId } from "../../../packages/storage/src/planning";
import {
  planningRefreshDue, publicSourceTermFresh, reconfirmedAuditCaptures, storedAuditReports, termFreshSearchSubjects,
  type PlanningAddDropWindow,
} from "../../../packages/core/src/planning";
// Worker ≥ main: main's planning timer is 90 s and the native sync's soft deadline is 70 s.
const PLANNING_WORKER_TIMEOUT_MS = 95_000;
// end owner: planning-perf
const port = process.parentPort;
if (!port) throw new Error("Workspace must be started by the desktop app.");
const pending = new Map<
  string,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
const store = createStore(process.env.MAGIC_DB_PATH!);
// owner: T06: every direct public client refuses until the setup consent record exists.
const publicClients = createWorkerClients(store);
// end owner: T06
// owner: generation. The pack runner: the student's chosen client in its app-owned profile
// (CLAUDE_CONFIG_DIR / CODEX_HOME), tools off, our system prompt, the background budget, and
// the SQLite pack stores. No client connected: the pack command answers "Connect your AI first".
import { createClaudeBackend, createCodexBackend, type ModelRunner } from "../../../packages/runner/src/index";
import { createPackRuntime, DEFAULT_PACK_CONFIG } from "../../../packages/packs/core/src/index";
import { createPackHandler } from "../../../packages/core/src/pack-handler";
import { isIsolated, isProfileReady, profileEnv, readClientSettings, resolveClient, workDir } from "./clients/profiles";
const generationUserData = dirname(process.env.MAGIC_DB_PATH!);
let generationRuntime: { client: string; runner: ModelRunner } | null = null;
async function generationRunner(): Promise<ModelRunner | null> {
  const { chosen } = await readClientSettings(generationUserData);
  if (!chosen || !isIsolated(chosen) || !(await isProfileReady(chosen, generationUserData))) return null;
  if (generationRuntime?.client === chosen) return generationRuntime.runner;
  const command = resolveClient(chosen, { userData: generationUserData });
  if (!command) return null;
  const env = Object.fromEntries(
    Object.entries(profileEnv(chosen, { userData: generationUserData })).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])),
  );
  const options = { command, workDir: workDir(generationUserData, chosen), env };
  // owner: ai-paths. Claude runs through the warm session pool (one per worker, replaced on a
  // client change); Codex stays one-shot.
  const { pooledClaudeBackend } = await import("../../../packages/core/src/pack-handler");
  const backend = chosen === "claude" ? pooledClaudeBackend(options) : createCodexBackend(options);
  // end owner: ai-paths
  generationRuntime = { client: chosen, runner: createPackRuntime(backend, DEFAULT_PACK_CONFIG).runner };
  return generationRuntime.runner;
}
const generation = createPackHandler({ store, runner: generationRunner });
// end owner: generation
// owner: notes. Session notes: batch scaffolds on the tick, "fill from slides" through the same
// runner, and Google Docs sync through main (which alone holds the token). Microsoft waits for graph.ts.
import { createNotesService, googleRemote, microsoftRemote, type NotesRemote } from "../../../packages/notes/src/index";
function notesHostCall(payload: unknown, timeoutMs: number): Promise<any> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hostRequests.delete(id);
      reject(new Error("Google Docs didn't answer in time."));
    }, timeoutMs);
    hostRequests.set(id, {
      resolve(value) { clearTimeout(timer); resolve(value); },
      reject(error) { clearTimeout(timer); reject(error); },
    });
    port.postMessage({ kind: "notes-google", id, payload });
  });
}
const notesRemotes: { microsoft?: NotesRemote; google?: NotesRemote & { connect(): Promise<boolean> } } = process.env.MAGIC_GOOGLE_CLIENT_ID
  ? {
      google: {
        ...googleRemote(
          (request) => notesHostCall({ op: "request", request }, 90_000),
          async () => Boolean((await notesHostCall({ op: "status" }, 10_000))?.connected),
        ),
        connect: async () => Boolean((await notesHostCall({ op: "connect" }, 330_000))?.connected),
      },
    }
  : {};
// Word online: the app folder through main's Graph proxy (T30). Connected once the student's
// Microsoft sign-in granted Files.ReadWrite.AppFolder. graphHost is defined below; called later.
notesRemotes.microsoft = microsoftRemote(
  (request) => graphHost.transport(request),
  async () => graphScopes.includes("Files.ReadWrite.AppFolder"),
);
const notes = createNotesService({ store, runner: generationRunner, remotes: notesRemotes });
// end owner: notes
const core = createCore(store, {
  fixture: captureBatchSchema.parse(fixture),
  courseExtractor: createLocalCourseExtractor(),
  planningPublicClient: publicClients.core, // owner: T06
  jobs: pipelineJobRegistry(), // owner: pipeline: passages, links and facts, the course pass
  madgrades: { read: (request, signal) => hostRead("madgrades-read", { request }, signal) },
  planningHttp: { read: (request, signal) => hostRead("planning-public-read", { request }, signal) },
  seams: { learning: createLearningRouter({
    store: store.learning,
    resolveContext: (resourceId): StudyContext | null => resolveStudyContext(resourceId),
    // owner: analytics. One references port per analytics request, over the coursework store.
    // owner: pipeline: the material pipeline's adapter (it reuses analytics' adapter for exam dates
    // and course-map assessment rows).
    analyticsReferences: () => createPipelineReferences(store),
    // end owner: analytics
  }), pack: generation.pack /* owner: generation */, notes /* owner: notes */ },
  ...(process.env.MAGIC_GATEWAY_URL
    ? {
        gateway: {
          evaluate(payload: any, signal: AbortSignal) {
            const id = randomUUID();
            return new Promise<any>((resolve, reject) => {
              const cancel = () => {
                port.postMessage({ kind: "abort", id });
                pending.delete(id);
                reject(new Error("Cancelled"));
              };
              signal.addEventListener("abort", cancel, { once: true });
              pending.set(id, {
                resolve(value) {
                  signal.removeEventListener("abort", cancel);
                  resolve(value);
                },
                reject(error) {
                  signal.removeEventListener("abort", cancel);
                  reject(error);
                },
              });
              port.postMessage({ kind: "evaluate", id, payload });
            });
          },
        },
      }
    : {}),
});
const local = createLocalService(store, core);
const resolveStudyContext = createStudyContextResolver(store, core);
const hostRequests = new Map<
  string,
  { resolve(value: any): void; reject(error: Error): void }
>();
function hostRead(
  kind: string,
  payload: unknown,
  signal?: AbortSignal,
  timeoutMs = 60_000, // owner: planning-perf: planning refresh passes its longer budget
): Promise<any> {
  signal?.throwIfAborted();
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const abort = () => {
      finish();
      hostRequests.delete(id);
      port.postMessage({ kind: "source-abort", id });
      reject(new Error("Read cancelled"));
    };
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    hostRequests.set(id, {
      resolve(value) {
        finish();
        resolve(value);
      },
      reject(error) {
        finish();
        reject(error);
      },
    });
    port.postMessage({ kind, id, payload });
  });
}
function sourceFetch(service: string) {
  return async (url: string, init?: RequestInit) => {
    const value = await hostRead(
      "source-fetch",
      { service, url },
      init?.signal ?? undefined,
    );
    const response = new Response(
      [204, 205, 304].includes(value.status) ? null : value.body,
      { status: value.status, headers: value.headers },
    );
    Object.defineProperty(response, "url", { value: value.url });
    return response;
  };
}
const {
  MAGIC_PDFTOPPM_PATH: pdftoppmPath,
  MAGIC_TESSERACT_PATH: tesseractPath,
  MAGIC_TESSDATA_DIRECTORY: tessdataDirectory,
} = process.env;
const tesseract =
  pdftoppmPath && tesseractPath && tessdataDirectory
    ? createLocalOcrAdapter({ pdftoppmPath, tesseractPath, tessdataDirectory })
    : undefined; // owner: acquisition: also the background OCR's fallback
const extractor = createLocalDocumentExtractor(tesseract ? { ocr: tesseract } : {});
// owner: T30. Microsoft Graph through main's proxy: this process never sees a token. Main says
// which scopes the student granted; the delta links live in main's encrypted vault.
let graphScopes: string[] = [];
const graphHost = {
  transport: async (request: import("../../../packages/connectors/src/graph").GraphRequest) => {
    const { signal, ...payload } = request;
    const value = await hostRead("source-fetch", { service: "graph", ...payload }, signal);
    return {
      status: Number(value?.status) || 0,
      headers: (value?.headers ?? {}) as Record<string, string>,
      body: typeof value?.body === "string" ? value.body : "",
    };
  },
  state: {
    get: async (key: string) =>
      ((await hostRead("graph-state", { operation: "get", key })) as string | undefined) || undefined,
    set: async (key: string, value: string | null) => {
      await hostRead("graph-state", { operation: "set", key, value });
    },
  },
  scopes: () => graphScopes,
  onSynced: (result: unknown) => port.postMessage({ kind: "graph-synced", payload: result }),
};
// end owner: T30
const ingestion = createIngestion(store, {
  directory: dirname(process.env.MAGIC_DB_PATH!),
  extractor,
  client: publicClients.ingestion, // owner: T06
  canvasFetch: sourceFetch("canvas"),
  gitlabFetch: sourceFetch("gitlab"),
  onSaved: (sourceId) => void core.saved(sourceId), // owner: T05b: save → enqueue
  spaceFetch: sourceFetch("space"), // owner: T05b: D41 access check
  graph: graphHost, // owner: T30
  secrets: (operation, key, value) =>
    hostRead("source-secret", { operation, key, value }),
  // owner: acquisition: main's session file route and the extraction threads exist here.
  acquisition: ACQUISITION_APP,
  ...(tesseract ? { ocr: tesseract } : {}),
  extractWorkerScript: join(__dirname, "extract-worker.cjs"),
});
// owner: drain. The app's one job drain is core's pipeline loop: every job kind (passages, links
// and facts, the course pass, Jev's enrich.resource) in bounded idle slices. A sync aborts the
// slice between jobs and nothing is leased until it ends; presence sets the slice size.
const pipeline = core.pipeline;
const syncTick = ingestion.tick;
ingestion.tick = (trigger) => {
  pipeline.syncStarted();
  const run = syncTick(trigger);
  void run.finally(() => pipeline.syncEnded()).catch(() => {});
  return run;
};
const pipelineTimer = setInterval(() => pipeline.wake(), 60_000);
pipelineTimer.unref();
const pipelineBackfill = setTimeout(() => void pipeline.backfill().then(() => pipeline.wake()), 20_000);
pipelineBackfill.unref();
// end owner: pipeline
const planningPublicClient = publicClients.planning; // owner: T06
let planningAccountScope = /^uw-session:[a-f0-9-]{36}$/.test(process.env.MAGIC_PLANNING_SCOPE ?? "")
  ? process.env.MAGIC_PLANNING_SCOPE! : `uw-session:${randomUUID()}`;
let planningGeneration = 0;
let planningRun: { controller: AbortController; promise: Promise<void> } | undefined;
let planningPresent = false, planningAddDrop: PlanningAddDropWindow | null = null; // owner: planning-perf
function cancelPlanning() {
  planningGeneration++;
  planningRun?.controller.abort();
}

function refreshPlanning(trigger: "manual" | "scheduled" = "manual"): Promise<void> {
  // owner: planning-perf. Incremental: stored complete DARS reports are reconfirmed without a
  // download, term-fresh public reads are skipped, a slow sync keeps what arrived, and each
  // sync's captures are written in one transaction.
  if (planningRun && !planningRun.controller.signal.aborted) return planningRun.promise;
  const generation = planningGeneration;
  const controller = new AbortController();
  const signal = controller.signal;
  const accountScope = planningAccountScope;
  const live = () => {
    signal.throwIfAborted();
    if (generation !== planningGeneration) throw new Error("Planning refresh cancelled");
  };
  const save = (capture: PlanningCapture) => {
    live();
    store.ingestPlanning(planningCaptureSchema.parse(capture));
  };
  const saveBatch = (captures: PlanningCapture[]) => {
    live();
    if (captures.length) store.ingestPlanningBatch(captures.map((capture) => planningCaptureSchema.parse(capture)));
  };
  // One source by its ID, never a scan of every source.
  const observedAt = (source: PlanningCapture["source"], scope: PlanningCapture["scope"], account: string) => {
    const previous = store.planningSource(planningSourceId(source, account, scope));
    return new Date(Math.max(Date.now(), previous ? Date.parse(previous.observedAt) + 1 : 0)).toISOString();
  };
  const nowIso = new Date().toISOString();
  const termFresh = (scope: PlanningCapture["scope"]) =>
    publicSourceTermFresh(store.planningSource(planningSourceId("uw_public", "public", scope)), nowIso);
  const promise = Promise.all([
    (async () => {
      let result: UwPlanningSyncResult;
      const hints = { storedAudits: storedAuditReports(store), freshSubjects: termFreshSearchSubjects(store, nowIso) ?? undefined, scheduled: trigger === "scheduled" };
      try { result = await hostRead("planning-refresh", hints, signal, PLANNING_WORKER_TIMEOUT_MS); }
      catch {
        signal.throwIfAborted();
        result = { captures: [], invalidated: ["uw_enroll", "uw_myuw", "uw_dars"].map((source) => ({ source: source as "uw_enroll" | "uw_myuw" | "uw_dars", status: "failed", code: "refresh_failed" })) };
      }
      signal.throwIfAborted();
      if (result.addDrop !== undefined) planningAddDrop = result.addDrop;
      const reconfirmed = reconfirmedAuditCaptures(store, result.reconfirmed ?? [], new Date().toISOString());
      const refreshed = new Set([...result.captures, ...reconfirmed].map((capture) => JSON.stringify([capture.source, capture.accountScope, capture.scope])));
      const batch: PlanningCapture[] = [];
      const privateSources = result.invalidated.length ? store.planningSources().filter((source) => source.accountScope !== "public") : [];
      for (const invalid of result.invalidated) {
        for (const previous of privateSources.filter((source) => source.source === invalid.source)) {
          if (refreshed.has(JSON.stringify([previous.source, previous.accountScope, previous.scope]))) continue;
          batch.push({ schemaVersion: 1, id: randomUUID(), source: previous.source, accountScope: previous.accountScope,
            scope: previous.scope, sourceUrl: previous.sourceUrl,
            observedAt: observedAt(previous.source, previous.scope, previous.accountScope),
            status: invalid.status, completeness: "unknown", records: [],
            diagnostics: [{ code: invalid.code, message: "This service could not verify the saved evidence during refresh. Saved records remain available but need verification." }],
          });
        }
      }
      saveBatch([...batch, ...reconfirmed, ...result.captures]);
    })(),
    (async () => {
      const scope = { kind: "subjects" as const, key: "registrar-subjects" };
      if (termFresh(scope)) return;
      try {
        save(await pullPublicSubjects(planningPublicClient, observedAt("uw_public", scope, "public"), signal));
      } catch {
        signal.throwIfAborted();
        save({ schemaVersion: 1, id: randomUUID(), accountScope: "public", source: "uw_public", scope,
          sourceUrl: "https://registrar.wisc.edu/subjectareas/", observedAt: observedAt("uw_public", scope, "public"),
          status: "failed", completeness: "unknown", records: [],
          diagnostics: [{ code: "registrar_subjects_unavailable", message: "The public Registrar subject list could not be read. Saved subjects were retained." }],
        });
      }
    })(),
    (async () => {
      const scope = { kind: "terms" as const, key: "registrar-session-terms" };
      if (termFresh(scope)) return;
      try {
        save(await pullPublicTerms(planningPublicClient, observedAt("uw_public", scope, "public"), signal));
      } catch {
        signal.throwIfAborted();
        save({ schemaVersion: 1, id: randomUUID(), accountScope: "public", source: "uw_public", scope,
          sourceUrl: "https://registrar.wisc.edu/sessioncodes/", observedAt: observedAt("uw_public", scope, "public"),
          status: "failed", completeness: "unknown", records: [],
          diagnostics: [{ code: "registrar_terms_unavailable", message: "The public Registrar session table could not be read. Saved terms were retained." }],
        });
      }
    })(),
  ]).then(() => {});
  const run = { controller, promise };
  planningRun = run;
  void promise.finally(() => { if (planningRun === run) planningRun = undefined; }).catch(() => {});
  return promise;
}
// owner: planning-perf. Scheduled planning refresh, gated on presence like ingestion: weekly during
// add/drop (or when the window is unknown), once per term otherwise; the button stays manual.
const planningCadence = setInterval(() => {
  if (!planningPresent || planningRun) return;
  if (!planningRefreshDue(store, new Date().toISOString(), planningAddDrop)) return;
  void refreshPlanning("scheduled").catch(() => {});
}, 10 * 60_000);
planningCadence.unref();
// end owner: planning-perf
const refreshTimer = setInterval(() => {
  void ingestion.tick();
}, 30_000);
refreshTimer.unref();
const tick = setInterval(() => core.wake(), 30000);
tick.unref();
// owner: notes. The rolling window's scaffolds (skipped when nothing changed) and the sync check.
function notesTick() {
  try {
    notes.refresh();
  } catch (error) {
    console.error("Notes refresh failed:", error instanceof Error ? error.name : "unknown");
  }
  notes.syncTick().catch((error) => console.error("Notes sync failed:", error instanceof Error ? error.name : "unknown"));
}
const notesTimer = setInterval(notesTick, 30_000);
notesTimer.unref();
// end owner: notes
port.on("message", async ({ data }: { data: any }) => {
  if (data.kind === "source-response") {
    const request = hostRequests.get(data.id);
    hostRequests.delete(data.id);
    if (data.error) request?.reject(new Error("Source read unavailable"));
    else request?.resolve(data.result);
    return;
  }
  if (data.kind === "suspend") {
    cancelPlanning();
    ingestion.suspend();
    pipeline.suspend(); // owner: pipeline
    return;
  }
  if (data.kind === "resume") {
    ingestion.resume();
    pipeline.resume(); // owner: pipeline
    return;
  }
  if (data.kind === "presence") {
    // Main's signal: OS input within 30 minutes and the screen unlocked. Gates signed-in reads.
    ingestion.presence(data.present === true);
    pipeline.presence(data.present === true); // owner: pipeline
    planningPresent = data.present === true; // owner: planning-perf
    return;
  }
  // owner: pipeline. Graph reads: references, the agenda, a course's graph and coverage.
  if (data.kind === "graph") {
    try {
      const query = graphQuerySchema.parse(data.query);
      const result =
        query.type === "references"
          ? references(store, query.assignmentId)
          : query.type === "agenda"
            ? agenda(store, { date: query.date, tz: query.tz, ...(query.days ? { days: query.days } : {}) })
            : courseGraph(store, { accountScope: query.accountScope, courseId: query.courseId });
      port.postMessage({ kind: "response", id: data.id, result });
    } catch (error) {
      port.postMessage({
        kind: "response",
        id: data.id,
        error: error instanceof Error && error.name !== "ZodError" ? error.message : "The graph query did not match its schema.",
      });
    }
    return;
  }
  // end owner: pipeline
  // owner: T33. App focus runs the content probe on the next tick (D37).
  if (data.kind === "focus") {
    ingestion.focus();
    return;
  }
  // end owner: T33
  // owner: T30. The granted Graph scopes (never a token); an empty list stops the Graph step.
  if (data.kind === "graph-scopes") {
    graphScopes = Array.isArray(data.scopes)
      ? data.scopes.filter((s: unknown): s is string => typeof s === "string" && s.length < 100).slice(0, 20)
      : [];
    return;
  }
  // end owner: T30
  if (data.kind === "reconnected") {
    ingestion.reconnected();
    return;
  }
  if (data.kind === "refresh-cancel") {
    ingestion.cancel();
    return;
  }
  if (data.kind === "planning-cancel") {
    cancelPlanning();
    return;
  }
  if (data.kind === "planning-scope") {
    cancelPlanning();
    if (typeof data.accountScope === "string" && /^uw-session:[a-f0-9-]{36}$/.test(data.accountScope))
      planningAccountScope = data.accountScope;
    return;
  }
  if (data.kind === "planning-sync") {
    try {
      await refreshPlanning();
      port.postMessage({ kind: "response", id: data.id, result: {
        ...(await core.execute({ type: "snapshot" })),
        message: "Planning sources checked. Each source shows what was verified and what still needs attention.",
      } });
    } catch {
      port.postMessage({ kind: "response", id: data.id, error: "Planning refresh interrupted. Saved planning records are still available." });
    }
    return;
  }
  if (data.kind === "refresh") {
    try {
      await ingestion.tick("manual");
      port.postMessage({
        kind: "response",
        id: data.id,
        result: {
          ...(await core.execute({ type: "snapshot" })),
          message:
            "Refresh finished. Source status shows any incomplete reads.",
        },
      });
    } catch {
      port.postMessage({
        kind: "response",
        id: data.id,
        error: "Refresh interrupted. Saved coursework is still available.",
      });
    }
    return;
  }
  if (data.kind === "evaluation") {
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (p) {
      if (data.error) p.reject(judgmentFailureError(data));
      else p.resolve(data.result);
    }
    return;
  }
  if (data.kind === "shutdown") {
    cancelPlanning();
    await planningRun?.promise.catch(() => {});
    clearInterval(refreshTimer);
    // owner: pipeline
    clearInterval(pipelineTimer);
    clearTimeout(pipelineBackfill);
    await pipeline.stop();
    // end owner: pipeline
    clearInterval(planningCadence); // owner: planning-perf
    await ingestion.stop();
    clearInterval(tick);
    clearInterval(notesTimer); // owner: notes
    local.cancel();
    await core.close();
    port.postMessage({ kind: "closed" });
    return;
  }
  if (data.kind === "local-cancel") {
    local.cancel(data.id);
    return;
  }
  if (data.kind === "local") {
    try {
      if (data.operation !== "status" && data.operation !== "ask")
        throw new Error("Invalid local operation");
      const result =
        data.operation === "status"
          ? await local.status(data.id)
          : await local.ask(data.id, data.request);
      port.postMessage({ kind: "local-response", id: data.id, result });
    } catch (error) {
      port.postMessage({
        kind: "local-response",
        id: data.id,
        error:
          error instanceof Error &&
          error.name !== "ZodError" &&
          error.name !== "AbortError"
            ? error.message
            : "Local AI was cancelled or the request was invalid.",
      });
    }
    return;
  }
  // owner: T15. Scoped queries (O1): a read with its own small payload.
  if (data.kind === "query") {
    try {
      port.postMessage({
        kind: "response",
        id: data.id,
        result: core.query(queryRequestSchema.parse(data.query)),
      });
    } catch (error) {
      port.postMessage({
        kind: "response",
        id: data.id,
        error:
          error instanceof Error && error.name !== "ZodError"
            ? error.message
            : "The query did not match the workspace schema.",
      });
    }
    return;
  }
  // end owner: T15
  if (data.kind !== "command") return;
  if (data.command?.type === "purge") {
    cancelPlanning();
    await planningRun?.promise.catch(() => {});
    ingestion.suspend();
    pipeline.suspend(); // owner: pipeline
    await ingestion.tick();
  }
  if (["import", "planning-import", "fixture", "privacy", "purge", "course-override"].includes(data.command?.type)) {
    local.cancel();
  }
  try {
    port.postMessage({
      kind: "response",
      id: data.id,
      result: await core.execute(data.command),
    });
    if (data.command?.type === "purge") {
      ingestion.resume();
      pipeline.resume(); // owner: pipeline
    }
  } catch (error) {
    port.postMessage({
      kind: "response",
      id: data.id,
      error:
        error instanceof Error && error.name !== "ZodError"
          ? error.message
          : "The request did not match the workspace schema.",
    });
  }
});
core.wake();
port.postMessage({ kind: "ready" });
setTimeout(notesTick, 0); // owner: notes
