// owner: ai-choice. The "Before sharing course data" choice, on Data & AI and on an item page. Uses the
// settings page's existing selectable cards (.mode-choices).
import { useId } from "react";
import type { PrivacyPreferences } from "@magic/contracts";
import { SHARING_OPTIONS, sharingOf, sharingPatch, type SharingChoice as Choice } from "./sharing";

export function SharingChoice({ privacy, disabled, onChange, legend = "Before sharing course data" }: {
  privacy: PrivacyPreferences;
  disabled: boolean;
  onChange: (patch: Partial<PrivacyPreferences>) => void;
  legend?: string;
}) {
  const name = useId();
  const current = sharingOf(privacy);
  const pick = (choice: Choice) => { const patch = sharingPatch(privacy, choice); if (patch) onChange(patch); };
  return <fieldset className="mode-choices sharing-choices" disabled={disabled}>
    <legend>{legend}</legend>
    {SHARING_OPTIONS.map((option) => <label key={option.id} className={`mode-choice${current === option.id ? " selected-mode" : ""}`}>
      <input type="radio" name={name} checked={current === option.id} disabled={!option.available} onChange={() => pick(option.id)}/>
      <span><strong>{option.label}</strong><span>{option.sentence}</span></span>
    </label>)}
  </fieldset>;
}
