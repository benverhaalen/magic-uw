// owner: ai-choice. "Before sharing": when the payload preview appears, mapped exactly onto the
// existing `alwaysPreview` preference. Consent grants are enforced on every request either way; this
// only decides whether the preview shows before every send or only a kind's first. There is no
// "don't ask" option: the send gate always previews a newly shared sensitive kind (AGENTS.md).
import type { PrivacyPreferences } from "@magic/contracts";

export type SharingChoice = "first_time" | "every_time";

export interface SharingOption {
  id: SharingChoice;
  label: string;
  sentence: string;
}

export const SHARING_OPTIONS: readonly SharingOption[] = [
  {
    id: "first_time",
    label: "Ask the first time for each kind",
    sentence: "The first time your work, grades or messages would go to an AI, you see exactly what would be sent and decide.",
  },
  {
    id: "every_time",
    label: "Ask every time",
    sentence: "Before every request to an AI, you see exactly what would be sent, and nothing goes until you approve it.",
  },
];

export const sharingOf = (privacy: Pick<PrivacyPreferences, "alwaysPreview">): SharingChoice =>
  privacy.alwaysPreview === true ? "every_time" : "first_time";

/** The preference change for a choice; null when it is already set. */
export function sharingPatch(privacy: Pick<PrivacyPreferences, "alwaysPreview">, choice: SharingChoice): Partial<PrivacyPreferences> | null {
  if (choice === sharingOf(privacy)) return null;
  return { alwaysPreview: choice === "every_time" };
}
