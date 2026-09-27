// owner: account-card. The card the sidebar's account avatar shows on hover and keyboard focus: who is
// signed in, how fresh Canvas is, which AI answers, how many sources are connected, and a way into
// Data & AI. It reads the snapshot and the cached client-health check; it starts no reads of its own
// beyond that one health check, which the chat header and settings share.
import type { Snapshot } from "@magic/contracts";
import { answering, useClientHealth, useLocalChoice, aiChoiceOf } from "../ai-choice/answering";
import { accountSummary } from "./summary";

export const ACCOUNT_CARD_ID = "desktop-account-card";

export function AccountCard({ snapshot, open, onOpenSettings }: { snapshot: Snapshot; open: boolean; onOpenSettings: () => void }) {
  const localOn = useLocalChoice();
  const health = useClientHealth(aiChoiceOf(snapshot.privacy, localOn), open);
  const ai = answering(snapshot.privacy, snapshot.consents ?? [], localOn, health);
  const summary = accountSummary(snapshot, new Date(snapshot.generatedAt));
  return <>
    <p className="desktop-account-name" id={`${ACCOUNT_CARD_ID}-name`}>{summary.name}</p>
    <dl className="desktop-account-facts" id={`${ACCOUNT_CARD_ID}-facts`}>
      <div><dt>UW sign-in</dt><dd>{summary.uw}</dd></div>
      <div><dt>Canvas</dt><dd>{summary.canvas}</dd></div>
      <div><dt>Your AI</dt><dd>{ai.label}{ai.detail ? <span className="desktop-account-detail">{ai.detail}</span> : null}</dd></div>
      <div><dt>Connected</dt><dd>{summary.sources}</dd></div>
    </dl>
    <button type="button" className="desktop-account-link" onClick={onOpenSettings}>Data &amp; AI settings</button>
  </>;
}
