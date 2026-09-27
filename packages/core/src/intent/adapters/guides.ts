import { adaptPlain, plainActions } from "../adapters";
import type { AnyAction } from "../registry";

/** feat/study-guides: `guide.view` (the guide packs run through it). */
export function fromGuides(mod: unknown): AnyAction[] {
  return plainActions(mod).filter((a) => a.name.startsWith("guide.")).map(adaptPlain);
}
