// owner: ai-choice. "Before sharing course data": when the payload preview appears, mapped exactly onto
// the existing `alwaysPreview` preference. Consent grants are enforced on every request either way;
// this only decides whether the preview shows before every send or only a kind's first.
import type { PrivacyPreferences } from "@magic/contracts";

export type SharingChoice = "first_time" | "every_time" | "never";

export interface SharingOption {
  id: SharingChoice;
  label: string;
  sentence: string;
  /** False when the app cannot honour it (see `never`). */
  available: boolean;
}

export const SHARING_OPTIONS: readonly SharingOption[] = [
  {
    id: "first_time",
    label: "Ask the first time for each kind",
    sentence: "The first time your work, grades, grader comments or messages would go to an AI service, you see exactly what would be sent and decide.",
    available: true,
  },
  {
    id: "every_time",
    label: "Ask every time",
    sentence: "Before every request to an AI service, you see exactly what would be sent, and nothing goes until you approve it.",
    available: true,
  },
  {
    // The send gate always previews a newly shared sensitive kind (egress.ts, AGENTS.md); no stored
    // preference turns that off, so this option is shown but cannot be chosen.
    id: "never",
    label: "Don't ask; follow my settings",
    sentence: "Not available: My Magic UW always shows you a new kind of personal data before it is shared the first time.",
    available: false,
  },
];

export const sharingOf = (privacy: Pick<PrivacyPreferences, "alwaysPreview">): SharingChoice =>
  privacy.alwaysPreview === true ? "every_time" : "first_time";

/** The preference change for a choice; null when the choice is unavailable or already set. */
export function sharingPatch(privacy: Pick<PrivacyPreferences, "alwaysPreview">, choice: SharingChoice): Partial<PrivacyPreferences> | null {
  if (choice === "never" || choice === sharingOf(privacy)) return null;
  return { alwaysPreview: choice === "every_time" };
}
