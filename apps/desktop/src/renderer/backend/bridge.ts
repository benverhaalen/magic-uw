// owner: ui-wiring. Preview wiring: thin, typed calls over the existing bridge channels only
// (execute for commands, query for scoped reads, graph for the material pipeline's reads).
// The frontend owner replaces these views; nothing here is a designed screen.
import { useEffect, useRef, useState } from "react";
import type {
  GraphQuery,
  GraphResult,
  LearningRequest,
  LearningResult,
  NotesRequest,
  NotesResult,
  PackScope,
  QueryRequest,
  QueryResult,
} from "@magic/contracts";

export type Course = { accountScope: string; courseId: string; courseName: string };

/** The existing bridge; absent in the browser preview, where every view says so. */
const bridge = () => {
  if (!window.magic) throw new Error("The desktop connection is unavailable.");
  return window.magic;
};

export async function query<V extends QueryRequest["view"]>(
  request: Extract<QueryRequest, { view: V }>,
): Promise<Extract<QueryResult, { view: V }>> {
  const b = bridge();
  if (!b.query) throw new Error("Scoped queries aren't available in this build.");
  return (await b.query(request)) as Extract<QueryResult, { view: V }>;
}

export async function graph<Q extends GraphQuery>(request: Q): Promise<GraphResult<Q>> {
  const b = bridge();
  if (!b.graph) throw new Error("Course graph reads aren't available in this build.");
  return b.graph(request);
}

/** A learning-router op. Returns the router's own answer; the caller renders every status. */
export async function learning(request: LearningRequest): Promise<LearningResult> {
  const result = await bridge().execute({ type: "learning", request, reply: "result" });
  if (!result.learning) throw new Error("The learning router gave no answer.");
  return result.learning;
}

export async function notes(request: NotesRequest): Promise<NotesResult> {
  const result = await bridge().execute({ type: "notes", request, reply: "result" });
  if (!result.notes) throw new Error("The notes service gave no answer.");
  return result.notes;
}

/** A generation pack (flashcards, quiz, the guide kinds). The result is the pack handler's own shape. */
export async function pack(name: string, scope: PackScope): Promise<PackOutcome> {
  const result = await bridge().execute({ type: "pack", pack: name, scope });
  const value = result.pack as Partial<PackOutcome> | undefined;
  if (value && typeof value.status === "string" && typeof value.message === "string")
    return { status: value.status, message: value.message, cached: value.cached === true, tokens: value.tokens ?? null };
  return { status: "not_built", message: result.message ?? "This pack gave no answer.", cached: false, tokens: null };
}
export interface PackOutcome {
  status: string;
  message: string;
  cached: boolean;
  tokens: { in: number; cached: number; out: number } | null;
}

export function openExternal(url: string): Promise<void> {
  return bridge().openExternal(url);
}

/** owner: doc-window. A synced note's Word/Google Doc in the signed-in document window; the browser in older builds. */
export async function openDocument(url: string): Promise<void> {
  const b = bridge();
  if (b.openDocument) await b.openDocument(url);
  else await b.openExternal(url);
}

export type Load<T> =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; value: T };

/**
 * The last answer per key for this window's life: reopening a view paints it at once while the
 * fresh read runs (stale-while-revalidate). Bounded; the oldest key goes first.
 */
const lastAnswers = new Map<string, unknown>();
const LAST_ANSWERS_MAX = 64;
function remember(key: string, value: unknown) {
  lastAnswers.delete(key);
  lastAnswers.set(key, value);
  if (lastAnswers.size > LAST_ANSWERS_MAX) lastAnswers.delete(lastAnswers.keys().next().value!);
}

/**
 * One read keyed by `key`. A new key or unmount drops the in-flight answer (the IPC channels have
 * no abort, so a late answer is ignored rather than cancelled). No polling: `reload` reads again.
 * A key read before shows its last answer immediately, then the fresh answer replaces it.
 */
export function useLoad<T>(key: string | null, read: () => Promise<T>): [Load<T>, () => void] {
  const cached = (k: string | null): Load<T> =>
    k !== null && lastAnswers.has(k) ? { state: "ready", value: lastAnswers.get(k) as T } : { state: "loading" };
  const [load, setLoad] = useState<Load<T>>(() => cached(key));
  const [nonce, setNonce] = useState(0);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    if (key === null) return;
    let live = true;
    setLoad(cached(key));
    readRef.current().then(
      (value) => {
        remember(key, value);
        if (live) setLoad({ state: "ready", value });
      },
      (cause: unknown) =>
        live && setLoad({ state: "error", message: cause instanceof Error ? cause.message : "The read failed." }),
    );
    return () => {
      live = false;
    };
  }, [key, nonce]);
  return [load, () => setNonce((n) => n + 1)];
}

/** Guards an action's result against unmount; `run` reports the error text instead of throwing. */
export function useAction() {
  const live = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError("");
    try {
      const value = await action();
      return live.current ? value : undefined;
    } catch (cause) {
      if (live.current) setError(cause instanceof Error ? cause.message : "The action failed.");
      return undefined;
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

export const newOperationId = () => crypto.randomUUID();
// end owner: ui-wiring
