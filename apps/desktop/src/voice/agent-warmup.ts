// owner: voice-plan. The connected agent's launch lifecycle. When the app opens (after first paint, never
// blocking it, and never touching the microphone), the student's chosen Claude Code or Codex is found and
// health-checked through the same instant/isolated run options every generation uses. For Claude, the
// persistent session pool starts the planner's session with its exact first-call prefix (0 tokens), so
// the first spoken request skips the CLI's start-up. Codex has no persistent transport here: it is checked
// and reported as running per request, never as warm. Electron-free; the worker injects the parts.
import type { WarmRequest } from "../../../../packages/runner/src/index";

/** What the student's connected agent is ready to do for voice, as the app actually observed it. */
export type AgentReadiness =
  | { state: "idle" }
  | { state: "none"; reason: string }
  | { state: "needs_permission"; client: string; reason: string }
  | { state: "starting"; client: string; at: string; pid?: number | null }
  /**
   * A Claude Code session process holds the planner prefix, was still running after its measured start-up
   * time, and waits for input (nothing sent). It is not a model health or quality claim.
   */
  | { state: "ready"; client: "claude"; transport: "persistent"; lane: string; session: string | null; pid: number | null; readyMs: number; at: string }
  /** Connected and checked, but every request starts its own process: there is no warm session. */
  | { state: "per_request"; client: string; transport: "one_shot"; checkedMs: number; at: string; reason: string }
  | { state: "failed"; client: string | null; reason: string; at: string };

/** The pool calls this lifecycle uses; the worker's intent session pool provides them. */
export interface WarmPool {
  warm(request: WarmRequest): Promise<boolean>;
  end(request: Pick<WarmRequest, "lane" | "courseId">): Promise<void>;
  lanes(): { lane: string; session: string | null; pid: number | null }[];
}

export interface AgentWarmupDeps {
  /** The student's chosen client and a key that changes with its mode; null when none is chosen. */
  chosen(): Promise<{ id: string; key: string } | null>;
  /** The worker's intent runtime for that choice (health-checked); `pool` is null for a one-shot client. */
  runtime(): Promise<{ client: string; pool: WarmPool | null } | null>;
  /** The provider's consent for the planner's data category, as the planner's authorizer will check it. */
  consented(clientId: string): boolean;
  /** The planner's launch prefix (Home), from `plannerWarmRequest`. */
  warmRequest(): WarmRequest;
  onStatus(status: AgentReadiness): void;
  now?(): number;
  /**
   * How long a started session must stay alive before it is called ready. The idle Claude Code 2.1.283 CLI
   * settled (RSS and CPU flat) 2.6–3.2 s after spawn on the benchmark Mac; 4 s covers that.
   */
  settleMs?: number;
}

const NONE = "Voice requests need your AI: choose Claude or Codex in Settings and sign in.";
const laneKey = (r: Pick<WarmRequest, "lane" | "courseId">) => (r.lane === "background" ? "background" : `interactive:${r.courseId ?? "-"}`);

export function createAgentWarmup(deps: AgentWarmupDeps) {
  const now = deps.now ?? Date.now;
  const settleMs = deps.settleMs ?? 4000;
  const iso = () => new Date(now()).toISOString();
  let status: AgentReadiness = { state: "idle" };
  let inflight: Promise<AgentReadiness> | null = null;
  let generation = 0;
  let current: { key: string; pool: WarmPool | null; request: WarmRequest } | null = null;
  let closed = false;
  const set = (next: AgentReadiness, gen: number) => {
    if (gen !== generation || closed) return status;
    status = next;
    deps.onStatus(next);
    return next;
  };

  async function attempt(gen: number): Promise<AgentReadiness> {
    const chosen = await deps.chosen().catch(() => null);
    if (!chosen) return set({ state: "none", reason: NONE }, gen);
    if (!deps.consented(chosen.id))
      return set({ state: "needs_permission", client: chosen.id, reason: `Voice requests need your permission to send course text to ${chosen.id === "claude" ? "Claude" : chosen.id === "codex" ? "Codex" : "your AI"} in Data & AI.` }, gen);
    set({ state: "starting", client: chosen.id, at: iso() }, gen);
    const started = now();
    const runtime = await deps.runtime().catch(() => null);
    if (gen !== generation) return status;
    if (!runtime) return set({ state: "failed", client: chosen.id, reason: `Magic couldn't start ${chosen.id === "claude" ? "Claude Code" : chosen.id === "codex" ? "Codex" : "your AI"}. Check that it's installed and signed in, then try again.`, at: iso() }, gen);
    if (!runtime.pool) {
      current = { key: runtime.client, pool: null, request: deps.warmRequest() };
      return set({ state: "per_request", client: chosen.id, transport: "one_shot", checkedMs: now() - started, at: iso(), reason: `${chosen.id === "codex" ? "Codex" : "This AI"} is connected. Each request starts it fresh, so the first answer takes a few seconds longer.` }, gen);
    }
    const request = deps.warmRequest();
    current = { key: runtime.client, pool: runtime.pool, request };
    const live = await runtime.pool.warm(request).catch(() => false);
    if (gen !== generation) return status;
    if (!live) return set({ state: "failed", client: chosen.id, reason: "Claude Code's session didn't start. Magic will start it for your next request.", at: iso() }, gen);
    const spawned = runtime.pool.lanes().find((l) => l.lane === laneKey(request));
    set({ state: "starting", client: chosen.id, at: iso(), pid: spawned?.pid ?? null }, gen);
    // Ready only once the process has outlived its start-up: an early exit (sign-in, crash) is a failure.
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    if (gen !== generation) return status;
    const lane = runtime.pool.lanes().find((l) => l.lane === laneKey(request));
    if (!lane?.session)
      return set({ state: "failed", client: chosen.id, reason: "Claude Code's session stopped while starting. Check that it's signed in; Magic will try again when you use voice.", at: iso() }, gen);
    return set({ state: "ready", client: "claude", transport: "persistent", lane: laneKey(request), session: lane.session, pid: lane.pid, readyMs: now() - started, at: iso() }, gen);
  }

  function start(): Promise<AgentReadiness> {
    if (closed) return Promise.resolve(status);
    // One launch at a time; a ready session is kept (the pool's warm is a no-op for a live match).
    if (inflight) return inflight;
    const gen = generation;
    inflight = attempt(gen).finally(() => {
      if (gen === generation) inflight = null;
    });
    return inflight;
  }

  /** Ends this lifecycle's voice sessions (the planner lanes it warmed). */
  async function teardown() {
    const was = current;
    current = null;
    if (was?.pool) await was.pool.end(was.request).catch(() => undefined);
  }

  return {
    status: () => status,
    /** At launch, and again on a voice activation after a failure: idempotent, never a second process. */
    start,
    /**
     * Provider, mode, consent or account changed: the old session is ended (its conversation and process
     * go), and a new one is started only if the new choice allows it.
     */
    async refresh(): Promise<AgentReadiness> {
      generation++;
      inflight = null;
      await teardown();
      return start();
    },
    /**
     * After each spoken run: the lane it used is ended, so the next request carries none of this one's
     * page text, and the launch session is started again for the next request.
     */
    async afterRun(used: WarmRequest): Promise<void> {
      const pool = current?.pool;
      if (!pool || closed) return;
      await pool.end(used).catch(() => undefined);
      if (laneKey(used) !== laneKey(current!.request)) return;
      if (status.state === "ready") set({ state: "starting", client: "claude", at: iso() }, generation);
      inflight = null;
      await start();
    },
    async close() {
      closed = true;
      generation++;
      await teardown();
    },
  };
}
