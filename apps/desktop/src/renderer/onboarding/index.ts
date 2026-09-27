import type { Snapshot } from "@magic/contracts";
import { hasCurrentConsent } from "../../../../../packages/domain/src/index";
import { needsOnboarding, readProgress } from "./model";

export { Onboarding, type OnboardingProps } from "./Onboarding";

/** True on first run and while setup is incomplete (reads the saved step state). */
export function needsFirstRunSetup(snapshot: Snapshot): boolean {
  return needsOnboarding(snapshot, readProgress(), hasCurrentConsent);
}
