import { adaptPlain, plainActions } from "../adapters";
import type { AnyAction } from "../registry";

/** feat/practice-analytics: its read-only ops (e.g. "how am I doing in CS 400"). */
export function fromAnalytics(mod: unknown): AnyAction[] {
  return plainActions(mod).filter((a) => a.name.startsWith("analytics.")).map(adaptPlain);
}
