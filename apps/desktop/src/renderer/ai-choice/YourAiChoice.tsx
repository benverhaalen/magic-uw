// owner: ai-choice. "Your AI" on Data & AI: one row of choices for who answers. Claude Code, Codex,
// "On this computer" (shown only once Ollama is found) and Off; Gemini shows only while it is the
// saved choice. Each card shows its status (Connected, Signed out, Not installed, Usage limit). A hosted
// choice is the send gate's own state (`hostedProvider` with cloud access on, agreement first) plus the
// client the generation runner uses (`clients.choose`). Ported from feat/floating-chat (c82fa42).
import { useEffect, useId, useState } from "react";
import type { ClientHealth, ClientId, LocalStatus, PrivacyPreferences } from "@magic/contracts";
import { LocalAiPanel } from "../LocalAiPanel";
import { clientInfo } from "../onboarding/model";
import {
  aiChoiceOf,
  aiChoicePatch,
  choiceName,
  isChecking,
  rememberClientHealth,
  statusLine,
  useClientHealths,
  useLocalChoice,
  writeLocalChoice,
  type AiChoice,
} from "./answering";

const HOSTED: readonly ClientId[] = ["claude", "codex", "gemini"];

/** Which choices the row shows: Gemini only while chosen, this computer only once found. */
export function shownChoices(current: AiChoice, localFound: boolean): AiChoice[] {
  return [
    "claude",
    "codex",
    ...(current === "gemini" ? ["gemini" as const] : []),
    ...(localFound || current === "local" ? ["local" as const] : []),
    "off",
  ];
}

/** The one Advanced toggle: a separate sign-in (the app-owned profile) instead of the student's own. */
export const SEPARATE_SIGN_IN = {
  label: "Use a separate sign-in for My Magic UW",
  sentence: "Normally My Magic UW uses the sign-in you already have in that app; turn this on to sign in once just for My Magic UW, kept apart from your own setup.",
} as const;

export function YourAiChoice({ privacy, busy, onChange, onSignIn, openExternal }: {
  privacy: PrivacyPreferences;
  busy: boolean;
  /** The page's own save: opens the agreement first when the choice needs one. */
  onChange: (patch: Partial<PrivacyPreferences>) => unknown;
  /** Opens setup at its "Your AI" step, where the sign-in happens. */
  onSignIn: (id: ClientId) => void;
  openExternal: (url: string) => void;
}) {
  const name = useId();
  const localOn = useLocalChoice();
  const current = aiChoiceOf(privacy, localOn);
  const health = useClientHealths(HOSTED.filter((id) => id !== "gemini" || current === "gemini"));
  const [local, setLocal] = useState<LocalStatus | null>(null);
  const [problem, setProblem] = useState("");
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    let live = true;
    window.magic?.localStatus?.().then((value) => { if (live) setLocal(value); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const localFound = local?.status === "ready" || local?.cloudDisabled === true;
  const pick = async (choice: AiChoice) => {
    setProblem("");
    if (choice !== "local" && choice !== "off") {
      // The runner answers with the chosen client; the send gate allows only the selected one.
      try { await window.magic?.clients?.choose(choice); } catch { setProblem(`Could not select ${choiceName(choice)}.`); return; }
    }
    writeLocalChoice(choice === "local");
    const patch = aiChoicePatch(privacy, choice);
    if (patch) onChange(patch);
  };
  const chosenHealth: ClientHealth | null = current === "claude" || current === "codex" ? health[current] ?? null : null;
  const canSeparate = !!chosenHealth && chosenHealth.modes.includes("isolated") && chosenHealth.modes.includes("instant") && !!window.magic?.clients?.setMode;
  const setSeparate = async (on: boolean) => {
    if (!chosenHealth || !window.magic?.clients?.setMode) return;
    setSwitching(true);
    setProblem("");
    try { rememberClientHealth(await window.magic.clients.setMode(chosenHealth.id, on ? "isolated" : "instant")); }
    catch (error) { setProblem(error instanceof Error && error.message.length < 200 ? error.message : "That sign-in choice could not be saved."); }
    finally { setSwitching(false); }
  };
  const describe = (choice: AiChoice) =>
    choice === "local" ? (local?.status === "ready" ? "Ready (Ollama). Nothing leaves this computer." : "Found Ollama. Nothing leaves this computer.")
      : choice === "off" ? "No AI answers. Courses are still read and organised."
        : null;
  return <>
    <fieldset className="mode-choices your-ai-choices" disabled={busy}>
      <legend className="visually-hidden">Who answers</legend>
      {shownChoices(current, localFound).map((choice) => {
        const hosted = choice !== "local" && choice !== "off";
        const status = hosted ? statusLine(health[choice], isChecking(choice)) : null;
        return <div key={choice} className={`mode-choice your-ai-card${current === choice ? " selected-mode" : ""}`}>
          <label>
            <input type="radio" name={name} data-focus-key={`privacy-ai-${choice}`} checked={current === choice} onChange={() => void pick(choice)}/>
            <span>
              <strong>{choiceName(choice)}</strong>
              {status ? <span className="your-ai-status" data-tone={status.tone}>{status.text}</span> : <span>{describe(choice)}</span>}
            </span>
          </label>
          {hosted && status?.action === "sign_in" ? <button type="button" className="subtle-button" onClick={() => onSignIn(choice)}>Sign in</button> : null}
          {hosted && status?.action === "install" ? <button type="button" className="subtle-button" onClick={() => openExternal(clientInfo[choice].installUrl)}>Get it ↗</button> : null}
        </div>;
      })}
    </fieldset>
    {current === "local" ? <LocalAiPanel privacyKey={JSON.stringify(privacy)}/> : null}
    {canSeparate && chosenHealth ? <details className="privacy-local-details your-ai-advanced">
      <summary>Advanced</summary>
      <label className="setting-toggle">
        <span><strong>{SEPARATE_SIGN_IN.label}</strong><span>{SEPARATE_SIGN_IN.sentence}</span></span>
        <input type="checkbox" role="switch" data-focus-key="privacy-separate-sign-in" checked={chosenHealth.mode === "isolated"} disabled={busy || switching} onChange={(event) => void setSeparate(event.target.checked)}/>
      </label>
    </details> : null}
    {problem ? <p className="attention-text" role="alert">{problem}</p> : null}
  </>;
}
