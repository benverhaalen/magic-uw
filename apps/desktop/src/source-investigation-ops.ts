/**
 * Main-process registry for student-opened source investigations. An operation is
 * registered, and so stoppable, from the moment its request arrives, including while
 * the local workspace is still starting. A Stop in that window settles the request at
 * once and nothing is ever sent to the worker, so no provider call can start. Each
 * operation removes only its own entry when it settles; a newer operation reusing the
 * same ID is never removed by an older one's late settle.
 */
export interface InvestigationCall {
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}
export interface InvestigationTransport {
  /** The local workspace start; the worker can't take a request before it. */
  ready: Promise<void>;
  newId(): string;
  /** Registers the call for the worker's response and posts the request. */
  send(id: string, assignmentId: string, call: InvestigationCall): void;
  /** Forgets the pending call and tells the worker to abort it. */
  cancel(id: string): void;
  timeoutMs?: number;
}

export function sourceInvestigationOps(transport: InvestigationTransport) {
  const operations = new Map<string, { stop(): void }>();
  const timeoutMs = transport.timeoutMs ?? 90_000;
  return {
    has: (operationId: string) => operations.has(operationId),
    stop: (operationId: string) => operations.get(operationId)?.stop(),
    run(operationId: string, assignmentId: string): Promise<unknown> {
      if (operations.has(operationId)) return Promise.reject(new Error("Invalid investigation request."));
      let done = false, workerId: string | null = null, timer: ReturnType<typeof setTimeout> | undefined;
      let settle!: { resolve(value: unknown): void; reject(error: Error): void };
      const result = new Promise<unknown>((resolve, reject) => { settle = { resolve, reject }; });
      const finish = (error: Error | null, value?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (operations.get(operationId) === entry) operations.delete(operationId);
        if (error) settle.reject(error); else settle.resolve(value);
      };
      const entry = {
        stop() {
          if (done) return;
          if (workerId) transport.cancel(workerId);
          finish(new Error("Investigation stopped."));
        },
      };
      operations.set(operationId, entry);
      transport.ready.then(() => {
        // Stopped while the workspace started: nothing reaches the worker or the provider.
        if (done) return;
        workerId = transport.newId();
        timer = setTimeout(() => entry.stop(), timeoutMs);
        try { transport.send(workerId, assignmentId, { timer, resolve: value => finish(null, value), reject: error => finish(error) }); }
        catch (error) {
          try { transport.cancel(workerId); } catch { /* the worker is gone either way */ }
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }, (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
      return result;
    },
  };
}
