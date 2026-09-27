import { judgmentFailureError } from "./judgment-errors";
import { createLocalCourseExtractor } from "@magic/ai";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema, planningCaptureSchema, type PlanningCapture } from "@magic/contracts";
import { queryRequestSchema } from "@magic/contracts"; // owner: T15
import fixture from "../../../fixtures/course.json";
import { randomUUID } from "node:crypto";
import { createLocalService } from "./local-service";
import { createIngestion } from "./ingestion";
import { createLearningRouter, type StudyContext } from "../../../packages/learning/src/router";
import { createStudyContextResolver } from "./learning-context";
import { dirname } from "node:path";
import {
  createLocalDocumentExtractor,
  createLocalOcrAdapter,
} from "../../../packages/connectors/src/documents";
import { createWorkerClients } from "./worker-clients"; // owner: T06
import { pullPublicSubjects, pullPublicTerms } from "../../../packages/connectors/src/planning-public";
import type { UwPlanningSyncResult } from "../../../packages/connectors/src/uw-planning-sync";
// owner: pipeline
import { pipelineJobRegistry } from "../../../packages/core/src/jobs/default-registry";
import { createPipelineLoop } from "../../../packages/core/src/jobs/pipeline";
import { agenda, courseGraph, createPipelineReferences, references } from "../../../packages/core/src/graph/index";
import { graphQuerySchema } from "../../../packages/contracts/src/course-core";
// end owner: pipeline
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
// owner: intent. The command bar's router. Claude answers through a warm session pool (lane
// interactive:intent, tools off, the byte-stable catalogue prefix) so the AI fallback skips the
// CLI's start-up after the first call; Codex stays one-shot (its app-server is unmeasured, S9).
import { createIntentRouter } from "../../../packages/core/src/intent/index";
import { createModelRunner, createSessionPool, type SessionPool } from "../../../packages/runner/src/index";
import { askPack, classifyPack } from "../../../packages/packs/intent/src/index";
let intentRuntime: { client: string; runner: ModelRunner; pool: SessionPool | null } | null = null;
async function intentRunner(): Promise<ModelRunner | null> {
  const { chosen } = await readClientSettings(generationUserData);
  if (!chosen || !isIsolated(chosen) || !(await isProfileReady(chosen, generationUserData))) return null;
  if (intentRuntime?.client === chosen) return intentRuntime.runner;
  await intentRuntime?.pool?.close();
  intentRuntime = null;
  if (chosen !== "claude") {
    const runner = await generationRunner();
    if (runner) intentRuntime = { client: chosen, runner, pool: null };
    return runner;
  }
  const command = resolveClient(chosen, { userData: generationUserData });
  if (!command) return null;
  const env = Object.fromEntries(
    Object.entries(profileEnv(chosen, { userData: generationUserData })).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])),
  );
  const options = { command, workDir: workDir(generationUserData, chosen), env };
  const pool = createSessionPool({ ...options, fallback: createClaudeBackend(options), kinds: { [classifyPack.id]: classifyPack.schema, [askPack.id]: askPack.schema } });
  intentRuntime = { client: chosen, runner: createModelRunner({ backend: pool }), pool };
  return intentRuntime.runner;
}
// prewarm (the bar opened) finds the client, then starts its pooled session with the catalogue prefix.
const intent = createIntentRouter({ store, runner: intentRunner, warm: (request) => intentRuntime?.pool?.warm(request) ?? Promise.resolve(false) });
// end owner: intent
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
  }), pack: generation.pack /* owner: generation */, intent /* owner: intent */ },
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
    const timer = setTimeout(abort, 60_000);
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
const extractor = createLocalDocumentExtractor(
  pdftoppmPath && tesseractPath && tessdataDirectory
    ? {
        ocr: createLocalOcrAdapter({
          pdftoppmPath,
          tesseractPath,
          tessdataDirectory,
        }),
      }
    : {},
);
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
});
// owner: pipeline. The material pipeline's drain: code-only jobs (passages, links and facts, the
// course pass) in bounded idle slices. A sync aborts the slice between jobs and wakes it when done;
// presence sets the slice size. Nothing here calls Jev or a model, and planning is never queued.
const pipeline = createPipelineLoop({ store, registry: core.jobs });
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
function cancelPlanning() {
  planningGeneration++;
  planningRun?.controller.abort();
}

function refreshPlanning(): Promise<void> {
  if (planningRun && !planningRun.controller.signal.aborted) return planningRun.promise;
  const generation = planningGeneration;
  const controller = new AbortController();
  const signal = controller.signal;
  const accountScope = planningAccountScope;
  const save = (capture: PlanningCapture) => {
    signal.throwIfAborted();
    if (generation !== planningGeneration) throw new Error("Planning refresh cancelled");
    store.ingestPlanning(planningCaptureSchema.parse(capture));
  };
  const observedAt = (source: PlanningCapture["source"], scope: PlanningCapture["scope"], account: string) => {
    const previous = store.planningSources().find((entry) => entry.source === source && entry.accountScope === account && entry.scope.kind === scope.kind && entry.scope.key === scope.key);
    return new Date(Math.max(Date.now(), previous ? Date.parse(previous.observedAt) + 1 : 0)).toISOString();
  };
  const promise = Promise.all([
    (async () => {
      let result: UwPlanningSyncResult;
      try { result = await hostRead("planning-refresh", {}, signal); }
      catch {
        signal.throwIfAborted();
        result = { captures: [], invalidated: ["uw_enroll", "uw_myuw", "uw_dars"].map((source) => ({ source: source as "uw_enroll" | "uw_myuw" | "uw_dars", status: "failed", code: "refresh_failed" })) };
      }
      signal.throwIfAborted();
      const refreshed = new Set(result.captures.map((capture) => JSON.stringify([capture.source, capture.accountScope, capture.scope])));
      for (const invalid of result.invalidated) {
        for (const previous of store.planningSources().filter((source) => source.source === invalid.source && source.accountScope !== "public")) {
          if (refreshed.has(JSON.stringify([previous.source, previous.accountScope, previous.scope]))) continue;
          save({ schemaVersion: 1, id: randomUUID(), source: previous.source, accountScope: previous.accountScope,
            scope: previous.scope, sourceUrl: previous.sourceUrl,
            observedAt: observedAt(previous.source, previous.scope, previous.accountScope),
            status: invalid.status, completeness: "unknown", records: [],
            diagnostics: [{ code: invalid.code, message: "This service could not verify the saved evidence during refresh. Saved records remain available but need verification." }],
          });
        }
      }
      for (const capture of result.captures) save(capture);
    })(),
    (async () => {
      const scope = { kind: "subjects" as const, key: "registrar-subjects" };
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
const refreshTimer = setInterval(() => {
  void ingestion.tick();
}, 30_000);
refreshTimer.unref();
const tick = setInterval(() => core.wake(), 30000);
tick.unref();
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
    await intentRuntime?.pool?.close(); // owner: intent
    cancelPlanning();
    await planningRun?.promise.catch(() => {});
    clearInterval(refreshTimer);
    // owner: pipeline
    clearInterval(pipelineTimer);
    clearTimeout(pipelineBackfill);
    await pipeline.stop();
    // end owner: pipeline
    await ingestion.stop();
    clearInterval(tick);
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
