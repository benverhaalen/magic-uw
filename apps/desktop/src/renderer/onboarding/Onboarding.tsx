import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ClientHealth, ClientMode, Command, CommandResult, OutlookStatus, SignInOutcome, Snapshot } from "@magic/contracts";
import {
  CONSENT_DISCLOSURE_VERSION,
  hasCurrentConsent,
} from "../../../../../packages/domain/src/index";
import { ConsentSetup } from "../consent/ConsentSetup";
import { ACCENTS, applyAppearance, readAppearance, writeAppearance, type Appearance, type ThemePreference } from "../appearance";
import { signInAndSync, signInMessage } from "../sign-in";
import { ClientHealthNotice } from "./ClientHealthNotice";
import { Icon, Spinner } from "./icons";
import {
  clientInfo,
  clientOrder,
  courseChoices,
  createPreviewClients,
  enrolledWithoutCanvas,
  firstIncompleteStep,
  healthFromStatus,
  orderedClients,
  readProgress,
  recommendedClient,
  autoPick,
  selectable,
  steps,
  summarize,
  writeProgress,
  type ClientId,
  type ClientsBridge,
  type CourseChoice,
  type OnboardingProgress,
  type StepId,
  type UwProgress,
} from "./model";
import { TerminalPane } from "./TerminalPane";
import "./onboarding.css";
import "./client-health.css";

/**
 * T81 first-run onboarding, reordered by D51 (owner: client-health): Agreement → UW sign-in →
 * Your AI (each client with its health and connection mode) → Appearance → Connections → done.
 * Composes T06's ConsentSetup and the T80 client bridge. Without the bridge (the browser
 * preview) it runs on a labelled preview fixture.
 */

const previewBridge = createPreviewClients();
function clientsBridge(): { clients: ClientsBridge; preview: boolean } {
  const live = window.magic?.clients;
  return live ? { clients: live, preview: false } : { clients: previewBridge, preview: true };
}
const defaultTerminal = (sessionId: string) => <TerminalPane sessionId={sessionId} />;

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
  /** The existing UW sign-in (then Canvas sync); used only where the bridge has no outcome. */
  signIn: () => Promise<unknown>;
  openExternal: (url: string) => void;
  onLoadSample: () => Promise<CommandResult | undefined>;
  onFinish: () => void;
  /** The built-in terminal; defaults to TerminalPane. */
  renderTerminal?: (sessionId: string) => ReactNode;
}

export function Onboarding(props: OnboardingProps) {
  const { snapshot, busy, error, onDismissError } = props;
  const { clients, preview } = useMemo(clientsBridge, []);
  const renderTerminal = props.renderTerminal ?? defaultTerminal;
  const [progress, setProgressState] = useState<OnboardingProgress>(() => readProgress());
  const [step, setStep] = useState<StepId>(() => firstIncompleteStep(snapshot, readProgress(), hasCurrentConsent));
  const [autoSignIn, setAutoSignIn] = useState(false);
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
  const back = index > 0 ? () => setStep(steps[index - 1].id) : null;
  const next = () => setStep(steps[Math.min(index + 1, steps.length - 1)].id);
  const loadSample = async () => {
    const result = await props.onLoadSample();
    // owner: client-detection (e2e harness): from the agreement or UW step the sample stands in
    // for the sign-in and the flow moves on; anywhere later it only adds coursework, and the
    // student stays where they are.
    if (result?.snapshot?.resources.length && (step === "consent" || step === "uw")) {
      if (progress.uw !== "confirmed") update({ uw: "skipped" });
      setStep("client");
    }
  };
  const heading = (text: string) => (
    <h1 className="onb-title" id="onb-step-title" ref={headingRef} tabIndex={-1}>
      {text}
    </h1>
  );

  let body: ReactNode;
  if (step === "consent")
    body = (
      <ConsentStep
        heading={heading}
        snapshot={snapshot}
        busy={busy}
        canSignIn={props.canSignIn}
        runAll={props.runAll}
        onLoadSample={loadSample}
        onAgreed={(start) => {
          update({ started: true });
          setAutoSignIn(start && props.canSignIn);
          setStep("uw");
        }}
      />
    );
  else if (step === "uw")
    body = (
      <UwStep
        heading={heading}
        snapshot={snapshot}
        canSignIn={props.canSignIn}
        autoStart={autoSignIn}
        previous={progress.uw}
        run={props.run}
        onLoadSample={loadSample}
        onBack={back}
        onOutcome={(uw) => update({ uw })}
        onNext={() => {
          setAutoSignIn(false);
          next();
        }}
      />
    );
  else if (step === "courses")
    body = (
      <CoursesStep
        heading={heading}
        snapshot={snapshot}
        busy={busy}
        run={props.run}
        onBack={back}
        onNext={() => {
          update({ coursesDone: true });
          next();
        }}
      />
    );
  else if (step === "client")
    body = (
      <ClientStep
        heading={heading}
        clients={clients}
        preview={preview}
        snapshot={snapshot}
        busy={busy}
        run={props.run}
        renderTerminal={renderTerminal}
        openExternal={props.openExternal}
        chosen={progress.client === "later" ? null : progress.client}
        onBack={back}
        onChosen={(id) => update({ client: id, clientConnected: false })}
        onConnected={() => {
          update({ clientConnected: true });
          next();
        }}
        onLater={() => {
          update({ client: "later", clientConnected: false });
          next();
        }}
      />
    );
  else if (step === "appearance")
    body = (
      <AppearanceStep
        heading={heading}
        onBack={back}
        onNext={() => {
          update({ appearanceDone: true });
          next();
        }}
      />
    );
  else if (step === "connections")
    body = (
      <ConnectionsStep
        heading={heading}
        run={props.run}
        onBack={back}
        onNext={() => {
          update({ connectionsDone: true });
          next();
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
        onSignIn={() => void props.signIn()}
        onRetry={() => void window.magic?.syncCanvas?.().then(() => props.run({ type: "snapshot" }))}
        onLoadSample={loadSample}
        onBack={back}
        onFinish={() => {
          update({ done: true });
          // Finishing setup accepts the course choice if the step was never confirmed.
          if (snapshot.ingestionSettings?.awaitingCourseChoice) void window.magic?.syncCanvas?.({ confirm: true });
          props.onFinish();
        }}
      />
    );

  return (
    <div className="onb">
      <header className="onb-bar">
        <span className="onb-wordmark">My Magic UW</span>
        <span className="onb-bar-end">
          {preview ? <span className="onb-preview-flag">Preview: sample AI clients, not detected</span> : null}
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

function Actions({ onBack, children }: { onBack: (() => void) | null; children: ReactNode }) {
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

// --- 1. Agreement ---------------------------------------------------------------------------------
function ConsentStep({
  heading,
  snapshot,
  busy,
  canSignIn,
  runAll,
  onLoadSample,
  onAgreed,
}: {
  heading: Heading;
  snapshot: Snapshot;
  busy: boolean;
  canSignIn: boolean;
  runAll: (commands: Command[]) => Promise<unknown>;
  onLoadSample: () => unknown;
  /** `start`: the checkbox was just ticked, so UW sign-in opens straight away. */
  onAgreed: (start: boolean) => void;
}) {
  const agreed = hasCurrentConsent(snapshot.consents, "uw");
  return (
    <>
      {heading("Your classes, in one place.")}
      <p className="onb-lede">
        My Magic UW reads your UW courses, keeps what matters on this computer, and helps you start the right work with
        sources you can check.
      </p>
      <p className="onb-affiliation">
        My Magic UW is an independent student project. It is not affiliated with, sponsored by or endorsed by the
        University of Wisconsin–Madison.
      </p>
      {agreed ? (
        <Actions onBack={null}>
          <button className="onb-primary" onClick={() => onAgreed(false)} autoFocus>
            Continue
          </button>
        </Actions>
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
              onAgreedToSetup={() => onAgreed(true)}
              onSample={() => onLoadSample()}
              onClose={null}
              embedded
            />
          </div>
        </>
      )}
    </>
  );
}

// --- 2. UW sign-in ----------------------------------------------------------------------------
function UwStep({
  heading,
  snapshot,
  canSignIn,
  autoStart,
  previous,
  run,
  onLoadSample,
  onBack,
  onOutcome,
  onNext,
}: {
  heading: Heading;
  snapshot: Snapshot;
  canSignIn: boolean;
  autoStart: boolean;
  previous: UwProgress;
  run: (command: Command) => Promise<CommandResult | undefined>;
  onLoadSample: () => unknown;
  onBack: (() => void) | null;
  onOutcome: (uw: UwProgress) => void;
  onNext: () => void;
}) {
  const [signing, setSigning] = useState(false);
  const [outcome, setOutcome] = useState<SignInOutcome | null>(
    previous === "confirmed" ? { status: "confirmed", service: "canvas" } : null,
  );
  const started = useRef(false);
  const start = useCallback(async () => {
    setSigning(true);
    setOutcome(null);
    try {
      // FDB-002: Canvas is read only after a confirmed sign-in; a closed window starts nothing.
      // fix/current-courses-only: only the course lists now; the student chooses before the sync.
      const result = await signInAndSync(window.magic ?? {}, undefined, { discover: true, enrollmentFirst: true });
      setOutcome(result.outcome);
      onOutcome(result.outcome.status);
      if (result.synced) void run({ type: "snapshot" });
    } catch (error) {
      const failed: SignInOutcome = {
        status: "failed",
        service: "canvas",
        reason: error instanceof Error && error.message.length < 200 ? error.message : "The UW sign-in window couldn't open.",
      };
      setOutcome(failed);
      onOutcome("failed");
    } finally {
      setSigning(false);
    }
  }, [onOutcome, run]);
  useEffect(() => {
    if (autoStart && canSignIn && !started.current && previous !== "confirmed") {
      started.current = true;
      void start();
    }
  }, [autoStart, canSignIn, previous, start]);
  const confirmed = outcome?.status === "confirmed" || snapshot.sources.length > 0;
  return (
    <>
      {heading("Sign in to UW")}
      <p className="onb-lede">
        UW's own page opens in a window. Your NetID, password and Duo stay with UW; My Magic UW keeps only the signed-in
        session on this computer.
      </p>
      <div className={`onb-connection${confirmed ? " ok" : ""}`} role="status" aria-live="polite">
        {signing ? (
          <>
            <Spinner />
            <span>Finish signing in on UW's page.</span>
          </>
        ) : outcome ? (
          <>
            <Icon name={outcome.status === "confirmed" ? "check" : "alert"} className={outcome.status === "confirmed" ? "onb-ok" : "onb-warn"} />
            <span>{signInMessage(outcome)}</span>
          </>
        ) : confirmed ? (
          <>
            <Icon name="check" className="onb-ok" />
            <span>Signed in to UW.</span>
          </>
        ) : !canSignIn ? (
          <span>UW sign-in is available in the desktop app only.</span>
        ) : null}
      </div>
      <Actions onBack={onBack}>
        {!confirmed ? (
          <button
            className="onb-quiet"
            onClick={() => {
              onOutcome("skipped");
              onNext();
            }}
          >
            Skip for now
          </button>
        ) : null}
        {!confirmed && !canSignIn ? (
          <button className="onb-quiet" onClick={() => onLoadSample()}>
            Load sample course
          </button>
        ) : null}
        {confirmed ? (
          <button className="onb-primary" onClick={onNext}>
            Continue
          </button>
        ) : canSignIn ? (
          <button className="onb-primary" disabled={signing} onClick={() => void start()}>
            {outcome ? "Sign in again" : "Sign in to UW"}
          </button>
        ) : null}
      </Actions>
    </>
  );
}

// --- 2b. Your courses (fix/current-courses-only) -------------------------------------------------
function CourseRow({ course, busy, onToggle }: { course: CourseChoice; busy: boolean; onToggle: (on: boolean) => void }) {
  return (
    <li className="chn-row">
      <label className="onb-course">
        <input type="checkbox" checked={course.checked} disabled={busy} onChange={(e) => onToggle(e.target.checked)} />
        <span className="chn-row-text">
          <span className="chn-row-name">{course.name}</span>
          <span className="chn-row-detail">
            {course.term ?? "No term"} · {course.decidedBy === "enrollment" ? "from your UW enrollment" : "from Canvas term dates"}
          </span>
        </span>
      </label>
    </li>
  );
}
function CoursesStep({
  heading,
  snapshot,
  busy,
  run,
  onBack,
  onNext,
}: {
  heading: Heading;
  snapshot: Snapshot;
  busy: boolean;
  run: (command: Command) => Promise<CommandResult | undefined>;
  onBack: (() => void) | null;
  onNext: () => void;
}) {
  const choices = courseChoices(snapshot);
  const thisTerm = choices.filter((c) => c.group === "this-term");
  const other = choices.filter((c) => c.group === "other");
  const missing = enrolledWithoutCanvas(snapshot, new Date());
  const toggle = (course: CourseChoice, included: boolean) =>
    void run({ type: "course-override", value: { accountScope: course.accountScope, courseId: course.courseId, included } });
  const start = () => {
    // The first full read, of the checked courses only; it continues while setup goes on.
    if (window.magic?.syncCanvas) void window.magic.syncCanvas({ confirm: true }).then(() => run({ type: "snapshot" }));
    onNext();
  };
  return (
    <>
      {heading("Your courses")}
      <p className="onb-lede">
        Your classes this term, from your UW enrollment when it could be read, otherwise from Canvas's term dates. Only
        the checked ones are read. You can change this later in Settings.
      </p>
      {thisTerm.length ? (
        <ul className="chn-rows" aria-label="This term">
          {thisTerm.map((course) => (
            <CourseRow key={course.id} course={course} busy={busy} onToggle={(on) => toggle(course, on)} />
          ))}
        </ul>
      ) : (
        <p className="onb-note">Canvas didn't list a course for this term.</p>
      )}
      {missing.length ? (
        <ul className="chn-rows" aria-label="Enrolled classes without a Canvas course">
          {missing.map((c) => (
            <li key={c.courseKey} className="chn-row">
              <span className="chn-row-text">
                <span className="chn-row-name">{c.title}</span>
                <span className="chn-row-detail">No Canvas course found · from your UW enrollment</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {other.length ? (
        <details className="onb-other-courses">
          <summary>Other Canvas sites ({other.length})</summary>
          <ul className="chn-rows" aria-label="Other Canvas sites">
            {other.map((course) => (
              <CourseRow key={course.id} course={course} busy={busy} onToggle={(on) => toggle(course, on)} />
            ))}
          </ul>
        </details>
      ) : null}
      <Actions onBack={onBack}>
        <button className="onb-primary" disabled={busy} onClick={start}>
          Start syncing
        </button>
      </Actions>
    </>
  );
}

// --- 3. Your AI -----------------------------------------------------------------------------------
const stateWords: Record<ClientHealth["state"], string> = {
  ok: "Ready",
  installed: "Installed",
  not_installed: "Not installed",
  not_signed_in: "Not signed in",
  plan_insufficient: "Plan can't run it",
  usage_limited: "Usage limit reached",
  model_unavailable: "Model unavailable",
  offline: "Can't connect",
  keychain_locked: "Keychain blocked", // owner: client-detection
  tool_use_blocked: "Stopped: tried a tool",
};

/** A tile's real status: what the client on this computer says, in its saved mode. Signs nothing in. */
function tileStatus(id: ClientId, h: ClientHealth | undefined): string {
  if (id === "gemini") return h?.state === "ok" ? "Your key is saved" : "Uses your API key";
  if (!h) return "Not checked";
  if (h.mode === "isolated" && h.state === "not_signed_in") return "Sign in once here";
  if (h.mode === "instant" && h.state === "installed" && !h.instant.available) return "Needs an update";
  if (h.state === "ok") return h.plan ? `Signed in · ${h.plan[0].toUpperCase()}${h.plan.slice(1)}` : "Signed in";
  return stateWords[h.state];
}

function ClientStep(props: {
  heading: Heading;
  clients: ClientsBridge;
  preview: boolean;
  snapshot: Snapshot;
  busy: boolean;
  run: (command: Command) => Promise<CommandResult | undefined>;
  renderTerminal: (sessionId: string) => ReactNode;
  openExternal: (url: string) => void;
  chosen: ClientId | null;
  onBack: (() => void) | null;
  onChosen: (id: ClientId) => void;
  onConnected: () => void;
  onLater: () => void;
}) {
  const { heading, clients } = props;
  const [health, setHealth] = useState<Partial<Record<ClientId, ClientHealth>> | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<ClientId | null>(props.chosen);
  const [mode, setMode] = useState<ClientMode | null>(null);
  const [connecting, setConnecting] = useState<ClientId | null>(props.chosen);
  const autoPicked = useRef(false); // owner: client-detection
  const check = useCallback(async () => {
    setFailed(false);
    setHealth(null);
    try {
      const found = orderedClients(await clients.detect());
      const entries = await Promise.all(
        found.map(async (status): Promise<[ClientId, ClientHealth]> => {
          if (!clients.health) return [status.id, healthFromStatus(status)];
          try {
            return [status.id, await clients.health(status.id)];
          } catch {
            return [status.id, healthFromStatus(status)];
          }
        }),
      );
      const map = Object.fromEntries(entries) as Record<ClientId, ClientHealth>;
      setHealth(map);
      setSelected((current) => (current && selectable(current, map[current]) ? current : recommendedClient(map)));
      // owner: client-detection. One client installed: use it without asking (once; Back returns here).
      const only = autoPick(map);
      if (only && !props.chosen && !autoPicked.current) {
        autoPicked.current = true;
        setSelected(only);
        props.onChosen(only);
        setConnecting(only);
      }
    } catch {
      setFailed(true);
    }
  }, [clients]);
  useEffect(() => {
    void check();
  }, [check]);
  const current = selected && health ? health[selected] : undefined;
  // Instant unless the student opted into a separate sign-in before (operator, 2026-09-27).
  useEffect(() => {
    if (current) setMode(current.mode);
  }, [current]);
  const recommended = health ? recommendedClient(health) : null;

  // owner: client-detection (e2e harness): never assume a mode on remount. Use the one chosen on
  // this screen, else the client's saved mode from its health; until that's known, wait. (A
  // default of "isolated" here used to be saved over the student's instant mode.)
  const connectMode: ClientMode | null =
    connecting === "gemini" ? "api_key" : connecting && (mode ?? health?.[connecting]?.mode ?? null);
  if (connecting && !connectMode)
    return (
      <div className="onb-inline-status" role="status">
        <Spinner />
        <span>Checking {clientInfo[connecting].name}…</span>
      </div>
    );
  if (connecting && connectMode)
    return (
      <ConnectClient
        key={`${connecting}-${connectMode}`}
        {...props}
        id={connecting}
        mode={connectMode}
        onBack={() => setConnecting(null)}
        onMode={setMode}
      />
    );
  return (
    <>
      {heading("Choose your AI")}
      <p className="onb-lede">
        My Magic UW writes study material with an AI you already use. Pick one; you can change it later in Data &amp; AI.
      </p>
      {failed ? (
        <div className="onb-inline-status" role="status">
          <Icon name="alert" />
          <span>Could not check which AI clients are installed.</span>
          <button className="onb-quiet" onClick={() => void check()}>
            Check again
          </button>
        </div>
      ) : !health ? (
        <div className="onb-inline-status" role="status">
          <Spinner />
          <span>Checking Claude Code, Codex and Gemini…</span>
        </div>
      ) : (
        <div className="onb-tiles" role="radiogroup" aria-label="AI client">
          {clientOrder.map((id) => {
            const info = clientInfo[id];
            const h = health[id];
            const enabled = selectable(id, h);
            const checked = selected === id;
            return (
              <div key={id} className={`onb-tile${checked ? " selected" : ""}${enabled ? "" : " missing"}`}>
                <label className="onb-tile-choice">
                  <input
                    type="radio"
                    name="onb-client"
                    value={id}
                    checked={checked}
                    disabled={!enabled}
                    onChange={() => setSelected(id)}
                  />
                  <span className="onb-tile-name">{info.name}</span>
                  <span className="onb-tile-meta">{tileStatus(id, h)}</span>
                  {h?.version && id !== "gemini" ? <span className="onb-tile-meta">Version {h.version}</span> : null}
                  {h && id !== "gemini" && h.mode === "isolated" ? <span className="chn-mode">Separate sign-in</span> : null}
                  {recommended === id ? <span className="chn-recommended">Recommended</span> : null}
                  <span className="onb-tile-check" aria-hidden="true">
                    {checked ? <Icon name="check" /> : null}
                  </span>
                </label>
                {!enabled ? (
                  <button
                    className="onb-link"
                    onClick={() => props.openExternal(info.installUrl)}
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
      {current && selected !== "gemini" && current.state !== "not_installed" ? (
        <div className="chn-modes">
          {mode === "instant" && current.state !== "ok" ? (
            <ClientHealthNotice
              health={current}
              openExternal={props.openExternal}
              onCheckAgain={() => void check()}
              onSwitch={() => setSelected(clientOrder.find((id) => id !== current.id && selectable(id, health?.[id])) ?? "gemini")}
              onUseProfile={current.modes.includes("isolated") ? () => setMode("isolated") : undefined}
            />
          ) : null}
          {mode === "instant" && current.instant.note ? <p className="onb-note">{current.instant.note}</p> : null}
          <details className="chn-advanced" open={mode === "isolated"}>
            <summary>Advanced</summary>
            <label className="chn-check">
              <input
                type="checkbox"
                checked={mode === "isolated"}
                onChange={(event) => setMode(event.target.checked ? "isolated" : "instant")}
              />
              <span>Use a separate sign-in for My Magic UW</span>
            </label>
            <p className="onb-note">
              The app keeps its own {clientInfo[current.id].name} profile, apart from yours, and you sign in to it once inside
              My Magic UW.
            </p>
          </details>
        </div>
      ) : null}
      {props.preview && health ? (
        <p className="onb-note">Preview: these clients are sample data. The desktop app checks what is really installed.</p>
      ) : null}
      <Actions onBack={props.onBack}>
        <button className="onb-quiet" onClick={props.onLater}>
          Set up later
        </button>
        <button
          className="onb-primary"
          disabled={
            !selected ||
            !selectable(selected, current) ||
            current?.state === "not_installed" ||
            (mode === "instant" && current?.state === "installed" && !current.instant.available)
          }
          onClick={() => {
            if (!selected) return;
            props.onChosen(selected);
            setConnecting(selected);
          }}
        >
          Continue
        </button>
      </Actions>
      <p className="onb-note">
        Until an AI is connected, My Magic UW still reads and organizes your courses; writing study material waits.
      </p>
    </>
  );
}

function ConnectClient({
  heading,
  id,
  mode,
  clients,
  preview,
  snapshot,
  busy,
  run,
  renderTerminal,
  openExternal,
  onBack,
  onMode,
  onConnected,
}: {
  heading: Heading;
  id: ClientId;
  mode: ClientMode;
  clients: ClientsBridge;
  preview: boolean;
  snapshot: Snapshot;
  busy: boolean;
  run: (command: Command) => Promise<CommandResult | undefined>;
  renderTerminal: (sessionId: string) => ReactNode;
  openExternal: (url: string) => void;
  onBack: (() => void) | null;
  onMode: (mode: ClientMode) => void;
  onConnected: () => void;
}) {
  const info = clientInfo[id];
  const agreed = hasCurrentConsent(snapshot.consents, info.recipient);
  const [health, setHealth] = useState<ClientHealth | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const [checking, setChecking] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const ready = health?.state === "ok";

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const h = clients.setMode ? await clients.setMode(id, mode) : clients.health ? await clients.health(id, mode) : healthFromStatus(await clients.authStatus(id));
      setHealth(h);
      return h;
    } catch (error) {
      setProblem(error instanceof Error && error.message.length < 200 ? error.message : `Could not check ${info.name}.`);
      return null;
    } finally {
      setChecking(false);
    }
  }, [clients, id, info.name, mode]);

  // Once agreed: check the client in the chosen mode; the separate profile opens its sign-in.
  useEffect(() => {
    if (!agreed) return;
    let cancelled = false;
    let opened: string | null = null;
    setProblem("");
    (async () => {
      if (mode === "isolated") await clients.prepare(id).catch(() => undefined);
      const h = await refresh();
      if (cancelled || !h || mode !== "isolated" || h.state !== "not_signed_in") return;
      try {
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
  }, [agreed, clients, id, info.name, mode, refresh, attempt]);

  // The separate profile's sign-in: poll the client's own state until it reports signed in.
  useEffect(() => {
    if (!agreed || mode !== "isolated" || !session || ready) return;
    const timer = window.setInterval(() => {
      clients
        .authStatus(id)
        .then((s) => (s.signedIn === true ? refresh() : undefined))
        .catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [agreed, clients, id, mode, session, ready, refresh]);

  if (!agreed)
    return (
      <>
        {heading(`Connect ${info.name}`)}
        <p className="onb-lede">Before anything is sent, here is what {info.provider} receives through {info.name}.</p>
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
            <dd>Usage counts toward your own {info.plan}.</dd>
          </div>
          <div>
            <dt>Your settings</dt>
            <dd>
              {id === "gemini"
                ? "Your key is stored encrypted on this computer and sent only to Google."
                : mode === "instant"
                  ? `The app runs your ${info.name} with its own settings passed in and never changes yours.`
                  : `The app signs in with its own ${info.name} profile and never changes yours.`}
            </dd>
          </div>
        </dl>
        <Actions onBack={onBack}>
          <button
            className="onb-primary"
            disabled={busy}
            onClick={() =>
              void run({
                type: "consent",
                value: { action: "grant", recipient: info.recipient, disclosureVersion: CONSENT_DISCLOSURE_VERSION },
              })
            }
          >
            Agree and continue
          </button>
        </Actions>
        <p className="onb-note">You can withdraw this later in Data &amp; AI, then Agreements.</p>
      </>
    );

  const quickChat =
    id !== "gemini" && health && health.state !== "not_installed"
      ? async () => (await clients.terminal.open(id, "chat")).sessionId
      : undefined;
  const closeChat = (sessionId: string) => void clients.terminal.close(sessionId);
  return (
    <>
      {heading(id === "gemini" ? "Add your Gemini key" : mode === "instant" ? `Connect your ${info.name}` : `Sign in to ${info.name}`)}
      <p className="onb-lede">
        {ready
          ? id === "gemini"
            ? "Your key is saved. My Magic UW sends requests to Google with it, only when you ask for study material."
            : mode === "instant"
              ? `My Magic UW runs your own ${info.name} with its settings passed in. Nothing in your settings changes.`
              : `My Magic UW uses its own ${info.name} profile, apart from yours.`
          : id === "gemini"
            ? "Gemini's command-line sign-in can't be used by other apps, so My Magic UW uses your own API key."
            : mode === "instant"
              ? `My Magic UW uses the ${info.name} on this computer. Nothing is written to your settings.`
              : `${info.name}'s own sign-in runs below, in a session separate from your usual one.`}
      </p>
      {id === "gemini" && !ready ? (
        <GeminiKeyForm clients={clients} openExternal={openExternal} onSaved={() => void refresh()} />
      ) : null}
      {mode === "isolated" && !ready && session ? (
        <div className="onb-terminal-slot">
          {preview ? (
            <div className="onb-terminal-placeholder">
              <Icon name="terminal" />
              <p>Preview: {info.name}'s sign-in would run here. It completes by itself in a few seconds.</p>
            </div>
          ) : (
            renderTerminal(session)
          )}
        </div>
      ) : null}
      {problem ? (
        <div className="onb-connection" role="alert">
          <Icon name="alert" />
          <span>{problem}</span>
          <button className="onb-quiet" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : !health ? (
        <div className="onb-connection" role="status">
          <Spinner />
          <span>Checking {info.name}…</span>
        </div>
      ) : ready ? (
        <ClientHealthNotice
          health={health}
          compact
          onQuickChat={quickChat}
          onCloseChat={closeChat}
          renderTerminal={preview ? undefined : renderTerminal}
          openExternal={openExternal}
        />
      ) : mode === "isolated" && health.state === "not_signed_in" ? (
        <div className="onb-connection" role="status" aria-live="polite">
          <Spinner />
          <span>Waiting for you to sign in to {info.name}…</span>
        </div>
      ) : id === "gemini" && health.state === "not_signed_in" ? null : (
        <ClientHealthNotice
          health={health}
          checking={checking}
          onQuickChat={quickChat}
          onCloseChat={closeChat}
          renderTerminal={preview ? undefined : renderTerminal}
          openExternal={openExternal}
          onCheckAgain={() => void refresh()}
          onSwitch={onBack ?? undefined}
          onUseProfile={mode === "instant" && health.modes.includes("isolated") ? () => onMode("isolated") : undefined}
        />
      )}
      <Actions onBack={onBack}>
        <button
          className="onb-primary"
          disabled={!ready || finishing}
          onClick={async () => {
            setFinishing(true);
            try {
              await clients.choose(id);
              // owner: client-detection (e2e harness): runs go to the chosen client only when the
              // privacy preference names it, so a student who picked Codex isn't blocked.
              if (snapshot.privacy.mode !== "local_only" && snapshot.privacy.hostedProvider !== id)
                await run({ type: "privacy", value: { ...snapshot.privacy, hostedProvider: id } });
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

function GeminiKeyForm({ clients, openExternal, onSaved }: { clients: ClientsBridge; openExternal: (url: string) => void; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [inEnvironment, setInEnvironment] = useState(false);
  const [problem, setProblem] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void clients.geminiKey?.status().then((s) => setInEnvironment(s.inEnvironment)).catch(() => undefined);
  }, [clients]);
  if (!clients.geminiKey) return <p className="onb-note">Adding a key needs a newer version of the desktop app.</p>;
  return (
    <form
      className="chn-key"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setProblem("");
        try {
          await clients.geminiKey!.save(value);
          setValue("");
          onSaved();
        } catch (error) {
          setProblem(error instanceof Error && error.message.length < 200 ? error.message : "The key couldn't be saved.");
        } finally {
          setSaving(false);
        }
      }}
    >
      <label className="chn-key-label" htmlFor="onb-gemini-key">
        Gemini API key
      </label>
      <div className="chn-key-row">
        <input
          id="onb-gemini-key"
          className="chn-key-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="onb-primary" type="submit" disabled={saving || value.trim().length < 20}>
          {saving ? "Saving…" : "Save key"}
        </button>
      </div>
      <p className="onb-note">
        {inEnvironment
          ? "A GEMINI_API_KEY is set on this computer. My Magic UW doesn't read it on its own; paste it here to use it. "
          : ""}
        Stored encrypted on this computer and sent only to Google.{" "}
        <button type="button" className="onb-link" onClick={() => openExternal("https://aistudio.google.com/apikey")}>
          Get a key in Google AI Studio
          <Icon name="external" />
        </button>
      </p>
      {problem ? (
        <p className="chn-error-text" role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

// --- 4. Appearance --------------------------------------------------------------------------------
const themes: { id: ThemePreference; label: string; detail: string }[] = [
  { id: "system", label: "Match this computer", detail: "Follows your light or dark setting" },
  { id: "light", label: "Light", detail: "Always light" },
  { id: "dark", label: "Dark", detail: "Always dark" },
];

function AppearanceStep({ heading, onBack, onNext }: { heading: Heading; onBack: (() => void) | null; onNext: () => void }) {
  const [appearance, setAppearance] = useState<Appearance>(() => readAppearance());
  const change = (next: Appearance) => {
    setAppearance(next);
    writeAppearance(next);
    applyAppearance(next);
  };
  return (
    <>
      {heading("Choose how it looks")}
      <p className="onb-lede">Pick a mode and an accent. You can change both later in Settings.</p>
      <fieldset className="chn-fieldset">
        <legend>Mode</legend>
        <div className="chn-segments">
          {themes.map((t) => (
            <label key={t.id} className={`chn-segment${appearance.theme === t.id ? " selected" : ""}`}>
              <input
                type="radio"
                name="onb-theme"
                value={t.id}
                checked={appearance.theme === t.id}
                onChange={() => change({ ...appearance, theme: t.id })}
              />
              <span className="chn-segment-name">{t.label}</span>
              <span className="chn-segment-detail">{t.detail}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="chn-fieldset">
        <legend>Accent</legend>
        <div className="chn-swatches">
          {ACCENTS.map((a) => (
            <label key={a.id} className={`chn-swatch${appearance.accent === a.id ? " selected" : ""}`}>
              <input
                type="radio"
                name="onb-accent"
                value={a.id}
                checked={appearance.accent === a.id}
                onChange={() => change({ ...appearance, accent: a.id })}
              />
              <span className="chn-swatch-chip" style={{ background: `var(${a.swatch})` }} aria-hidden="true" />
              <span className="chn-swatch-name">{a.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="onb-note">
        Your choice is saved now. The accent colours the window frame; dark mode arrives with the My Magic UW design system.
      </p>
      <Actions onBack={onBack}>
        <button className="onb-primary" onClick={onNext}>
          Continue
        </button>
      </Actions>
    </>
  );
}

// --- 5. Connections -------------------------------------------------------------------------------
type RowState = { kind: "checking" } | { kind: "unavailable"; text: string } | { kind: "connect"; text: string; label: string } | { kind: "working"; text: string } | { kind: "connected"; text: string } | { kind: "waiting"; text: string };

function outlookRow(status: OutlookStatus | null): RowState {
  if (!status) return { kind: "unavailable", text: "Available in the desktop app." };
  switch (status.outlook) {
    case "not_set_up":
      return { kind: "unavailable", text: "Not set up in this build." };
    case "connected":
      return { kind: "connected", text: "Connected." };
    case "needs_uw_approval":
      return { kind: "waiting", text: "Waiting for UW to approve My Magic UW for your account." };
    case "expired":
      return { kind: "connect", text: "The sign-in expired.", label: "Reconnect" };
    case "error":
      return { kind: "connect", text: "The last connection attempt failed.", label: "Try again" };
    default:
      return { kind: "connect", text: "Mail and calendar, read with your own Microsoft sign-in.", label: "Connect" };
  }
}

function ConnectionsStep({
  heading,
  run,
  onBack,
  onNext,
}: {
  heading: Heading;
  run: (command: Command) => Promise<CommandResult | undefined>;
  onBack: (() => void) | null;
  onNext: () => void;
}) {
  const [microsoft, setMicrosoft] = useState<RowState>({ kind: "checking" });
  const [google, setGoogle] = useState<RowState>({ kind: "checking" });
  const googleIdle: RowState = { kind: "connect", text: "Your lecture notes, synced to Google Docs you choose.", label: "Connect" };
  useEffect(() => {
    const bridge = window.magic;
    if (bridge?.outlookStatus) bridge.outlookStatus().then((s) => setMicrosoft(outlookRow(s))).catch(() => setMicrosoft(outlookRow(null)));
    else setMicrosoft(outlookRow(null));
    run({ type: "notes", request: { op: "notes.sync.status" } })
      .then((result) => {
        const notes = result?.notes;
        if (!notes || notes.status !== "ok" || !("sync" in notes)) return setGoogle({ kind: "unavailable", text: "Not available here." });
        const g = notes.sync.providers.find((p) => p.provider === "google");
        setGoogle(g?.connected && g.enabled ? { kind: "connected", text: "Connected." } : googleIdle);
      })
      .catch(() => setGoogle({ kind: "unavailable", text: "Not available here." }));
    // googleIdle is constant text.
  }, [run]);
  const connectMicrosoft = async () => {
    setMicrosoft({ kind: "working", text: "Finish signing in with Microsoft." });
    try {
      setMicrosoft(outlookRow((await window.magic?.outlookConnect?.()) ?? null));
    } catch {
      setMicrosoft({ kind: "connect", text: "Microsoft sign-in didn't finish.", label: "Try again" });
    }
  };
  const connectGoogle = async () => {
    setGoogle({ kind: "working", text: "Finish signing in with Google in your browser." });
    const result = await run({ type: "notes", request: { op: "notes.sync.enable", provider: "google" } });
    const notes = result?.notes;
    if (notes?.status === "ok") setGoogle({ kind: "connected", text: "Connected." });
    else
      setGoogle({
        kind: notes?.status === "not_connected" && /isn't configured/.test("message" in notes ? notes.message : "") ? "unavailable" : "connect",
        text: notes && "message" in notes ? notes.message : "Google sign-in didn't finish.",
        label: "Try again",
      } as RowState);
  };
  const row = (name: string, state: RowState, connect: () => void) => (
    <li className="chn-row">
      <span className="onb-source-mark chn-row-mark" aria-hidden="true">
        {state.kind === "connected" ? (
          <Icon name="check" className="onb-ok" />
        ) : (
          <Spinner idle={state.kind !== "working" && state.kind !== "checking"} />
        )}
      </span>
      <span className="chn-row-text">
        <span className="chn-row-name">{name}</span>
        <span className="chn-row-detail">{state.kind === "checking" ? "Checking…" : state.text}</span>
      </span>
      <span className="chn-row-end">
        {state.kind === "connected" ? (
          <span className="chn-row-ok">Connected</span>
        ) : state.kind === "connect" ? (
          <button className="chn-action" onClick={connect}>
            {state.label}
          </button>
        ) : null}
      </span>
    </li>
  );
  return (
    <>
      {heading("Add other accounts")}
      <p className="onb-lede">Optional. Each one uses that service's own sign-in, and you can disconnect it any time.</p>
      <ul className="chn-rows" aria-label="Optional connections">
        {row("Microsoft 365", microsoft, () => void connectMicrosoft())}
        {row("Google Drive", google, () => void connectGoogle())}
      </ul>
      <Actions onBack={onBack}>
        <button className="onb-primary" onClick={onNext}>
          {microsoft.kind === "connected" || google.kind === "connected" ? "Continue" : "Skip for now"}
        </button>
      </Actions>
    </>
  );
}

// --- 6. Your workspace ------------------------------------------------------------------------
function Populating({
  heading,
  snapshot,
  busy,
  noClient,
  onSignIn,
  onRetry,
  onLoadSample,
  onBack,
  onFinish,
}: {
  heading: Heading;
  snapshot: Snapshot;
  busy: boolean;
  noClient: boolean;
  onSignIn: () => void;
  onRetry: () => void;
  onLoadSample: () => unknown;
  onBack: (() => void) | null;
  onFinish: () => void;
}) {
  const summary = summarize(snapshot, busy);
  const [whyOpen, setWhyOpen] = useState<string | null>(null);
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
              ? "These weren't fully read. What was read is saved; each one says why and what you can do."
              : summary.filesArriving
                ? `Your courses' assignments and modules are read. ${summary.filesArriving} course ${summary.filesArriving === 1 ? "file is" : "files are"} still coming in; they keep arriving after you open your workspace.`
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
                {whyOpen === source.id && source.why ? <span className="onb-source-reason">{source.why}</span> : null}
              </span>
              <span className="onb-source-status">
                {source.status}
                {source.detail ? <span className="onb-source-detail">{source.detail}</span> : null}
                {source.action === "sign-in" ? (
                  <button className="onb-link" onClick={onSignIn}>Sign in again</button>
                ) : source.action === "retry" ? (
                  <button className="onb-link" disabled={busy} onClick={onRetry}>Retry</button>
                ) : source.action === "why" && source.why ? (
                  <button className="onb-link" aria-expanded={whyOpen === source.id} onClick={() => setWhyOpen(whyOpen === source.id ? null : source.id)}>Why?</button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {snapshot.fixtureMode ? <p className="onb-note">This is a synthetic sample course, not your coursework.</p> : null}
      {noClient ? <p className="onb-note">No AI is connected, so study material waits until you add one.</p> : null}
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
