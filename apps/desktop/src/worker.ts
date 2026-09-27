import { judgmentFailureError } from "./judgment-errors";
import { createLocalCourseExtractor } from "@magic/ai";
import { createStore } from "@magic/storage";
import { deriveInstallKeys } from "../../../packages/core/src/privacy/at-rest"; // owner: privacy
import { configurePseudonymKey } from "../../../packages/core/src/privacy/pseudonyms"; // owner: privacy
import { logLine } from "../../../packages/core/src/privacy/log"; // owner: privacy
import { createCore } from "@magic/core";
import { captureBatchSchema, planningCaptureSchema, type PlanningCapture } from "@magic/contracts";
import { queryRequestSchema } from "@magic/contracts"; // owner: T15
import type { MailTriageState, MessageTriageState } from "@magic/contracts"; // owner: notifications gateway relay
import fixture from "../../../fixtures/course.json";
import { randomUUID } from "node:crypto";
import { createLocalService } from "./local-service";
import { createIngestion, ACQUISITION_APP } from "./ingestion";
import { createLearningRouter, type StudyContext } from "../../../packages/learning/src/router";
import { createStudyContextResolver } from "./learning-context";
import { createExamEvidence } from "../../../packages/learning/src/exam/evidence"; // owner: exam-prep
import { dirname, join } from "node:path";
import {
  createLocalDocumentExtractor,
  createLocalOcrAdapter,
} from "../../../packages/connectors/src/documents";
import { createWorkerClients } from "./worker-clients"; // owner: T06
import { pullPublicSubjects, pullPublicTerms } from "../../../packages/connectors/src/planning-public";
import type { UwPlanningSyncResult } from "../../../packages/connectors/src/uw-planning-sync";
// owner: pipeline
import { appJobRegistry } from "../../../packages/core/src/jobs/default-registry";
// owner: agenda. D49: the critical-action agenda's background job, correction and narration.
import { correctAgendaEstimate, invalidateAgenda, narrateAgenda, registerAgendaJobs } from "../../../packages/core/src/priority/index";
// end owner: agenda
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
// owner: privacy: a v14 backup that failed its check is kept; say why (redacted), never silently.
const backupCheck = store.backupCheck();
if (backupCheck?.status === "kept") process.stderr.write(logLine({ event: "privacy.backup-kept", reason: backupCheck.reason }));
// owner: T06: every direct public client refuses until the setup consent record exists.
const publicClients = createWorkerClients(store);
// end owner: T06
// owner: generation. The pack runner: the student's chosen client in its app-owned profile
// (CLAUDE_CONFIG_DIR / CODEX_HOME), tools off, our system prompt, the background budget, and
// the SQLite pack stores. No client connected: the pack command answers "Connect your AI first".
import { createClaudeBackend, createCodexBackend, type ModelRunner } from "../../../packages/runner/src/index";
import { createPackRuntime, DEFAULT_PACK_CONFIG } from "../../../packages/packs/core/src/index";
import { createPackHandler } from "../../../packages/core/src/pack-handler";
import { APPROACH_PACK, createApproachHandler } from "../../../packages/core/src/views/index"; // owner: page-views
import type { PackScope } from "@magic/contracts"; // owner: page-views
import { isIsolated, isProfileReady, profileEnv, readClientSettings, resolveClient, workDir } from "./clients/profiles";
const generationUserData = dirname(process.env.MAGIC_DB_PATH!);
// owner: client-health (D50). Every generation path (packs and guides, notes, the intent router)
// runs the chosen client in its saved mode: instant by default (the student's own signed-in
// Claude Code or Codex, the app's configuration passed as flags only), the D45 profile only when
// the student opted in, or Gemini with the student's key, asked from main's vault for each build
// and never logged. Health is checked before every run, so a signed-out, limited or offline
// client fails with its own typed error instead of a generic one.
import { clientBackend, clientRunOptions, healthGatedBackend, type CliRunOptions } from "./clients/health";
import { modeOf } from "./clients/instant";
import type { ClientId } from "@magic/contracts";
async function isolatedOptions(id: "claude" | "codex"): Promise<CliRunOptions | null> {
  if (!isIsolated(id) || !(await isProfileReady(id, generationUserData))) return null;
  const command = resolveClient(id, { userData: generationUserData });
  if (!command) return null;
  const env = Object.fromEntries(
    Object.entries(profileEnv(id, { userData: generationUserData })).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])),
  );
  return { command, workDir: workDir(generationUserData, id), env };
}
async function geminiKey(): Promise<string | undefined> {
  const reply = (await hostRead("ai-key", { provider: "gemini" }, undefined, 10_000).catch(() => null)) as { key?: unknown } | null;
  return typeof reply?.key === "string" && reply.key ? reply.key : undefined;
}
/** The chosen client, and a cache key that changes with its mode so a switch rebuilds the runner. */
async function chosenClient(): Promise<{ id: ClientId; key: string } | null> {
  const { chosen } = await readClientSettings(generationUserData);
  return chosen ? { id: chosen, key: `${chosen}:${await modeOf(chosen, generationUserData)}` } : null;
}
let generationRuntime: { client: string; runner: ModelRunner } | null = null;
async function generationRunner(): Promise<ModelRunner | null> {
  const chosen = await chosenClient();
  if (!chosen) return null;
  if (generationRuntime?.client === chosen.key) return generationRuntime.runner;
  // owner: ai-paths. Claude runs through the warm session pool (one per worker, replaced on a
  // client change); Codex stays one-shot.
  const { pooledClaudeBackend } = await import("../../../packages/core/src/pack-handler");
  // end owner: ai-paths
  const built = await clientBackend(
    chosen.id,
    { userData: generationUserData, geminiKey },
    { claude: pooledClaudeBackend, codex: createCodexBackend },
    () => (chosen.id === "gemini" ? Promise.resolve(null) : isolatedOptions(chosen.id)),
  ).catch(() => null); // Gemini without a key: "Connect your AI first", and nothing is sent.
  if (!built) return null;
  generationRuntime = { client: chosen.key, runner: createPackRuntime(built.backend, DEFAULT_PACK_CONFIG).runner };
  return generationRuntime.runner;
}
// end owner: client-health
// owner: client-detection. main's extended PATH (the login shell's folders and the known install
// folders), sent once after launch; runners built afterwards find the client and its node.
port.on("message", ({ data }: { data: any }) => {
  if (data?.kind !== "client-path" || typeof data.path !== "string" || data.path.length > 32_768) return;
  process.env.PATH = data.path;
  generationRuntime = null;
});
// end owner: client-detection
// owner: course-facts. The course brief, `<userData>/courses/<course>/syllabus.md`: the first,
// byte-identical block of every pack and guide prompt about the course.
import { createCourseBriefs } from "../../../packages/core/src/course-facts/brief";
const courseBriefs = createCourseBriefs({ store, directory: generationUserData });
// end owner: course-facts
const generation = createPackHandler({ store, runner: generationRunner, brief: courseBriefs.courseBrief /* owner: course-facts */ });
// end owner: generation
// owner: page-views. The "page-approach" pack (the pages' optional "how to approach it"
// paragraph) answers through the same pack seam; every other pack name goes on unchanged.
{
  const approach = createApproachHandler({ store, runner: generationRunner });
  const packs = generation.pack;
  Object.assign(generation, {
    pack: (name: string, scope: PackScope, signal: AbortSignal): Promise<unknown> =>
      name === APPROACH_PACK ? approach.run(scope, signal) : packs(name, scope, signal),
  });
}
// end owner: page-views
// owner: course-facts. The `course.facts` drain job: code selects each course's syllabus, then the
// student's own client (the generation runner above: isolated profile, tools off, the background
// budget) finds the course facts through the egress path, once per syllabus change. No client, or
// fully local mode: the local (Ollama) extractor. It replaces core's Ollama-only course pass.
// It registers on the shared job registry below (`jobs`), beside agenda and site-recipes.
import { createCourseFactsJob } from "../../../packages/core/src/course-facts/index";
// end owner: course-facts
/** Jev judgments run in main (network + consent gate); the reply arrives as "evaluation". */
function relayJudgment(
  message:
    | { kind: "evaluate"; payload: unknown }
    | { kind: "triage"; state: MessageTriageState }
    | { kind: "mailTriage"; state: MailTriageState },
  signal: AbortSignal,
): Promise<any> {
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
    port.postMessage({ ...message, id });
  });
}
// owner: intent. The command bar's router. Claude answers through a warm session pool (lane
// interactive:intent, tools off, the byte-stable catalogue prefix) so the AI fallback skips the
// CLI's start-up after the first call; Codex stays one-shot (its app-server is unmeasured, S9).
import { createIntentRouter, fromNotes, type NotesSeam } from "../../../packages/core/src/intent/index";
import { notesActions } from "../../../packages/notes/src/actions";
import { notesRequestSchema } from "@magic/contracts";
import { createModelRunner, createSessionPool, type SessionPool } from "../../../packages/runner/src/index";
import { askPack, classifyPack } from "../../../packages/packs/intent/src/index";
let intentRuntime: { client: string; runner: ModelRunner; pool: SessionPool | null } | null = null;
async function intentRunner(): Promise<ModelRunner | null> {
  // owner: client-health: the chosen client in its saved mode (instant by default), health-gated.
  const chosen = await chosenClient();
  if (!chosen) return null;
  if (intentRuntime?.client === chosen.key) return intentRuntime.runner;
  await intentRuntime?.pool?.close();
  intentRuntime = null;
  if (chosen.id !== "claude") {
    const runner = await generationRunner();
    if (runner) intentRuntime = { client: chosen.key, runner, pool: null };
    return runner;
  }
  const run = await clientRunOptions("claude", { userData: generationUserData }, () => isolatedOptions("claude"));
  if (!run) return null;
  const options = run.options;
  // end owner: client-health
  const pool = createSessionPool({ ...options, fallback: createClaudeBackend(options), kinds: { [classifyPack.id]: classifyPack.schema, [askPack.id]: askPack.schema } });
  intentRuntime = { client: chosen.key, runner: createModelRunner({ backend: healthGatedBackend(pool, run.check) }), pool }; // owner: client-health: gated
  return intentRuntime.runner;
}
// prewarm (the bar opened) finds the client, then starts its pooled session with the catalogue prefix.
// The notes lane's plain actions (packages/notes/src/actions.ts) run through the notes service,
// which is created below; the seam reads it at call time.
const intentNotes: NotesSeam = {
  handle: (request, signal) => notes.handle(notesRequestSchema.parse(request), signal),
  sessionOn: (courseId, date, type) => notes.sessionOn(courseId, date, type === "discussion" || type === "lab" ? type : "lecture"),
};
let intentIndexScheduled = false;
const intent = createIntentRouter({
  store,
  runner: intentRunner,
  actions: fromNotes({ notesActions }, intentNotes),
  warm: (request) => intentRuntime?.pool?.warm(request) ?? Promise.resolve(false),
  coursePrefix: generation.coursePrefix, // owner: course-facts: a one-course ask opens with the course prefix
});
// end owner: intent
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
// owner: agenda. The app's registry (owner: drain: only kinds that need a queue) plus agenda.estimate:
// code estimates, then the student's own client on the background lane (one call per course
// change, cached per text hash).
const jobs = appJobRegistry();
registerAgendaJobs(jobs, { runner: generationRunner });
// end owner: agenda
jobs.register(createCourseFactsJob({ runner: generationRunner, local: createLocalCourseExtractor(), brief: courseBriefs.courseBrief })); // owner: course-facts
// owner: site-recipes (D32 step 4). A crawled course-site page saved or changed → organize that
// course's stored site pages: stored recipes replay as code; only a new layout calls the
// student's client (background lane, consent and receipts); leftovers go to Jev when configured.
import { siteRecipeJob } from "../../../packages/core/src/site-recipes";
import { createSiteTriage } from "../../../packages/core/src/site-triage";
// Host triage before any crawl: code from Canvas evidence, one batched call for ambiguous hosts.
const siteTriage = createSiteTriage({ store, runner: generationRunner });
jobs.register(
  siteRecipeJob({
    runner: generationRunner,
    onSaved: (sourceId) => void core.saved(sourceId),
    ...(process.env.MAGIC_GATEWAY_URL
      ? { jev: { evaluate: (payload, signal) => relayJudgment({ kind: "evaluate", payload }, signal) } }
      : {}),
  }),
);
// end owner: site-recipes
const core = createCore(store, {
  fixture: captureBatchSchema.parse(fixture),
  planningPublicClient: publicClients.core, // owner: T06
  // owner: drain. Passages, links and facts and the course pass are reconciled in budgeted batches
  // (jobs/derive.ts), not queued per row; the registry keeps only kinds that need a queue.
  // owner: agenda: agenda.estimate; owner: site-recipes; course-facts adds course.facts (all on `jobs`).
  jobs,
  drain: { derive: true },
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
    coursework: () => store, // owner: mastery: captured Canvas scores for grades and past exams (D57)
    examEvidence: () => createExamEvidence(store), // owner: exam-prep
  }), pack: generation.pack /* owner: generation */, notes /* owner: notes */, intent /* owner: intent */,
    // owner: agenda. Only the estimate subject is built; the others keep core's honest message.
    correct: (value, at) =>
      value.subject === "estimate"
        ? correctAgendaEstimate(store, value, at)
        : "Corrections aren't built yet; nothing was changed.",
    // end owner: agenda
    // owner: site-recipes. Opening an item reads its `read_once` links (the renderer's "open" event).
    uiEvent: (event) => void ingestion.onUiEvent(event),
  },
  ...(process.env.MAGIC_GATEWAY_URL
    ? {
        gateway: {
          evaluate(payload: any, signal: AbortSignal) {
            return relayJudgment({ kind: "evaluate", payload }, signal);
          },
          triage(state: MessageTriageState, signal: AbortSignal) {
            return relayJudgment({ kind: "triage", state }, signal);
          },
          mailTriage(state: MailTriageState, signal: AbortSignal) {
            return relayJudgment({ kind: "mailTriage", state }, signal);
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
  // owner: site-recipes: the crawler reads only hosts triage decided `sync`.
  triage: async (accountScope, courseId, signal) =>
    new Map((await siteTriage.decide({ accountScope, courseId }, signal)).hosts.map((h) => [h.host, h])),
  triageDecisions: (accountScope, courseId) => siteTriage.decisions({ accountScope, courseId }),
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
// Background derivations (the pipeline's reconcile, the notes' scaffolds) never run while a sync
// reads: a sync starting stops them between stretches, and its end lets them continue.
let syncing = 0;
let notesRun: AbortController | undefined;
ingestion.tick = (trigger) => {
  syncing++;
  notesRun?.abort();
  pipeline.syncStarted();
  const run = syncTick(trigger);
  void run
    .finally(() => {
      syncing--;
      pipeline.syncEnded();
    })
    .catch(() => {});
  return run;
};
const pipelineTimer = setInterval(() => pipeline.wake(), 60_000);
pipelineTimer.unref();
const pipelineBackfill = setTimeout(() => void pipeline.backfill().then(() => pipeline.wake()), 20_000);
pipelineBackfill.unref();
// end owner: pipeline
// owner: agenda. After the first sync of each local day, refresh the agenda's why-now lines once
// (cached by the top items' fact hash, so an unchanged agenda costs nothing; a send already in
// flight for the same hash, from the drain, is shared). Unless the lines end current (a paused,
// blocked or unconnected client, or a throw), the day is cleared so the next sync tries again.
let agendaNarratedDay = "";
const agendaSyncTick = ingestion.tick;
ingestion.tick = (trigger) => {
  const run = agendaSyncTick(trigger);
  void run
    .then(async () => {
      const day = new Date().toLocaleDateString("en-CA");
      if (day === agendaNarratedDay) return;
      agendaNarratedDay = day;
      const narrated = await narrateAgenda(store, { runner: generationRunner });
      if (!narrated.current && agendaNarratedDay === day) agendaNarratedDay = "";
    })
    .catch(() => {
      agendaNarratedDay = "";
    });
  return run;
};
// end owner: agenda
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

function refreshPlanning(trigger: "manual" | "scheduled" = "manual", phase?: "enrollment"): Promise<void> {
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
      const hints = { storedAudits: storedAuditReports(store), freshSubjects: termFreshSearchSubjects(store, nowIso) ?? undefined, scheduled: trigger === "scheduled", ...(phase ? { phase } : {}) };
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
// owner: drain. The scaffolds are reconciled incrementally in budgeted stretches, never during a
// sync read (a sync starting aborts the run between stretches; the next tick continues).
async function notesTick() {
  if (!syncing && !notesRun) {
    notesRun = new AbortController();
    try {
      await notes.reconcile({ signal: notesRun.signal });
    } catch (error) {
      console.error("Notes refresh failed:", error instanceof Error ? error.name : "unknown");
    } finally {
      notesRun = undefined;
    }
  }
  notes.syncTick().catch((error) => console.error("Notes sync failed:", error instanceof Error ? error.name : "unknown"));
}
const notesTimer = setInterval(notesTick, 30_000);
notesTimer.unref();
// end owner: notes
// owner: stall-audit. The window re-reads its snapshot only when the workspace changed: once a
// second this compares the store's write count (one statement, no table read) and tells main,
// which forwards `magic:changed` to the window. Idle, nothing is sent and no snapshot is built.
let announcedVersion = store.dataVersion();
const changeWatch = setInterval(() => {
  const version = store.dataVersion();
  if (version === announcedVersion || version < 0) return;
  announcedVersion = version;
  port.postMessage({ kind: "changed" });
}, 1_000);
changeWatch.unref();
// end owner: stall-audit
port.on("message", async ({ data }: { data: any }) => {
  // owner: privacy. Main's install secret: at-rest key for the store, pseudonym key for sends.
  if (data.kind === "privacy-key") {
    const secret = typeof data.secret === "string" ? Buffer.from(data.secret, "base64") : null;
    const keys = secret ? deriveInstallKeys(secret) : null;
    secret?.fill(0);
    configurePseudonymKey(keys?.pseudonym ?? null);
    try {
      // A missing or different key leaves sealed records unopenable: say so (the planning snapshot
      // counts them as unreadable, and the view shows it) instead of reading as clear.
      const { keyMatches } = store.setAtRestKey(keys?.atRest ?? null);
      if (!keys) process.stderr.write(logLine({ event: "privacy.key-unavailable" }));
      else if (!keyMatches) process.stderr.write(logLine({ event: "privacy.key-mismatch" }));
    } catch (error) {
      process.stderr.write(logLine({ event: "privacy.seal-failed", error }));
    }
    keys?.atRest.fill(0);
    keys?.pseudonym.fill(0);
    return;
  }
  // end owner: privacy
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
      // owner: drain. Opening a course derives it next, even a past one while the student is present.
      if (query.type !== "references" && query.type !== "agenda")
        pipeline.prioritize({ accountScope: query.accountScope, courseId: query.courseId });
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
      await refreshPlanning("manual", data.phase === "enrollment" ? "enrollment" : undefined);
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
      // fix/current-courses-only: discovery reads the course lists only; the student then chooses.
      if (data.confirm === true) await ingestion.confirmCourses();
      else if (data.discover === true) await ingestion.discover();
      else await ingestion.tick("manual");
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
    notesRun?.abort(); // owner: drain: an in-flight notes reconcile stops before the store closes
    await pipeline.stop();
    // end owner: pipeline
    clearInterval(planningCadence); // owner: planning-perf
    await ingestion.stop();
    clearInterval(tick);
    clearInterval(notesTimer); // owner: notes
    clearInterval(changeWatch); // owner: stall-audit
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
    // owner: intent. After the first bootstrap query is answered, build the command bar's index
    // in the background turn, so the first command's resolver budget covers matching only.
    if (!intentIndexScheduled) {
      intentIndexScheduled = true;
      setImmediate(() => {
        try {
          intent.ready();
        } catch {
          // A failed build is retried by the first command, outside its budget.
        }
      });
    }
    // end owner: intent
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
    const result = await core.execute(data.command);
    // owner: agenda. A completion isn't a source re-read: drop the agenda's cached facts before the
    // renderer's next query.
    if (data.command?.type === "complete") invalidateAgenda(store);
    // end owner: agenda
    port.postMessage({
      kind: "response",
      id: data.id,
      result,
    });
    if (data.command?.type === "purge") {
      courseBriefs.purge(); // owner: course-facts
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
