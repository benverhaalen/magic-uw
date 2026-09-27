import { useId, useState } from "react";
import type {
  Command,
  ConsentRecord,
  PrivacyPreferences,
  Snapshot,
} from "@magic/contracts";
import {
  CONSENT_DISCLOSURE_VERSION,
  hasCurrentConsent,
} from "../../../../../packages/domain/src/index";
import "./consent.css";

/** Exact texts (tasks.md T06; the UW note as revised by the lead for T05e). */
export const canvasDisclosure =
  "Magic Canvas reads your courses the way you would by opening them. Canvas can record these as page views, and reading a module item can satisfy a \"must view\" requirement. Magic Canvas never submits, posts, enrolls or marks anything complete.";
export const uwSessionNote =
  "You sign in on UW's own page. If you choose Remember my sign-in, your NetID sign-in is saved encrypted on this computer only.";

type Recipient = ConsentRecord["recipient"];
const providerLabels: Record<PrivacyPreferences["hostedProvider"], string> = {
  none: "None yet",
  chatgpt: "ChatGPT",
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini",
  openrouter: "OpenRouter",
};
const recipientLabels: Record<Recipient, string> = {
  uw: "Reading UW with your sign-in",
  jev: "Jev",
  chatgpt: "ChatGPT",
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini",
  openrouter: "OpenRouter",
};

/** Recipients a privacy change would start sending to that still lack a current record. */
export function missingConsents(
  next: PrivacyPreferences,
  records: readonly ConsentRecord[] | undefined,
): Recipient[] {
  if (next.mode !== "selective_cloud") return [];
  const needed: Recipient[] = ["uw"];
  if (next.jevEnabled) needed.push("jev");
  if (next.hostedProvider !== "none") needed.push(next.hostedProvider);
  return needed.filter((recipient) => !hasCurrentConsent(records, recipient));
}
export function hasUwConsent(snapshot: Snapshot | null): boolean {
  return hasCurrentConsent(snapshot?.consents, "uw");
}
function grant(recipient: Recipient): Command {
  return {
    type: "consent",
    value: {
      action: "grant",
      recipient,
      disclosureVersion: CONSENT_DISCLOSURE_VERSION,
    },
  };
}

/**
 * The one-checkbox setup screen (spec G1), also used for a new provider's consent and for
 * withdrawing an agreement. `pending` is a Data & AI change waiting on consent; it is saved
 * only after the student agrees.
 */
export function ConsentSetup({
  snapshot,
  busy,
  pending,
  canSignIn,
  runAll,
  onAgreedToSetup,
  onSample,
  onClose,
  embedded = false,
}: {
  /** Inside Home's empty state: Home already has the page title, so this uses a section heading. */
  embedded?: boolean;
  snapshot: Snapshot;
  busy: boolean;
  pending: PrivacyPreferences | null;
  canSignIn: boolean;
  runAll: (commands: Command[]) => Promise<unknown>;
  onAgreedToSetup: () => unknown;
  onSample: () => unknown;
  onClose: (() => unknown) | null;
}) {
  const [agreed, setAgreed] = useState(false);
  const checkboxId = useId();
  const records = snapshot.consents ?? [];
  const setupDone = hasCurrentConsent(records, "uw");
  const preferences = pending ?? snapshot.privacy;
  const provider = preferences.hostedProvider;
  const missing = pending ? missingConsents(pending, records) : [];
  const setup = !setupDone;
  const providerOnly = setupDone && missing.length > 0;

  // The setup checkbox covers UW, Jev and the chosen provider at once (spec G1).
  const setupGrants: Recipient[] = [
    "uw",
    "jev",
    ...(provider !== "none" ? [provider] : []),
  ];
  const agree = async () => {
    if (!agreed) return;
    const commands = (setup ? setupGrants : missing).map(grant);
    if (pending) commands.push({ type: "privacy", value: pending });
    const result = await runAll(commands);
    if (!result) return;
    setAgreed(false);
    if (setup) onAgreedToSetup();
    else onClose?.();
  };

  if (!setup && !providerOnly)
    return (
      <div className="settings-page consent-page">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Your data, your choice</p>
            <h1>Agreements</h1>
          </div>
          {onClose ? (
            <button className="button" onClick={() => onClose()}>
              Done
            </button>
          ) : null}
        </div>
        <section className="settings-section">
          <p>
            Withdrawing stops future requests to that recipient. It cannot
            retract data already sent. Saved coursework stays on this device.
          </p>
          <ul className="consent-records">
            {records.map((record) => (
              <li key={record.recipient}>
                <span>
                  <strong>{recipientLabels[record.recipient]}</strong>
                  <span className="small muted">
                    Agreed{" "}
                    {new Intl.DateTimeFormat(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    }).format(new Date(record.grantedAt))}
                    {record.disclosureVersion === CONSENT_DISCLOSURE_VERSION
                      ? ""
                      : " · an earlier disclosure; agree again to use it"}
                  </span>
                </span>
                <button
                  className="subtle-button"
                  disabled={busy}
                  onClick={() =>
                    void runAll([
                      {
                        type: "consent",
                        value: { action: "revoke", recipient: record.recipient },
                      },
                    ])
                  }
                >
                  Withdraw
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    );

  const heading = setup
    ? "Before Magic Canvas connects"
    : `Share with ${missing
        .filter((r) => r !== "uw")
        .map((r) => recipientLabels[r])
        .join(" and ")}?`;
  return (
    <div className={`settings-page consent-page${embedded ? " consent-embedded" : ""}`}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{setup ? "One step" : "New recipient"}</p>
          {embedded ? <h2 className="consent-title">{heading}</h2> : <h1>{heading}</h1>}
        </div>
      </div>
      {setup ? (
        <section className="settings-section" aria-labelledby="consent-uw">
          <h2 id="consent-uw">Reading UW</h2>
          <p className="consent-disclosure">{canvasDisclosure}</p>
          <p className="consent-disclosure">{uwSessionNote}</p>
        </section>
      ) : null}
      <section className="settings-section" aria-labelledby="consent-recipients">
        <h2 id="consent-recipients">Who receives what</h2>
        <dl className="consent-recipients">
          {setup || missing.includes("jev") ? (
            <>
              <dt>Jev</dt>
              <dd>
                Our judgment service, run with TypeSafe. Purpose: sorting your
                course items (for example, essay or problem set). Receives the
                course name, item title, instructions and policy text, only
                after you turn Jev on in Data &amp; AI. Our key stays on our
                server.
              </dd>
            </>
          ) : null}
          <dt>Your AI</dt>
          <dd>
            {providerLabels[provider]}
            {provider === "none"
              ? ". Nothing is sent to an AI provider until you choose one; it asks for its own agreement then."
              : `. Purpose: the study and course features you use. Receives only the categories you turn on in Data & AI. ${providerLabels[provider]}’s own account settings (such as training and retention) apply to what it receives.`}
          </dd>
          <dt>Asked first</dt>
          <dd>
            The first time your work, grades, grader comments or messages would
            be shared with a service, you see exactly what would be sent and
            choose. &ldquo;Always preview&rdquo; asks every time.
          </dd>
          <dt>Never sent</dt>
          <dd>
            Degree plans, holds and audits stay on this device. Fully local mode
            sends nothing to any AI.
          </dd>
        </dl>
        <p className="small">
          To withdraw, open Data &amp; AI, then Agreements. Withdrawing stops
          future requests; it cannot retract data already sent.
        </p>
      </section>
      <section className="settings-section consent-agree">
        <label className="consent-check" htmlFor={checkboxId}>
          <input
            id={checkboxId}
            type="checkbox"
            checked={agreed}
            disabled={busy}
            onChange={(event) => setAgreed(event.target.checked)}
          />
          <span>
            {setup
              ? "I agree: Magic Canvas may read UW with my sign-in, and share what I allow with the recipients above."
              : "I agree to share what I allow with this recipient."}
          </span>
        </label>
        <div className="inline-actions">
          <button
            className="button primary"
            disabled={busy || !agreed}
            onClick={() => void agree()}
          >
            {setup
              ? canSignIn
                ? "Continue to UW sign-in"
                : "Agree"
              : "Agree and save"}
          </button>
          {onClose ? (
            <button className="subtle-button" disabled={busy} onClick={() => onClose()}>
              {setup ? "Not now" : "Cancel"}
            </button>
          ) : null}
        </div>
      </section>
      {setup ? (
        <section className="consent-sample">
          <button
            className="subtle-button sample-button"
            disabled={busy}
            onClick={() => onSample()}
          >
            Load sample course <span aria-hidden="true">↗</span>
          </button>
          <p className="small muted">
            Synthetic coursework. No account and no network needed.
          </p>
        </section>
      ) : null}
    </div>
  );
}
