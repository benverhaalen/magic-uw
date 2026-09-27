import type { Resource, Store } from "@magic/contracts";

/**
 * The store as one call sees it after reading `store.resources()` itself: the unsearched list is
 * served from `all` instead of read and decoded again (a helper such as `evidenceFor` or
 * `courseInclusion` reads every resource). Everything else is the store. A call only reads, so
 * the list cannot go stale within it; build one per call and drop it.
 */
export function readOnce<S extends Store>(store: S, all: Resource[]): S {
  return Object.create(store, {
    resources: { value: (search?: string) => (search?.trim() ? store.resources(search) : all) },
  }) as S;
}
