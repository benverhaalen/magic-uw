import { adaptPlain, plainActions } from "../adapters";
import type { AnyAction } from "../registry";

/** feat/material-pipeline: `agenda` (the day's classes, readings and due work). */
export function fromPipeline(mod: unknown): AnyAction[] {
  return plainActions(mod).filter((a) => a.name === "agenda" || a.name.startsWith("agenda.")).map(adaptPlain);
}
