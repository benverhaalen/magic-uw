/** Deduplicate evidence previews; explicit refresh shares an existing in-flight read. */
export function createPreparationCache<T>(limit = 40) {
  const entries = new Map<string, { promise: Promise<T>; settled: boolean }>();
  let tail: Promise<unknown> = Promise.resolve();
  return {
    read(key: string, load: () => Promise<T>, retry = false): Promise<T> {
      const cached = entries.get(key);
      if (cached && (!retry || !cached.settled)) return cached.promise;
      if (cached) entries.delete(key);
      const pending = tail.catch(() => {}).then(load);
      const entry = { promise: pending, settled: false };
      tail = pending.catch(() => {});
      entries.set(key, entry);
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
      void pending.then(() => { entry.settled = true; }, () => {
        entry.settled = true;
        if (entries.get(key) === entry) entries.delete(key);
      });
      return pending;
    },
  };
}
