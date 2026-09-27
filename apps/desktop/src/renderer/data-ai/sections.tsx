// owner: data-ai. The Data & AI sections below the sharing choices: connected accounts, voice input,
// your data on this computer, and Start fresh. Each is a heading, one plain sentence, then controls,
// inside the existing settings-page markup (.settings-section, .setting-toggle, .button).
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Command, CommandResult, OutlookStatus, Snapshot } from "@magic/contracts";
import { MagicGlyph } from "../../../../../packages/ui/src/glyph";
import { RememberSignIn } from "../RememberSignIn";
import { RECONFIGURE_CLEARS, RECONFIGURE_KEEPS, RESET_CLEARS, RESET_KEEPS, sizeWords } from "./model";

type Run = (command: Command, message?: string) => Promise<CommandResult | undefined>;
/** The desktop bridge, or undefined in the browser preview and in tests. */
const magic = () => (typeof window === "undefined" ? undefined : window.magic);

// --- Connected accounts -------------------------------------------------------------------------
function AccountRow({ name, status, children }: { name: string; status: string; children?: ReactNode }) {
  return <div className="data-ai-row">
    <span className="data-ai-row-text"><strong>{name}</strong><span>{status}</span></span>
    {children ? <span className="data-ai-row-end">{children}</span> : null}
  </div>;
}

export function uwStatus(snapshot: Pick<Snapshot, "sources">): "signed_in" | "signed_out" | "not_connected" {
  const canvas = snapshot.sources.filter((source) => source.kind === "canvas");
  if (!canvas.length) return "not_connected";
  return canvas.some((source) => source.status === "needs_sign_in") ? "signed_out" : "signed_in";
}

export function ConnectedAccounts({ snapshot, busy, run, onSignIn, mcp }: {
  snapshot: Snapshot;
  busy: boolean;
  run: Run;
  onSignIn: () => unknown;
  /** The existing course bank manager, shown under "Manage". */
  mcp: ReactNode;
}) {
  const uw = uwStatus(snapshot);
  const [google, setGoogle] = useState<"checking" | "connected" | "connect" | "needs_setup" | "working">("checking");
  const [googleNote, setGoogleNote] = useState("");
  useEffect(() => {
    let live = true;
    const bridge = magic();
    bridge?.execute({ type: "notes", request: { op: "notes.sync.status" } })
      .then((result) => {
        if (!live) return;
        const notes = result?.notes;
        if (!notes || notes.status !== "ok" || !("sync" in notes)) return setGoogle("needs_setup");
        const g = notes.sync.providers.find((p) => p.provider === "google");
        setGoogle(g?.connected && g.enabled ? "connected" : "connect");
      })
      .catch(() => { if (live) setGoogle("needs_setup"); });
    return () => { live = false; };
  }, []);
  const connectGoogle = async () => {
    setGoogle("working");
    setGoogleNote("");
    const result = await run({ type: "notes", request: { op: "notes.sync.enable", provider: "google" } });
    const notes = result?.notes;
    if (notes?.status === "ok") return setGoogle("connected");
    const message = notes && "message" in notes ? notes.message : "Google sign-in didn't finish.";
    setGoogle(/isn't configured/.test(message) ? "needs_setup" : "connect");
    setGoogleNote(message);
  };
  const grants = (snapshot.mcpGrants ?? []).filter((grant) => grant.enabled);
  const agents = [...new Set(grants.map((grant) => ({ local: "an app on this computer", chatgpt: "ChatGPT", claude: "Claude", codex: "Codex", gemini: "Gemini", openrouter: "OpenRouter", jev: "shared labels" } as Record<string, string>)[grant.recipient] ?? grant.recipient))];
  return <section className="settings-section" id="privacy-accounts">
    <h2 tabIndex={-1}>Connected accounts</h2>
    <p>The accounts My Magic UW reads for you. Each uses that service's own sign-in.</p>
    <div className="data-ai-rows">
      <AccountRow name="UW sign-in" status={uw === "signed_in" ? "Signed in" : uw === "signed_out" ? "Signed out" : "Not connected"}>
        {magic()?.signInUW ? <button type="button" className="subtle-button" data-focus-key="privacy-uw-sign-in" disabled={busy} onClick={() => void onSignIn()}>{uw === "not_connected" ? "Sign in" : "Sign in again"}</button> : null}
      </AccountRow>
      <RememberSignIn busy={busy} />
      <AccountRow name="Google Drive" status={google === "checking" ? "Checking…" : google === "working" ? "Finish signing in with Google in your browser" : google === "connected" ? "Connected" : google === "needs_setup" ? "Needs setup: Google sign-in isn't configured in this build" : "Not connected"}>
        {google === "connect" ? <button type="button" className="subtle-button" disabled={busy} onClick={() => void connectGoogle()}>Connect</button> : null}
      </AccountRow>
      {googleNote ? <p className="small muted" role="status">{googleNote}</p> : null}
      <AccountRow name="Microsoft 365: possibly coming soon" status="Not available yet" />
      <AccountRow name="Course bank for AI agents" status={grants.length ? `On for ${agents.join(", ")}` : "Off"} />
    </div>
    <details className="privacy-local-details">
      <summary>Manage the course bank</summary>
      <p>Lets an AI app you run yourself read the courses you pick, read-only.</p>
      {mcp}
    </details>
  </section>;
}

// --- Voice input ------------------------------------------------------------------------------
export function VoiceInput() {
  const [state, setState] = useState<"checking" | "ready" | "no_microphone" | "not_set_up" | "unavailable">("checking");
  useEffect(() => {
    let live = true;
    const voice = typeof window === "undefined" ? undefined : window.magicVoice;
    if (!voice) { setState("unavailable"); return; }
    voice.capabilities()
      .then((value) => { if (live) setState(!value.microphone ? "no_microphone" : value.transcription === "local-whisper" ? "ready" : "not_set_up"); })
      .catch(() => { if (live) setState("unavailable"); });
    return () => { live = false; };
  }, []);
  const words = {
    checking: "Checking…",
    ready: "Ready. Your voice becomes text on this computer and is never sent anywhere.",
    no_microphone: "No microphone is available to My Magic UW. You can type instead.",
    not_set_up: "Speech-to-text isn't set up on this computer yet. You can type instead.",
    unavailable: "Available in the desktop app.",
  }[state];
  return <section className="settings-section" id="privacy-voice">
    <h2 tabIndex={-1}>Voice input</h2>
    <p>Talk instead of typing: press the microphone in the ask box. Speech is turned into text on this computer.</p>
    <div className="data-ai-rows">
      <AccountRow name="Speech to text" status={words} />
    </div>
  </section>;
}

// --- Your data on this computer --------------------------------------------------------------
export function LocalData({ busy, deleteControl }: { busy: boolean; deleteControl: ReactNode }) {
  const bridge = magic()?.localData;
  const [bytes, setBytes] = useState<number | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    let live = true;
    bridge?.("status").then((s) => { if (live) setBytes(s.bytes); }).catch(() => {});
    return () => { live = false; };
  }, [bridge]);
  const act = async (op: "show" | "export") => {
    if (!bridge) return;
    setNote("");
    try {
      const s = await bridge(op);
      setBytes(s.bytes);
      if (s.exported === "saved") setNote("Exported. The file holds your saved course data; keep it somewhere private.");
    } catch {
      setNote(op === "show" ? "The folder could not be opened." : "The export could not be saved.");
    }
  };
  return <section className="settings-section" id="privacy-local-data">
    <h2 tabIndex={-1}>Your data on this computer</h2>
    <p>Your courses, files and activity are saved on this computer, not on our servers.</p>
    <div className="data-ai-rows">
      <AccountRow name="Space used" status={bridge ? (bytes === null ? "Checking…" : sizeWords(bytes)) : "Available in the desktop app"}>
        {bridge ? <>
          <button type="button" className="subtle-button" disabled={busy} onClick={() => void act("show")}>Show in folder</button>
          <button type="button" className="subtle-button" disabled={busy} onClick={() => void act("export")}>Export…</button>
        </> : null}
      </AccountRow>
    </div>
    {note ? <p className="small muted" role="status">{note}</p> : null}
    {deleteControl}
  </section>;
}

// --- Start fresh ------------------------------------------------------------------------------
function ConfirmDialog({ id, title, clears, keeps, confirm, onConfirm, dialogRef }: {
  id: string;
  title: string;
  clears: readonly string[];
  keeps: readonly string[];
  confirm: string;
  onConfirm: () => Promise<void>;
  dialogRef: React.RefObject<HTMLDialogElement | null>;
}) {
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState("");
  const close = () => { setProblem(""); dialogRef.current?.close(); };
  const go = async () => {
    setWorking(true);
    setProblem("");
    try {
      await onConfirm();
      dialogRef.current?.close();
    } catch (error) {
      setProblem(error instanceof Error && error.message.length < 200 ? error.message : "Nothing was reset. Try again.");
    } finally {
      setWorking(false);
    }
  };
  return <dialog ref={dialogRef} className="reconfigure-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-clears ${id}-keeps`}
    onCancel={(event) => { if (working) event.preventDefault(); else setProblem(""); }}>
    <h2 id={`${id}-title`}>{title}</h2>
    <div id={`${id}-clears`}>
      <p><strong>Cleared</strong></p>
      <ul className="data-ai-list">{clears.map((line) => <li key={line}>{line}</li>)}</ul>
    </div>
    <div id={`${id}-keeps`}>
      <p><strong>Kept</strong></p>
      <ul className="data-ai-list">{keeps.map((line) => <li key={line}>{line}</li>)}</ul>
    </div>
    <p>Setup then starts again from the first step.</p>
    {problem ? <p className="attention-text" role="alert">{problem}</p> : null}
    <div className="inline-actions reconfigure-actions">
      <button type="button" className="button" disabled={working} onClick={close} autoFocus>Cancel</button>
      <button type="button" className={id === "reset" ? "button danger-button" : "button primary"} disabled={working} onClick={() => void go()}>{working ? "Working…" : confirm}</button>
    </div>
  </dialog>;
}

export function StartFresh({ disabled, onReset, onReconfigure }: { disabled: boolean; onReset: () => Promise<void>; onReconfigure: () => Promise<void> }) {
  const reset = useRef<HTMLDialogElement>(null);
  const setup = useRef<HTMLDialogElement>(null);
  return <section className="settings-section danger-section start-fresh" id="privacy-start-fresh">
    <h2 tabIndex={-1}><MagicGlyph name="alert" size={16} aria-hidden="true"/> Start fresh</h2>
    <p>Clear My Magic UW from this computer and set it up again, as on the first day.</p>
    <div className="inline-actions">
      <button type="button" className="button danger-button" data-focus-key="privacy-reset" disabled={disabled} onClick={() => reset.current?.showModal()}>Reset My Magic UW…</button>
      <button type="button" className="subtle-button" data-focus-key="privacy-rerun-setup" disabled={disabled} onClick={() => setup.current?.showModal()}>Re-run setup only…</button>
    </div>
    <p className="small muted">Re-run setup only goes through connecting your AI again; your courses, sign-ins and sharing choices stay.</p>
    <ConfirmDialog id="reset" dialogRef={reset} title="Reset My Magic UW?" clears={RESET_CLEARS} keeps={RESET_KEEPS} confirm="Reset and start over" onConfirm={onReset}/>
    <ConfirmDialog id="reconfigure" dialogRef={setup} title="Re-run setup?" clears={RECONFIGURE_CLEARS} keeps={RECONFIGURE_KEEPS} confirm="Re-run setup" onConfirm={onReconfigure}/>
  </section>;
}
