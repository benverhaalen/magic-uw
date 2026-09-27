/** Leave an idle interval after each read; hidden windows never enqueue background work. */
export function startSnapshotPolling<T>(read: () => Promise<void>, environment: {
  hidden(): boolean;
  schedule(callback: () => void): T;
  cancel(timer: T): void;
  onVisibility(callback: () => void): () => void;
}) {
  let stopped = false;
  let running = false;
  let timer: T | undefined;
  const clear = () => {
    if (timer !== undefined) environment.cancel(timer);
    timer = undefined;
  };
  const run = async () => {
    if (stopped || running || environment.hidden()) return;
    running = true;
    try { await read(); }
    finally {
      running = false;
      if (!stopped && !environment.hidden()) timer = environment.schedule(() => { timer = undefined; void run(); });
    }
  };
  const unsubscribe = environment.onVisibility(() => {
    clear();
    if (!environment.hidden()) void run();
  });
  void run();
  return () => { stopped = true; clear(); unsubscribe(); };
}
