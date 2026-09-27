import { adaptPlain, plainActions } from "../adapters";
import type { AnyAction } from "../registry";

/** feat/notes-connect exports `notesActions` from packages/notes/src/actions.ts. */
export function fromNotes(mod: unknown): AnyAction[] {
  return plainActions((mod as { notesActions?: unknown } | undefined)?.notesActions).map(adaptPlain);
}
