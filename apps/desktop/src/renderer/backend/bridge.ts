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
  const result = await bridge().execute({ type: "learning", request });
  if (!result.learning) throw new Error("The learning router gave no answer.");
  return result.learning;
}

export async function notes(request: NotesRequest): Promise<NotesResult> {
  const result = await bridge().execute({ type: "notes", request });
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

export type Load<T> =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; value: T };

/**
 * One read keyed by `key`. A new key or unmount drops the in-flight answer (the IPC channels have
 * no abort, so a late answer is ignored rather than cancelled). No polling: `reload` reads again.
 */
export function useLoad<T>(key: string | null, read: () => Promise<T>): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  const [nonce, setNonce] = useState(0);
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    if (key === null) return;
    let live = true;
    setLoad({ state: "loading" });
    readRef.current().then(
      (value) => live && setLoad({ state: "ready", value }),
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
