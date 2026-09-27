import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Command, CommandResult, Snapshot } from "@magic/contracts";
import {
  CONSENT_DISCLOSURE_VERSION,
  hasCurrentConsent,
} from "../../../../../packages/domain/src/index";
import { ConsentSetup } from "../consent/ConsentSetup";
import {
  clientInfo,
  createPreviewClients,
  firstIncompleteStep,
  orderedClients,
  readProgress,
  steps,
  summarize,
  writeProgress,
  type ClientId,
  type ClientStatus,
  type ClientsBridge,
  type OnboardingProgress,
  type StepId,
} from "./model";
import "./onboarding.css";

/**
 * T81 first-run onboarding: Welcome → Your AI → Connect → UW → Populating.
 * Composes T06's ConsentSetup for the UW step and codes against the T80 client bridge
 * (a local type in ./model until integration). Without the bridge (the browser preview) it
 * runs on a labelled preview fixture.
 */

type Bridge = { clients?: ClientsBridge };
const previewBridge = createPreviewClients();
function clientsBridge(): { clients: ClientsBridge; preview: boolean } {
  const live = (window.magic as unknown as Bridge | undefined)?.clients;
  return live ? { clients: live, preview: false } : { clients: previewBridge, preview: true };
}

// Lucide paths (ISC licence), drawn at 20 × 20 on a 24 grid with the design seed's stroke.
const iconPaths = {
  back: <path d="m15 18-6-6 6-6" />,
  check: <path d="M20 6 9 17l-5-5" />,
  external: (
    <>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>
  ),
  alert: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  terminal: (
    <>
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </>
  ),
};
function Icon({ name, className }: { name: keyof typeof iconPaths; className?: string }) {
  return (
    <svg
      className={`onb-icon${className ? ` ${className}` : ""}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {iconPaths[name]}
    </svg>
  );
}
function Spinner() {
  return <span className="onb-spinner" aria-hidden="true" />;
}

export interface OnboardingProps {
  snapshot: Snapshot;
  busy: boolean;
  error: string;
  onDismissError: () => void;
  /** App's command runner (returns undefined on failure). */
  run: (command: Command) => Promise<CommandResult | undefined>;
  /** App's runner for several commands; ConsentSetup uses it. */
  runAll: (commands: Command[]) => Promise<unknown>;
  canSignIn: boolean;
  /** The existing UW sign-in (then Canvas sync). */
  signIn: () => Promise<unknown>;
  openExternal: (url: string) => void;
  onLoadSample: () => Promise<CommandResult | undefined>;
  onFinish: () => void;
  /** The built-in terminal (TerminalPane, another seat). A placeholder shows when absent. */
  renderTerminal?: (sessionId: string) => ReactNode;
}

export function Onboarding(props: OnboardingProps) {
  const { snapshot, busy, error, onDismissError } = props;
  const { clients, preview } = useMemo(clientsBridge, []);
  const [progress, setProgressState] = useState<OnboardingProgress>(() => readProgress());
  const [step, setStep] = useState<StepId>(() =>
    firstIncompleteStep(snapshot, readProgress(), hasCurrentConsent),
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  const update = useCallback((change: Partial<OnboardingProgress>) => {
    setProgressState((current) => {
      const next = { ...current, ...change };
      writeProgress(next);
      return next;
    });
  }, []);

  // Focus the new step's heading so keyboard and screen-reader users land at its start.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const index = steps.findIndex((entry) => entry.id === step);
  const loadSample = async () => {
    const result = await props.onLoadSample();
    if (result?.snapshot?.resources.length) setStep("populating");
  };
  const back = index > 0 ? () => setStep(steps[index - 1].id) : null;
  const heading = (text: string) => (
    <h1 className="onb-title" id="onb-step-title" ref={headingRef} tabIndex={-1}>
      {text}
    </h1>
  );

  let body: ReactNode;
  if (step === "welcome")
    body = (
      <Welcome
        heading={heading}
        onStart={() => {
          update({ welcomed: true });
          setStep("ai");
        }}
      />
    );
  else if (step === "ai")
    body = (
      <ChooseClient
        heading={heading}
        clients={clients}
        preview={preview}
        initial={progress.client === "later" ? null : progress.client}
        openExternal={props.openExternal}
        onBack={back}
        onChoose={(id) => {
          update({ client: id, clientConnected: progress.client === id && progress.clientConnected });
          setStep("connect");
        }}
        onLater={() => {
          update({ client: "later", clientConnected: false });
          setStep("uw");
        }}
      />
    );
  else if (step === "connect" && progress.client && progress.client !== "later")
    body = (
      <ConnectClient
        key={progress.client}
        heading={heading}
        id={progress.client}
        clients={clients}
        preview={preview}
        snapshot={snapshot}
        busy={busy}
        run={props.run}
        renderTerminal={props.renderTerminal}
        onBack={back}
        onConnected={() => {
          update({ clientConnected: true });
          setStep("uw");
        }}
      />
    );
  else if (step === "connect")
    // Set up later skipped this step; Back from UW lands on the client choice instead.
    body = (
      <SkippedConnect heading={heading} onBack={() => setStep("ai")} onNext={() => setStep("uw")} />
    );
  else if (step === "uw")
    body = (
      <ConnectUw
        heading={heading}
        snapshot={snapshot}
        busy={busy}
        canSignIn={props.canSignIn}
        runAll={props.runAll}
        onLoadSample={loadSample}
        onBack={back}
        onSignIn={async () => {
          update({ uwStarted: true });
          setStep("populating");
          if (props.canSignIn) await props.signIn();
        }}
      />
    );
  else
    body = (
      <Populating
        heading={heading}
        snapshot={snapshot}
        busy={busy}
        noClient={progress.client === "later"}
        onLoadSample={loadSample}
        onBack={back}
        onFinish={() => {
          update({ done: true });
          props.onFinish();
        }}
      />
    );

  return (
    <div className="onb">
      <header className="onb-bar">
        <span className="onb-wordmark">Magic Canvas</span>
        <span className="onb-bar-end">
          {preview ? (
            <span className="onb-preview-flag">Preview: sample AI clients, not detected</span>
          ) : null}
          {snapshot.fixtureMode ? <span className="onb-preview-flag">Synthetic sample</span> : null}
        </span>
      </header>
      <main className="onb-surface">
        <div className="onb-column">
          <ol className="onb-steps" aria-label="Setup progress">
            {steps.map((entry, position) => (
              <li
                key={entry.id}
                className={position < index ? "done" : position === index ? "current" : ""}
                aria-current={position === index ? "step" : undefined}
              >
                <span className="onb-visually-hidden">
                  {entry.label}
                  {position < index ? ", done" : position === index ? ", current step" : ""}
                </span>
              </li>
            ))}
          </ol>
          {error ? (
            <div className="onb-alert" role="alert">
              <Icon name="alert" />
              <span>{error}</span>
              <button className="onb-quiet" onClick={onDismissError}>
                Dismiss
              </button>
            </div>
          ) : null}
          <section className="onb-step" key={step} aria-labelledby="onb-step-title">
            {body}
          </section>
        </div>
      </main>
    </div>
  );
}

type Heading = (text: string) => ReactNode;

function Actions({
  onBack,
  children,
}: {
  onBack: (() => void) | null;
  children: ReactNode;
}) {
  return (
    <div className="onb-actions">
      {onBack ? (
        <button className="onb-back" onClick={onBack}>
          <Icon name="back" />
          Back
        </button>
      ) : (
        <span />
      )}
      <div className="onb-actions-end">{children}</div>
    </div>
  );
}

function Welcome({ heading, onStart }: { heading: Heading; onStart: () => void }) {
  return (
    <div className="onb-welcome">
      {heading("Your classes, in one place.")}
      <p className="onb-lede">
        Magic Canvas reads your UW courses, keeps what matters on this computer, and helps you
        start the right work with sources you can check.
      </p>
      <Actions onBack={null}>
        <button className="onb-primary" onClick={onStart} autoFocus>
          Get started
        </button>
      </Actions>
    </div>
  );
}

function ChooseClient({
  heading,
  clients,
  preview,
  initial,
  openExternal,
  onBack,
  onChoose,
  onLater,
}: {
  heading: Heading;
  clients: ClientsBridge;
  preview: boolean;
  initial: ClientId | null;
  openExternal: (url: string) => void;
  onBack: (() => void) | null;
  onChoose: (id: ClientId) => void;
  onLater: () => void;
}) {
  const [statuses, setStatuses] = useState<ClientStatus[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<ClientId | null>(initial);
  const detect = useCallback(() => {
    setFailed(false);
    setStatuses(null);
    clients
      .detect()
      .then((found) => {
        const ordered = orderedClients(found);
        setStatuses(ordered);
        // Preselect the first installed client when nothing was chosen before.
        setSelected((current) =>
          current && ordered.some((s) => s.id === current && s.installed)
            ? current
            : (ordered.find((s) => s.installed)?.id ?? null),
        );
      })
      .catch(() => setFailed(true));
  }, [clients]);
  useEffect(detect, [detect]);

  return (
    <>
      {heading("Choose your AI")}
      <p className="onb-lede">
        Magic Canvas uses a separate profile of your AI, just for this app. Your own settings stay
        as they are.
      </p>
      {failed ? (
        <div className="onb-inline-status" role="status">
          <Icon name="alert" />
          <span>Could not check which AI clients are installed.</span>
          <button className="onb-quiet" onClick={detect}>
            Check again
          </button>
        </div>
      ) : !statuses ? (
        <div className="onb-inline-status" role="status">
          <Spinner />
          <span>Looking for Claude Code, Codex and Gemini CLI…</span>
        </div>
      ) : (
        <div className="onb-tiles" role="radiogroup" aria-label="AI client">
          {statuses.map((status) => {
            const info = clientInfo[status.id];
            const checked = selected === status.id;
            return (
              <div
                key={status.id}
                className={`onb-tile${checked ? " selected" : ""}${status.installed ? "" : " missing"}`}
              >
                <label className="onb-tile-choice">
                  <input
                    type="radio"
                    name="onb-client"
                    value={status.id}
                    checked={checked}
                    disabled={!status.installed}
                    onChange={() => setSelected(status.id)}
                  />
                  <span className="onb-tile-name">{info.name}</span>
                  <span className="onb-tile-meta">
                    {status.installed
                      ? status.version
                        ? `Version ${status.version}`
                        : "Installed"
                      : "Not installed"}
                  </span>
                  <span className="onb-tile-check" aria-hidden="true">
                    {checked ? <Icon name="check" /> : null}
                  </span>
                </label>
                {!status.installed ? (
                  <button
                    className="onb-link"
                    onClick={() => openExternal(status.installUrl ?? info.installUrl)}
                    aria-label={`How to install ${info.name} (opens in your browser)`}
                  >
                    How to install
                    <Icon name="external" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {preview && statuses ? (
        <p className="onb-note">
          Preview: these clients are sample data. The desktop app detects what is really
          installed.
        </p>
      ) : null}
      <Actions onBack={onBack}>
        <button className="onb-quiet" onClick={onLater}>
          Set up later
        </button>
        <button
          className="onb-primary"
          disabled={!selected}
          onClick={() => selected && onChoose(selected)}
        >
          Continue
        </button>
      </Actions>
      <p className="onb-note">
        Until an AI is connected, Magic Canvas still reads and organizes your courses; writing
        study material waits.
      </p>
    </>
  );
}

function ConnectClient({
  heading,
  id,
  clients,
  preview,
  snapshot,
  busy,
  run,
  renderTerminal,
  onBack,
  onConnected,
}: {
  heading: Heading;
  id: ClientId;
  clients: ClientsBridge;
  preview: boolean;
  snapshot: Snapshot;
  busy: boolean;
  run: (command: Command) => Promise<CommandResult | undefined>;
  renderTerminal?: (sessionId: string) => ReactNode;
  onBack: (() => void) | null;
  onConnected: () => void;
}) {
  const info = clientInfo[id];
  const agreed = hasCurrentConsent(snapshot.consents, info.recipient);
  const [session, setSession] = useState<string | null>(null);
  const [status, setStatus] = useState<ClientStatus | null>(null);
  const [problem, setProblem] = useState("");
  const [finishing, setFinishing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const signedIn = status?.signedIn === true;

  // Once agreed: prepare the app's own profile, then open the sign-in unless already signed in.
  useEffect(() => {
    if (!agreed) return;
    let cancelled = false;
    let opened: string | null = null;
    setProblem("");
    (async () => {
      try {
        await clients.prepare(id);
        const current = await clients.authStatus(id);
        if (cancelled) return;
        setStatus(current);
        if (current.signedIn === true) return;
        const { sessionId } = await clients.terminal.open(id, "signin");
        opened = sessionId;
        if (cancelled) void clients.terminal.close(sessionId);
        else setSession(sessionId);
      } catch {
        if (!cancelled) setProblem(`Could not start ${info.name} sign-in.`);
      }
    })();
    return () => {
      cancelled = true;
      if (opened) void clients.terminal.close(opened);
    };
  }, [agreed, clients, id, info.name, attempt]);

  // Poll the client's own sign-in state until it reports signed in.
  useEffect(() => {
    if (!agreed || signedIn) return;
    const timer = window.setInterval(() => {
      clients
        .authStatus(id)
        .then(setStatus)
        .catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [agreed, clients, id, signedIn]);

  if (!agreed)
    return (
      <>
        {heading(`Connect ${info.name}`)}
        <p className="onb-lede">
          Before anything is sent, here is what {info.provider} receives through {info.name}.
        </p>
        <dl className="onb-facts">
          <div>
            <dt>What is sent</dt>
            <dd>Passages from your courses, only when you ask for study material.</dd>
          </div>
          <div>
            <dt>Never sent</dt>
            <dd>Your passwords, your UW sign-in, or planning records such as degree audits.</dd>
          </div>
          <div>
            <dt>Who pays</dt>
            <dd>Usage counts toward your own {info.plan} or API key.</dd>
          </div>
          <div>
            <dt>Your settings</dt>
            <dd>The app signs in with its own {info.name} profile and never changes yours.</dd>
          </div>
        </dl>
        <Actions onBack={onBack}>
          <button
            className="onb-primary"
            disabled={busy}
            onClick={() =>
              void run({
                type: "consent",
                value: {
                  action: "grant",
                  recipient: info.recipient,
                  disclosureVersion: CONSENT_DISCLOSURE_VERSION,
                },
              })
            }
          >
            Agree and continue
          </button>
        </Actions>
        <p className="onb-note">You can withdraw this later in Data &amp; AI, then Agreements.</p>
      </>
    );

  const method =
    status?.method === "subscription"
      ? `with your ${info.plan}`
      : status?.method === "api-key"
        ? "with an API key"
        : "";
  return (
    <>
      {heading(`Sign in to ${info.name}`)}
      <p className="onb-lede">
        {signedIn
          ? `${info.name} is ready for Magic Canvas.`
          : `${info.name}'s own sign-in runs below, in a session separate from your usual one.`}
      </p>
      {!signedIn ? (
        <div className="onb-terminal-slot">
          {session && renderTerminal ? (
            renderTerminal(session)
          ) : (
            <div className="onb-terminal-placeholder">
              <Icon name="terminal" />
              <p>
                {session
                  ? preview
                    ? `Preview: ${info.name}'s sign-in would run here. It completes by itself in a few seconds.`
                    : `${info.name}'s sign-in terminal appears here.`
                  : `Starting ${info.name}…`}
              </p>
            </div>
          )}
        </div>
      ) : null}
      <div className={`onb-connection${signedIn ? " ok" : ""}`} role="status" aria-live="polite">
        {problem ? (
          <>
            <Icon name="alert" />
            <span>{problem}</span>
            <button className="onb-quiet" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </>
        ) : signedIn ? (
          <>
            <Icon name="check" className="onb-ok" />
            <span>
              Connected{method ? ` ${method}` : ""}
              {preview ? " (preview)" : ""}
            </span>
          </>
        ) : status?.signedIn === "unknown" ? (
          <>
            <Spinner />
            <span>Finish signing in above. {info.name} has not confirmed yet.</span>
          </>
        ) : (
          <>
            <Spinner />
            <span>Waiting for you to sign in to {info.name}…</span>
          </>
        )}
      </div>
      <Actions onBack={onBack}>
        <button
          className="onb-primary"
          disabled={!signedIn || finishing}
          onClick={async () => {
            setFinishing(true);
            try {
              await clients.choose(id);
              onConnected();
            } catch {
              setProblem(`Could not save ${info.name} as your AI.`);
            } finally {
              setFinishing(false);
            }
          }}
        >
          Continue
        </button>
      </Actions>
    </>
  );
}

function SkippedConnect({
  heading,
  onBack,
  onNext,
}: {
  heading: Heading;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <>
      {heading("No AI connected yet")}
      <p className="onb-lede">
        You chose to set up your AI later. Connect one any time from Data &amp; AI.
      </p>
      <Actions onBack={onBack}>
        <button className="onb-primary" onClick={onNext}>
          Continue
        </button>
      </Actions>
    </>
  );
}

function ConnectUw({
  heading,
  snapshot,
  busy,
  canSignIn,
  runAll,
  onLoadSample,
  onBack,
  onSignIn,
}: {
  heading: Heading;
  snapshot: Snapshot;
  busy: boolean;
  canSignIn: boolean;
  runAll: (commands: Command[]) => Promise<unknown>;
  onLoadSample: () => unknown;
  onBack: (() => void) | null;
  onSignIn: () => Promise<unknown>;
}) {
  const agreed = hasCurrentConsent(snapshot.consents, "uw");
  return (
    <>
      {heading("Connect to UW")}
      {agreed ? (
        <>
          <p className="onb-lede">
            You have agreed. Sign in on UW's own page, and Magic Canvas starts reading your
            courses.
          </p>
          <Actions onBack={onBack}>
            <button className="onb-primary" disabled={busy} onClick={() => void onSignIn()}>
              {canSignIn ? "Sign in to UW" : "Continue"}
            </button>
          </Actions>
          {!canSignIn ? (
            <p className="onb-note">UW sign-in is available in the desktop app only.</p>
          ) : null}
        </>
      ) : (
        <>
          {/* T06's consent content, composed unchanged: its checkbox grants, then onAgreedToSetup. */}
          <div className="onb-consent">
            <ConsentSetup
              snapshot={snapshot}
              busy={busy}
              pending={null}
              canSignIn={canSignIn}
              runAll={runAll}
              onAgreedToSetup={() => void onSignIn()}
              onSample={() => onLoadSample()}
              onClose={null}
              embedded
            />
          </div>
          <Actions onBack={onBack}>
            <span />
          </Actions>
        </>
      )}
    </>
  );
}

function Populating({
  heading,
  snapshot,
  busy,
  noClient,
  onLoadSample,
  onBack,
  onFinish,
}: {
  heading: Heading;
  snapshot: Snapshot;
  busy: boolean;
  noClient: boolean;
  onLoadSample: () => unknown;
  onBack: (() => void) | null;
  onFinish: () => void;
}) {
  const summary = summarize(snapshot, busy);
  const title =
    summary.outcome === "empty"
      ? "Nothing connected yet"
      : summary.outcome === "reading"
        ? "Reading your courses"
        : summary.outcome === "issues"
          ? "Your workspace is partly ready"
          : "Your workspace is ready";
  return (
    <>
      {heading(title)}
      <p className="onb-lede" aria-live="polite">
        {summary.outcome === "empty"
          ? "No source has been read yet. Sign in to UW, or look around with a sample course."
          : summary.outcome === "reading"
            ? "This keeps going if you open your workspace now."
            : summary.outcome === "issues"
              ? "Some sources were not fully read. What was read is saved; the rest is listed below."
              : "Everything connected was read."}
      </p>
      {summary.counts.length > 0 ? (
        <ul className="onb-counts" aria-label="Items found">
          {summary.counts.map((entry) => (
            <li key={entry.label}>
              <strong>{entry.count}</strong> {entry.label}
            </li>
          ))}
        </ul>
      ) : null}
      {summary.sources.length > 0 ? (
        <ul className="onb-sources" aria-label="Sources">
          {summary.sources.map((source) => (
            <li key={source.id} className={`onb-source ${source.state}`}>
              <span className="onb-source-mark" aria-hidden="true">
                {source.state === "reading" ? (
                  <Spinner />
                ) : source.state === "ready" ? (
                  <Icon name="check" className="onb-ok" />
                ) : (
                  <Icon name="alert" className="onb-warn" />
                )}
              </span>
              <span className="onb-source-text">
                <span className="onb-source-label">{source.label}</span>
                {source.reason ? <span className="onb-source-reason">{source.reason}</span> : null}
              </span>
              <span className="onb-source-status">
                {source.status}
                {source.detail ? <span className="onb-source-detail">{source.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {snapshot.fixtureMode ? (
        <p className="onb-note">This is a synthetic sample course, not your coursework.</p>
      ) : null}
      {noClient ? (
        <p className="onb-note">No AI is connected, so study material waits until you add one.</p>
      ) : null}
      <Actions onBack={onBack}>
        {summary.outcome === "empty" ? (
          <button className="onb-quiet" disabled={busy} onClick={() => onLoadSample()}>
            Load sample course
          </button>
        ) : null}
        <button className="onb-primary" onClick={onFinish}>
          Open workspace
        </button>
      </Actions>
    </>
  );
}
