// owner: reconfigure. What "Reconfigure My Magic UW" clears, in order, before onboarding opens at its
// first step. Only the AI client setup: courses, notes, sign-ins and agreements stay.
import type { ClientsBridge, Command, PrivacyPreferences } from "@magic/contracts";
import { resetClientHealthCache, writeLocalChoice } from "../ai-choice/answering";
import { emptyProgress, writeProgress } from "../onboarding/model";

export interface ReconfigureDeps {
  clients: Pick<ClientsBridge, "reset"> | undefined;
  privacy: PrivacyPreferences;
  /** The app's command runner; resolves undefined when the command failed. */
  run: (command: Command) => Promise<unknown>;
  /** Defaults to the renderer's own caches and storage; tests pass fakes. */
  clearHealth?: () => void;
  clearLocalChoice?: () => void;
  restartProgress?: () => void;
}

/** Resolves when the reset finished; throws with plain words when the app's client setup could not be cleared. */
export async function resetForReconfigure(deps: ReconfigureDeps): Promise<void> {
  if (!deps.clients?.reset) throw new Error("Reconfiguring needs the desktop app.");
  await deps.clients.reset();
  (deps.clearHealth ?? resetClientHealthCache)();
  (deps.clearLocalChoice ?? (() => writeLocalChoice(false)))();
  if (deps.privacy.hostedProvider !== "none") await deps.run({ type: "privacy", value: { ...deps.privacy, hostedProvider: "none" } });
  // `started` keeps onboarding showing although courses are already saved (needsOnboarding).
  (deps.restartProgress ?? (() => writeProgress({ ...emptyProgress, started: true })))();
}
