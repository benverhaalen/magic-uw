import { useEffect, useMemo, useState } from "react";
import type { AppBridge, ResourceView, Snapshot, SourceInvestigationResult } from "@magic/contracts";

/**
 * The read-only source investigation an assignment detail runs for sparse Canvas
 * instructions. It is a paid model call, so it runs once per relevant evidence state:
 * reopening the assignment or an unrelated snapshot refresh shows the saved result,
 * and Stop is final until the student asks again. The worker still revalidates the
 * account, course, source versions, privacy and grant on every run; this only decides
 * when the renderer asks.
 */
export type InvestigationState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; value: SourceInvestigationResult }
  | { kind: "error"; message: string }
  /** The student stopped it. `changed`: course evidence changed since; still not rerun on its own. */
  | { kind: "stopped"; changed?: boolean };

export type InvestigationBridge = Pick<AppBridge, "investigateAssignment" | "stopAssignmentInvestigation">;

export const SPARSE_INSTRUCTIONS = 200;
export const sparseInstructions = (resource: Pick<ResourceView, "text">) => (resource.text ?? "").trim().length < SPARSE_INSTRUCTIONS;

const BLOCKED = new Set(["inaccessible", "not_published"]);
/**
 * What the worker's click investigation reads, taken from the snapshot the renderer
 * already has: this assignment's version; the course's evidence inventory (every saved
 * resource of this account and course, as the worker's `courseInventoryHash` counts it);
 * whether those sources are readable; course inclusion and policy version; and sharing
 * settings. Jobs, receipts, other courses, GitLab links and snapshot timestamps are not
 * part of it, so refreshing them reruns nothing.
 */
export function investigationRelevance(
  snapshot: Pick<Snapshot, "resources" | "sources" | "privacy" | "consents" | "courseOverrides" | "courseIntelligence" | "ingestionSettings">,
  resource: Pick<ResourceView, "id" | "courseId" | "contentHash">,
  accountScope: string,
): string {
  const sources = new Map(snapshot.sources.filter(s => s.accountScope === accountScope).map(s => [s.id, s]));
  const evidence: string[] = [];
  const used = new Set<string>();
  for (const r of snapshot.resources) {
    const source = sources.get(r.sourceId);
    if (!source || r.deleted || (r.courseId !== resource.courseId && source.courseId !== resource.courseId)) continue;
    used.add(source.id);
    evidence.push(`${r.id}:${r.contentHash}`);
  }
  const readable = [...used].sort().map(id => `${id}:${BLOCKED.has(sources.get(id)!.status) ? 0 : 1}`);
  const override = snapshot.courseOverrides?.find(o => o.accountScope === accountScope && o.courseId === resource.courseId)?.included;
  const policy = Math.max(0, ...(snapshot.courseIntelligence ?? []).filter(p => p.accountScope === accountScope && p.courseId === resource.courseId).map(p => p.version));
  const privacy = Object.entries(snapshot.privacy ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const consents = (snapshot.consents ?? []).filter(c => c.recipient === "claude" || c.recipient === "codex").map(c => `${c.recipient}:${c.disclosureVersion}`).sort();
  return hash(JSON.stringify([accountScope, resource.courseId, resource.id, resource.contentHash, evidence.sort(), readable,
    override ?? null, snapshot.ingestionSettings?.selectedTerm ?? null, policy, privacy, consents]));
}
/** Short stable digest for comparison only (cyrb53); nothing is derived from it. */
function hash(text: string) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Session-only results by exact account and assignment. Never written to disk: excerpts are coursework. */
const investigationTask = (accountScope: string, assignmentId: string) => `${accountScope}\u0000${assignmentId}`;
const saved = new Map<string, { relevance: string; state: Exclude<InvestigationState, { kind: "idle" | "loading" }> }>();
export function clearInvestigations() { saved.clear(); }

/**
 * One mounted assignment's investigation. Every late success or failure checks that its
 * operation is still the current one before it touches the view or the saved result, so
 * Stop, leaving the page and an account switch always win over a response in flight.
 */
export class SourceInvestigation {
  readonly investigationId: { current: string | null } = { current: null };
  private readonly task: string;
  private relevance = "";
  /** Relevance of the operation in flight, so the same evidence never starts a second one. */
  private running = "";
  private state: InvestigationState = { kind: "idle" };
  constructor(
    accountScope: string,
    private readonly assignmentId: string,
    private readonly bridge: InvestigationBridge,
    private readonly onChange: (state: InvestigationState) => void,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) { this.task = investigationTask(accountScope, assignmentId); }

  /** What to show before any effect runs: a saved result for this exact evidence, else nothing yet. */
  static initial(accountScope: string, assignmentId: string, relevance: string, enabled: boolean): InvestigationState {
    if (!enabled) return { kind: "idle" };
    const entry = saved.get(investigationTask(accountScope, assignmentId));
    if (entry?.state.kind === "stopped") return { kind: "stopped", changed: entry.relevance !== relevance };
    return entry?.relevance === relevance ? entry.state : { kind: "loading" };
  }

  /** Runs only when nothing is saved for this evidence and the student hasn't stopped it. */
  sync(relevance: string, enabled: boolean) {
    this.relevance = relevance;
    if (!enabled || !this.bridge.investigateAssignment) { this.release(); return this.set({ kind: "idle" }); }
    const entry = saved.get(this.task);
    if (entry?.state.kind === "stopped") return this.set({ kind: "stopped", changed: entry.relevance !== relevance });
    if (entry?.relevance === relevance) return this.set(entry.state);
    if (this.investigationId.current && this.running === relevance) return;
    this.start();
  }

  /** The student's explicit request (after Stop or an error). */
  restart() {
    saved.delete(this.task);
    this.start();
  }

  /** The student's Stop: cancels the operation and keeps it stopped for this assignment this session. */
  stop() {
    this.cancel();
    const state: InvestigationState = { kind: "stopped" };
    saved.set(this.task, { relevance: this.relevance, state });
    this.set(state);
  }

  /** Leaving the page or switching accounts: cancel without recording a Stop, so a later visit can run. */
  release() { this.cancel(); }

  private start() {
    const investigate = this.bridge.investigateAssignment;
    if (!investigate) return;
    this.cancel();
    const operationId = this.newId();
    const relevance = this.relevance;
    this.investigationId.current = operationId;
    this.running = relevance;
    this.set({ kind: "loading" });
    let request: Promise<SourceInvestigationResult>;
    try { request = investigate({ operationId, assignmentId: this.assignmentId }); }
    catch (cause) { request = Promise.reject(cause); }
    void request.then(value => {
      if (this.investigationId.current !== operationId) return;
      this.finish(relevance, { kind: "ready", value });
    }, cause => {
      if (this.investigationId.current !== operationId) return;
      this.finish(relevance, { kind: "error", message: cleanError(cause) });
    });
  }
  private finish(relevance: string, state: Exclude<InvestigationState, { kind: "idle" | "loading" | "stopped" }>) {
    this.investigationId.current = null;
    this.running = "";
    saved.set(this.task, { relevance, state });
    this.set(state);
  }
  private cancel() {
    const operationId = this.investigationId.current;
    this.investigationId.current = null;
    this.running = "";
    if (operationId) void this.bridge.stopAssignmentInvestigation?.(operationId)?.catch(() => { /* already finished or gone */ });
  }
  private set(state: InvestigationState) {
    if (state === this.state || (state.kind === "stopped" && this.state.kind === "stopped" && state.changed === this.state.changed)) return;
    this.state = state;
    this.onChange(state);
  }
}

const cleanError = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

/**
 * Investigation for one mounted assignment. Its effect depends on the exact relevant
 * evidence, not the snapshot's global revision (prepared work keeps that one).
 */
export function useSourceInvestigation(input: { accountScope: string; resource: ResourceView; snapshot: Snapshot }) {
  const { accountScope, resource, snapshot } = input;
  const bridge: InvestigationBridge = window.magic;
  const enabled = sparseInstructions(resource) && !!bridge.investigateAssignment;
  const relevance = useMemo(() => investigationRelevance(snapshot, resource, accountScope),
    [snapshot, accountScope, resource.id, resource.courseId, resource.contentHash]); // eslint-disable-line react-hooks/exhaustive-deps
  const [state, setState] = useState<InvestigationState>(() => SourceInvestigation.initial(accountScope, resource.id, relevance, enabled));
  const [controller] = useState(() => new SourceInvestigation(accountScope, resource.id, bridge, setState));
  useEffect(() => {
    // Deferred a task so a mount that is immediately undone (React StrictMode) sends nothing.
    const timer = setTimeout(() => controller.sync(relevance, enabled), 0);
    return () => clearTimeout(timer);
  }, [controller, relevance, enabled]);
  useEffect(() => () => controller.release(), [controller]);
  return { state, stop: () => controller.stop(), restart: () => controller.restart() };
}
