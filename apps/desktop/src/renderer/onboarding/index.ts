import type { Snapshot } from "@magic/contracts";
import { hasCurrentConsent } from "../../../../../packages/domain/src/index";
import { startAppearance } from "../appearance";
import { needsOnboarding, readProgress } from "./model";

export { Onboarding, type OnboardingProps } from "./Onboarding";
export { ClientHealthNotice, type ClientHealthNoticeProps } from "./ClientHealthNotice"; // owner: client-health

// owner: client-health (D51). The saved appearance applies at launch: App imports this module
// before its first render, so the root carries data-theme and data-accent from the start.
startAppearance();

/** True on first run and while setup is incomplete (reads the saved step state). */
export function needsFirstRunSetup(snapshot: Snapshot): boolean {
  return needsOnboarding(snapshot, readProgress(), hasCurrentConsent);
}
