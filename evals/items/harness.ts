/**
 * The item-quality harness's runner: the real pack path (`generatePack`: scope → passages →
 * consent and egress → the student's client → the runner's checks → N06 → LearningStore) over
 * course scopes, with every model call observed at the backend seam. Offline, the backend is
 * the fake CLI answering with the offline model's output for the exact prompt it was sent;
 * live, it is the student's own signed-in client. The harness never edits a check.
 */
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { defaultPrivacy, type CaptureBatch, type PackScope } from "@magic/contracts";
import { createStore } from "@magic/storage";
import { applyConsent } from "../../packages/core/src/egress";
import { generatePack, type GenerationPackName, type PackRunResult, type WorkspaceStore } from "../../packages/core/src/pack-handler";
import { createPackRuntime } from "../../packages/packs/core/src/index";
import type { ArtifactStore, LearningArtifact, LedgerRecord, LedgerStore } from "../../packages/packs/core/src/index";
import { learningArtifactStore, sqlLedgerStore } from "../../packages/packs/core/src/learning-stores";
import { quizDrafts, quizOutputSchema, type Draft } from "../../packages/packs/items/src/index";
import { cardDrafts, cardsOutputSchema } from "../../packages/packs/cards/src/index";
import { RunnerError, type BackendCall, type ModelBackend } from "../../packages/runner/src/index";
import type { StoredItem } from "../../packages/learning/src/store";
import { subjectFamily } from "../../packages/notes/src/templates/index";
import { parsePrompt, writeCards, writeQuiz, type PromptPassage } from "./offline-model";
import { plantCard, plantQuiz, REPLACES_BASE, type Defect } from "./planted";

export type Tier = "synthetic" | "ocw" | "private";
export interface GoldTopic {
  label: string;
  /** The resource's externalId. */
  resource: string;
  quote: string;
}
export interface CourseCase {
  id: string;
  family: string;
  tier: Tier;
  batch: CaptureBatch;
  gold: GoldTopic[];
  /** A store already holding the course (live `--db`); the batch is then not ingested. */
  dbPath?: string;
}

export interface CallRecord {
  course: string;
  scope: string;
  pack: GenerationPackName;
  attempt: number;
  parsed: boolean;
  planted: "unparseable" | null;
  error: string | null;
  input: string;
}
export interface ItemRecord {
  course: string;
  family: string;
  tier: Tier;
  scope: string;
  pack: GenerationPackName;
  index: number;
  /** A planted defect id, or null for an item the model (or offline model) wrote. */
  planted: string | null;
  draft: Draft;
  dropped: { stage: string; reason: string } | null;
  stored: StoredItem | null;
  /** Items code derived from this one (languages: the reverse card), stored. */
  derived: StoredItem[];
}
export interface UnitRecord {
  course: string;
  family: string;
  tier: Tier;
  scope: string;
  /** "probe": an extra whole-course unit whose first response is planted unparseable. */
  scopeKind: "course" | "resource" | "probe";
  pack: GenerationPackName;
  result: PackRunResult;
  repeat: { cached: boolean; tokens: number; backendCalls: number; status: string };
  /** The pack command threw instead of answering: a defect, recorded, never retried here. */
  threw: string | null;
  prompt: string | null;
  sent: PromptPassage[];
  scopeResources: { id: string; externalId: string; text: string }[];
}
export interface HarnessResult {
  units: UnitRecord[];
  items: ItemRecord[];
  calls: CallRecord[];
  ledger: LedgerRecord[];
  models: string[];
  goldByCourse: Map<string, GoldTopic[]>;
}

export interface OfflineBackendFactory {
  kind: "offline";
  /** Builds the fake-CLI backend around a mutable env the harness writes each response into. */
  fake: (env: Record<string, string>) => ModelBackend;
  plantsPerCall: number;
  defects: Defect[];
  /** Add one probe unit (the first course, whole scope, first pack) whose first response is unparseable text. */
  probeUnparseable?: boolean;
}
export interface LiveBackendFactory {
  kind: "live";
  backend: () => ModelBackend;
  recipient: "claude" | "codex";
}
export interface HarnessOptions {
  courses: CourseCase[];
  packs: GenerationPackName[];
  /** Per listed pack; a pack without a count uses its default (the problems pack arrived after these evals). */
  counts: Partial<Record<GenerationPackName, number>>;
  /** "course" runs the whole course; "modules" also runs each material on its own. */
  scopes: "course" | "course+modules";
  backend: OfflineBackendFactory | LiveBackendFactory;
  log?: (line: string) => void;
}

const idIndex = (id: string) => {
  const m = /-(\d+)(r?)$/.exec(id);
  return m ? { index: Number(m[1]), derived: m[2] === "r" } : null;
};

function openStore(c: CourseCase): { store: WorkspaceStore; close: () => void } {
  if (c.dbPath) {
    // Never write the student's database: work on a copy in the temp folder.
    const copy = join(tmpdir(), `magic-item-eval-${process.pid}-${Date.now()}.sqlite`);
    copyFileSync(c.dbPath, copy);
    for (const ext of ["-wal", "-shm"]) if (existsSync(c.dbPath + ext)) copyFileSync(c.dbPath + ext, copy + ext);
    const store = createStore(copy) as unknown as WorkspaceStore;
    return {
      store,
      close: () => {
        store.close();
        for (const ext of ["", "-wal", "-shm"]) rmSync(copy + ext, { force: true });
      },
    };
  }
  const store = createStore(":memory:") as unknown as WorkspaceStore;
  store.ingest(c.batch);
  return { store, close: () => store.close() };
}

/** A workspace course's account scope and subject family, read from a temp copy of the database. */
export function inspectCourse(dbPath: string, courseId: string): { accountScope: string; family: string; courseName: string } | null {
  const { store, close } = openStore({ id: courseId, family: "unknown", tier: "private", gold: [], dbPath, batch: { source: { id: "db", kind: "canvas", accountScope: "", courseId, scope: "course", label: "" }, observedAt: new Date().toISOString(), complete: true, status: "ok", resources: [] } });
  try {
    const source = store.sources().find((s) => s.courseId === courseId);
    const resources = store.resources().filter((r) => r.courseId === courseId && !r.deleted);
    if (!source || !resources.length) return null;
    const courseName = resources.find((r) => r.courseName)?.courseName ?? courseId;
    const courseCode = resources.find((r) => r.course?.courseCode)?.course?.courseCode ?? null;
    return { accountScope: source.accountScope, family: subjectFamily({ courseName, courseCode }).family, courseName };
  } finally {
    close();
  }
}

function scopesFor(c: CourseCase, store: WorkspaceStore, mode: HarnessOptions["scopes"]) {
  const courseId = c.batch.source.courseId ?? c.batch.resources[0]!.courseId;
  const out: { label: string; kind: "course" | "resource" | "probe"; courseId: string; externalId: string | null }[] = [{ label: "course", kind: "course", courseId, externalId: null }];
  if (mode === "course+modules")
    for (const r of store.resources().filter((r) => r.courseId === courseId && r.kind === "material" && r.text.trim()).sort((a, b) => a.externalId.localeCompare(b.externalId)))
      out.push({ label: r.externalId, kind: "resource", courseId, externalId: r.externalId });
  return out;
}

export async function runHarness(options: HarnessOptions): Promise<HarnessResult> {
  const log = options.log ?? (() => {});
  const result: HarnessResult = { units: [], items: [], calls: [], ledger: [], models: [], goldByCourse: new Map(options.courses.map((c) => [c.id, c.gold])) };
  let unitIndex = 0;
  for (const course of options.courses) {
    const probe = openStore(course);
    const scopes = scopesFor(course, probe.store, options.scopes);
    probe.close();
    if (course === options.courses[0] && options.backend.kind === "offline" && options.backend.probeUnparseable)
      scopes.push({ label: "probe-unparseable", kind: "probe", courseId: scopes[0]!.courseId, externalId: null });
    for (const scope of scopes) {
      // One store per scope, so an earlier scope's items don't turn a later scope's into duplicates.
      const { store, close } = openStore(course);
      try {
        // Resource ids are minted per store: name the material by its external id, resolved here.
        const packScope: PackScope = scope.externalId
          ? { courseId: scope.courseId, resourceIds: store.resources().filter((r) => r.externalId === scope.externalId).map((r) => r.id) }
          : { courseId: scope.courseId };
        const recipient = options.backend.kind === "live" ? options.backend.recipient : "claude";
        if (!course.dbPath) {
          store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: recipient, shareCourseText: true });
          applyConsent(store, { action: "grant", recipient, disclosureVersion: CONSENT_DISCLOSURE_VERSION }, new Date().toISOString());
        }
        const courseOf = (ref: string) => {
          const s = store.sources().find((x) => `${x.accountScope}:${x.courseId}` === ref);
          return s ? { accountScope: s.accountScope, courseId: s.courseId } : null;
        };
        const sourceOf = (sourceId: string) => {
          const pid = Number(sourceId.slice(1));
          const p = Number.isSafeInteger(pid) ? store.passage(pid) : undefined;
          const r = p && store.resource(p.passage.resourceId);
          return r ? { resourceId: r.id, contentHash: r.contentHash } : null;
        };
        const outputs = new Map<string, LearningArtifact>();
        const innerArtifacts = learningArtifactStore(store.learning, sourceOf);
        const artifacts: ArtifactStore = {
          get: (key) => innerArtifacts.get(key),
          put: (a) => {
            outputs.set(a.id, a);
            innerArtifacts.put(a);
          },
          list: () => [...outputs.values()],
        };
        const innerLedger = sqlLedgerStore(store, courseOf);
        const ledger: LedgerStore = {
          append: (r) => {
            result.ledger.push(r);
            innerLedger.append(r);
          },
          list: (f) => innerLedger.list(f),
        };

        // The backend seam: every model call passes here, offline and live.
        let current: {
          pack: GenerationPackName;
          unparseable: boolean;
          labels: (string | null)[];
          calls: number;
          prompt: string | null;
          /** Computed once per unit, so a retry answers the same way with the same labels. */
          plan: { output: unknown; labels: (string | null)[] } | null;
        } = { pack: "quiz", unparseable: false, labels: [], calls: 0, prompt: null, plan: null };
        const env: Record<string, string> = {};
        const inner = options.backend.kind === "offline" ? options.backend.fake(env) : options.backend.backend();
        const offline = options.backend.kind === "offline" ? options.backend : null;
        const backend: ModelBackend = {
          client: inner.client,
          async call(call: BackendCall) {
            current.calls += 1;
            current.prompt = call.input;
            const attempt = current.calls;
            const plantedUnparseable = current.unparseable && attempt === 1;
            if (offline) {
              const prompt = parsePrompt(call.input);
              const count = prompt.count;
              if (plantedUnparseable) env.FAKE_CLI_RESPONSES = JSON.stringify([{ text: "Here are your questions: (not JSON)" }]);
              else {
                const plan = (current.plan ??= offlineResponse(current.pack, prompt, count, offline, `${course.id}|${scope.label}|${unitIndex}`));
                current.labels = plan.labels;
                env.FAKE_CLI_RESPONSES = JSON.stringify([{ output: plan.output }]);
              }
            }
            const schema = current.pack === "quiz" ? quizOutputSchema : cardsOutputSchema;
            try {
              const r = await inner.call(call);
              if (!result.models.includes(r.model)) result.models.push(r.model);
              result.calls.push({ course: course.id, scope: scope.label, pack: current.pack, attempt, parsed: schema.safeParse(r.value).success, planted: plantedUnparseable ? "unparseable" : null, error: null, input: call.input });
              return r;
            } catch (error) {
              const kind = error instanceof RunnerError ? error.kind : "error";
              result.calls.push({ course: course.id, scope: scope.label, pack: current.pack, attempt, parsed: false, planted: plantedUnparseable ? "unparseable" : null, error: `${kind}: ${(error as Error).message}`, input: call.input });
              throw error;
            }
          },
          ...(inner.close ? { close: () => inner.close!() } : {}),
        };
        const runner = createPackRuntime(backend, { dailyBackgroundTokens: 5_000_000 }).runner;
        const deps = { store, runner: () => runner, artifacts, ledger };
        const courseRef = `${course.batch.source.accountScope}:${packScope.courseId}`;
        const scopeResources = store
          .resources()
          .filter((r) => r.courseId === packScope.courseId && r.kind === "material" && r.text.trim() && (!packScope.resourceIds || packScope.resourceIds.includes(r.id)))
          .map((r) => ({ id: r.id, externalId: r.externalId, text: r.text }));

        for (const pack of scope.kind === "probe" ? options.packs.slice(0, 1) : options.packs) {
          current = { pack, unparseable: scope.kind === "probe", labels: [], calls: 0, prompt: null, plan: null };
          const count = options.counts[pack];
          const attempt = async (): Promise<{ r: PackRunResult; threw: string | null }> => {
            try {
              return { r: await generatePack(deps, { pack, scope: packScope, count, lane: "interactive" }), threw: null };
            } catch (error) {
              const message = error instanceof Error ? `${error.name}: ${error.message.replace(/\s+/g, " ").slice(0, 300)}` : String(error);
              return { r: threwResult(pack, message), threw: message };
            }
          };
          const { r, threw } = await attempt();
          log(`${course.id} ${scope.label} ${pack}: ${r.status} ${r.message}`);
          const firstCalls = current.calls;
          const prompt = current.prompt;
          const labels = current.labels;
          const again = (await attempt()).r;
          const repeat = { cached: again.cached, tokens: again.tokens.in + again.tokens.cached + again.tokens.out, backendCalls: current.calls - firstCalls, status: again.status };
          result.units.push({
            course: course.id,
            family: course.family,
            tier: course.tier,
            scope: scope.label,
            scopeKind: scope.kind,
            pack,
            result: r,
            repeat,
            prompt,
            threw,
            sent: prompt ? parsePrompt(prompt).passages : [],
            scopeResources,
          });
          if (r.status === "done") {
            const artifact = outputs.get(r.artifactIds[0]!);
            const drafts = artifact ? (pack === "quiz" ? quizDrafts(quizOutputSchema.parse(artifact.output)) : cardDrafts(cardsOutputSchema.parse(artifact.output))).slice(0, count) : [];
            const stored = store.learning.items({ courseRef });
            const byIndex = new Map<number, StoredItem>();
            const derived = new Map<number, StoredItem[]>();
            for (const id of r.itemIds) {
              const at = idIndex(id);
              const s = stored.find((x) => x.item.id === id);
              if (!at || !s) continue;
              if (at.derived) derived.set(at.index, [...(derived.get(at.index) ?? []), s]);
              else byIndex.set(at.index, s);
            }
            for (const d of drafts) {
              const drop = r.drops.find((x) => x.index === d.index);
              result.items.push({
                course: course.id,
                family: course.family,
                tier: course.tier,
                scope: scope.label,
                pack,
                index: d.index,
                planted: labels[d.index] ?? null,
                draft: d,
                dropped: drop ? { stage: drop.stage, reason: drop.reason } : null,
                stored: byIndex.get(d.index) ?? null,
                derived: derived.get(d.index) ?? [],
              });
            }
          }
          unitIndex++;
        }
        await backend.close?.();
      } finally {
        close();
      }
    }
  }
  return result;
}

function threwResult(pack: GenerationPackName, message: string): PackRunResult {
  return {
    status: "failed",
    message: `threw: ${message}`,
    pack,
    courseRef: null,
    artifactIds: [],
    itemIds: [],
    cached: false,
    tokens: { in: 0, cached: 0, out: 0 },
    counts: { generated: 0, accepted: 0, dropped: 0, droppedBy: {} },
    drops: [],
    receiptIds: [],
  };
}

/** The offline response for one call: the offline model's clean items, then planted defects. */
export function offlineResponse(
  pack: GenerationPackName,
  prompt: ReturnType<typeof parsePrompt>,
  count: number,
  offline: OfflineBackendFactory,
  seed: string,
): { output: unknown; labels: (string | null)[] } {
  const plants = offline.defects.filter((d) => d.pack === pack);
  const cleanCount = Math.max(1, count - Math.min(offline.plantsPerCall, plants.length));
  const written = pack === "quiz" ? writeQuiz(prompt, cleanCount) : writeCards(prompt, cleanCount);
  // At most one plant per two clean items, so the batch check (retry when fewer than half the
  // items survive) judges the offline model's own items, not the plants.
  const want = Math.min(offline.plantsPerCall, plants.length, Math.floor(written.length / 2));
  // Rotate through the catalogue so every defect type recurs across calls.
  const start = offlineRotation.get(pack) ?? 0;
  const chosen: Defect[] = [];
  for (let i = 0; i < plants.length && chosen.length < want; i++) chosen.push(plants[(start + i) % plants.length]!);
  // Defects that replace their base item go first, so no other plant is built on a removed base.
  chosen.sort((a, b) => Number(REPLACES_BASE.has(b.id)) - Number(REPLACES_BASE.has(a.id)));
  if (pack === "quiz") {
    const clean = written as ReturnType<typeof writeQuiz>;
    const planted: { id: string; item: NonNullable<ReturnType<typeof plantQuiz>> }[] = [];
    let used = 0;
    let kept = clean;
    for (const d of chosen) {
      const item = plantQuiz(d.id, kept, prompt.passages, `${seed}|${d.id}`);
      used++;
      if (!item) continue;
      if (REPLACES_BASE.has(d.id)) kept = kept.filter((c) => c.stem !== item.stem);
      planted.push({ id: d.id, item });
    }
    offlineRotation.set(pack, (start + used) % plants.length);
    const items = [...kept, ...planted.map((p) => p.item)].slice(0, count);
    return { output: { items }, labels: items.map((_, i) => (i < kept.length ? null : planted[i - kept.length]!.id)) };
  }
  const clean = written as ReturnType<typeof writeCards>;
  const planted: { id: string; card: NonNullable<ReturnType<typeof plantCard>> }[] = [];
  let used = 0;
  let kept = clean;
  for (const d of chosen) {
    const card = plantCard(d.id, kept, prompt.passages, `${seed}|${d.id}`);
    used++;
    if (!card) continue;
    if (REPLACES_BASE.has(d.id)) kept = kept.filter((c) => c.front !== card.front);
    planted.push({ id: d.id, card });
  }
  offlineRotation.set(pack, (start + used) % plants.length);
  const cards = [...kept, ...planted.map((p) => p.card)].slice(0, count);
  return { output: { cards }, labels: cards.map((_, i) => (i < kept.length ? null : planted[i - kept.length]!.id)) };
}
const offlineRotation = new Map<GenerationPackName, number>();
export function resetOfflineRotation(): void {
  offlineRotation.clear();
}
