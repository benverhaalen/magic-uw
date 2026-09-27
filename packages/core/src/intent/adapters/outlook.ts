import { adaptPlain, plainActions } from "../adapters";
import type { AnyAction } from "../registry";

/** feat/outlook-graph: `mail.search` and `calendar.proposeEvent` (a proposal; the student confirms in Outlook). */
export function fromOutlook(mod: unknown): AnyAction[] {
  return plainActions(mod)
    .filter((a) => a.name === "mail.search" || a.name === "calendar.proposeEvent")
    .map(adaptPlain);
}
