/**
 * The agenda's model calls go through the same path as the quiz, cards and guide packs: `runPack`
 * (cache first, one checked call with retry and escalation, the ledger), with consent decided by
 * `maySend` and `egressFor` on every call, a receipt per send, and a fingerprint of the evidence
 * and permissions that blocks a send when either changes mid-call. Fields are scrubbed per course
 * by the caller before they get here.
 *
 * Model outputs are cached in the `judgments` table, anchored to one of the items' resources at
 * its current text hash, so they vanish with that resource and never outlive a purge.
 */
import { aiRecipientSchema, type Judgment, type Resource, type Store } from "@magic/contracts";
import type { CourseCoreStore, CourseRef, GraphStore } from "../../../contracts/src/course-core";
import { maySend } from "@magic/domain";
import type { BackendCall, ModelRunner } from "../../../runner/src/index";
import type { ArtifactStore, CourseFrame, LearningArtifact, PackSpec } from "../../../packs/core/src/index";
import { sqlLedgerStore } from "../../../packs/core/src/learning-stores";
import { runPack, type PackJobResult } from "../jobs/pack";
import { contentCategories } from "../access";
import { buildReceipt, egressFor, payloadHash } from "../egress";

export type AgendaStore = Store & CourseCoreStore & GraphStore;

const RECIPIENT: Record<string, string> = { local: "local", claude: "claude", anthropic: "claude", codex: "codex", openai: "chatgpt", openrouter: "openrouter", gemini: "gemini" };
class AgendaEgressBlocked extends Error {}

/** Pack artifacts kept as judgments on an anchor resource (its current text hash). */
export function judgmentArtifacts(store: AgendaStore, question: string, anchor: { resourceId: string; inputHash: string }): ArtifactStore {
  const key = (cacheKey: string) => `${question}:${cacheKey}`;
  return {
    get(cacheKey) {
      const a = store.judgment(key(cacheKey))?.result as Partial<LearningArtifact> | undefined;
      return a && typeof a.cacheKey === "string" && typeof a.packId === "string" ? (a as LearningArtifact) : null;
    },
    put(a) {
      store.putJudgment({ key: key(a.cacheKey), resourceId: anchor.resourceId, inputHash: anchor.inputHash, model: "student-ai", questionVersion: question, result: a, createdAt: a.createdAt });
    },
    list: () => [],
  };
}

/** A checked result code keeps (the lines or estimates it accepted), on the same anchor. */
export function putChecked(store: AgendaStore, question: string, key: string, anchor: { resourceId: string; inputHash: string }, result: unknown, at: string): boolean {
  return store.putJudgment({ key: `${question}:${key}`, resourceId: anchor.resourceId, inputHash: anchor.inputHash, model: "student-ai", questionVersion: question, result, createdAt: at });
}
export function readChecked(store: Store, question: string, key: string): Judgment | undefined {
  return store.judgment(`${question}:${key}`);
}

export interface AgendaSend<I, O> {
  pack: PackSpec<I, O>;
  frame: CourseFrame;
  /** Already scrubbed field by field for a hosted recipient. */
  input: I;
  /** The resources the payload draws on: categories, the receipt's IDs and the fingerprint. */
  resources: Resource[];
  purpose: string;
  cacheKey: string;
  anchor: { resourceId: string; inputHash: string };
  artifactQuestion: string;
  /** The course for the ledger row; null for a cross-course call. */
  course: CourseRef | null;
}
export interface AgendaSendDeps {
  store: AgendaStore;
  runner: ModelRunner;
  now: () => Date;
  lane: "interactive" | "background";
  signal?: AbortSignal;
}

export async function sendAgendaPack<I, O>(deps: AgendaSendDeps, send: AgendaSend<I, O>): Promise<PackJobResult<O> & { receiptIds: string[] }> {
  const { store, runner } = deps;
  const at = () => deps.now().toISOString();
  const receiptIds: string[] = [];
  const snapshot = () =>
    payloadHash({
      resources: send.resources.map((r) => [r.id, store.resource(r.id)?.contentHash ?? null]),
      privacy: store.privacy(),
      consents: store.consents?.(),
    });
  const fingerprint = snapshot();
  const validate = () => {
    if (deps.signal?.aborted || snapshot() !== fingerprint) throw new AgendaEgressBlocked("Course evidence or sharing permissions changed; nothing was sent.");
  };
  const categoriesOf = (categories: string[]) => [...new Set([...categories, ...send.resources.flatMap(contentCategories)])];
  const authorize = (recipient: string, categories: string[], payload?: unknown) => {
    validate();
    categories = categoriesOf(categories);
    const parsed = aiRecipientSchema.safeParse(recipient);
    if (!parsed.success) return { allowed: false, reason: "This recipient is not supported." };
    const permission = maySend(store.privacy(), recipient, categories);
    if (payload === undefined && permission.allowed) return permission;
    const m = {
      recipient: parsed.data,
      purpose: send.purpose,
      categories,
      resourceIds: send.resources.map((r) => r.id),
      characters: JSON.stringify(payload ?? {}).length,
      allowed: permission.allowed,
      reason: permission.reason,
      payload,
    };
    const decision = egressFor(store).check(m, { at: at(), background: deps.lane === "background" });
    if (decision.status === "blocked") {
      receiptIds.push(decision.receiptId);
      return { allowed: false, reason: decision.reason };
    }
    if (decision.status === "preview_required") {
      receiptIds.push(decision.previewId);
      return { allowed: false, reason: decision.reason };
    }
    const receipt = buildReceipt(m, "sent", at());
    store.addReceipt(receipt);
    receiptIds.push(receipt.id);
    return { allowed: true, reason: permission.reason };
  };
  const hosted = runner.client !== "local";
  const beforeCall = (call: BackendCall): BackendCall => {
    const outgoing = { ...call, courseId: hosted ? undefined : call.courseId };
    const permission = authorize(RECIPIENT[runner.client] ?? runner.client, send.pack.categories, { systemPrompt: outgoing.systemPrompt, input: outgoing.input, jsonSchema: outgoing.jsonSchema });
    if (!permission.allowed) throw new AgendaEgressBlocked(permission.reason);
    return outgoing;
  };
  const ledger = sqlLedgerStore(store, () => send.course);
  try {
    validate();
    const result = await runPack(
      { runner, artifacts: judgmentArtifacts(store, send.artifactQuestion, send.anchor), ledger, authorize, beforeCall, validate, cacheKey: send.cacheKey, now: () => deps.now().getTime() },
      send.pack,
      send.frame,
      send.input,
      [],
      { lane: deps.lane, scope: "agenda", ...(deps.signal ? { signal: deps.signal } : {}) },
    );
    return { ...result, receiptIds };
  } catch (error) {
    if (error instanceof AgendaEgressBlocked) return { status: "blocked", reason: error.message, receiptIds };
    throw error;
  }
}
