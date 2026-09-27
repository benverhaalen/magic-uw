// owner: ai-choice. "Your AI": one choice of who answers, on Data & AI (onboarding sets it first).
// Claude Code, Codex, Gemini (shown once it is ready or chosen), "On this computer (Ollama)" (shown once
// Ollama was found, by an explicit check) and "Off". A hosted choice is the send gate's own state
// (`hostedProvider` with cloud access on, agreement first) plus the client the generation runner uses
// (`clients.choose`). Ollama is not a separate panel on each item any more: it answers in chat, and its
// setup helper shows here when it is chosen.
import { useId, useState } from "react";
import type { ClientId, LocalStatus, PrivacyPreferences } from "@magic/contracts";
import { LocalAiPanel } from "../LocalAiPanel";
import { aiChoiceOf, choiceName, healthLine, useClientHealths, useLocalChoice, writeLocalChoice, type AiChoice } from "./answering";

const HOSTED: readonly ClientId[] = ["claude", "codex", "gemini"];

/** The preference change for a choice (null: none needed). Local and Off both mean "no hosted AI". */
export function aiChoicePatch(privacy: PrivacyPreferences, choice: AiChoice): Partial<PrivacyPreferences> | null {
  if (choice === "local" || choice === "off") return privacy.hostedProvider === "none" ? null : { hostedProvider: "none" };
  if (privacy.hostedProvider === choice && privacy.mode === "selective_cloud") return null;
  return { hostedProvider: choice, mode: "selective_cloud" };
}

export function YourAiChoice({ privacy, busy, onChange }: {
  privacy: PrivacyPreferences;
  busy: boolean;
  /** The page's own save: opens the agreement first when the choice needs one. */
  onChange: (patch: Partial<PrivacyPreferences>) => unknown;
}) {
  const name = useId();
  const localOn = useLocalChoice();
  const current = aiChoiceOf(privacy, localOn);
  const health = useClientHealths(HOSTED);
  const [local, setLocal] = useState<LocalStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState("");
  const ollamaFound = localOn || local?.status === "ready" || local?.cloudDisabled === true;
  const canCheckOllama = typeof window !== "undefined" && !!window.magic?.localStatus;
  const shown: AiChoice[] = [
    "claude", "codex",
    ...(current === "gemini" || health.gemini?.state === "ok" ? ["gemini" as const] : []),
    ...(ollamaFound ? ["local" as const] : []),
    "off",
  ];
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
  const checkOllama = async () => {
    if (!window.magic?.localStatus) return;
    setChecking(true);
    try { setLocal(await window.magic.localStatus()); } catch (error) { setProblem(error instanceof Error ? error.message : "Could not check for Ollama."); } finally { setChecking(false); }
  };
  const describe = (choice: AiChoice) =>
    choice === "local" ? "Answers from a model on this computer through Ollama. Nothing leaves this computer."
      : choice === "off" ? "No AI answers. Your courses are still read and organised; chat answers deadlines and finds saved items."
        : `${healthLine(health[choice])}. Uses your own ${choice === "gemini" ? "Gemini key" : "account"}; you agree to what it receives before anything is sent.`;
  return <>
    <fieldset className="mode-choices" disabled={busy}>
      <legend>Who answers</legend>
      {shown.map((choice) => <label key={choice} className={`mode-choice${current === choice ? " selected-mode" : ""}`}>
        <input type="radio" name={name} checked={current === choice} onChange={() => void pick(choice)}/>
        <span><strong>{choiceName(choice)}</strong><span>{describe(choice)}</span></span>
      </label>)}
    </fieldset>
    {!ollamaFound && canCheckOllama ? <p className="small muted">
      <button className="subtle-button" disabled={checking || busy} onClick={() => void checkOllama()}>{checking ? "Checking…" : "Check for Ollama on this computer"}</button>
      {local ? <span role="status"> {local.reason}</span> : null}
    </p> : null}
    {current === "local" ? <LocalAiPanel privacyKey={JSON.stringify(privacy)}/> : null}
    {problem ? <p className="attention-text" role="alert">{problem}</p> : null}
  </>;
}
