import { MagicGlyph } from '../../../../../packages/ui/src/glyph';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  beginSubmit, collapse, edit, expand, initialLauncher, isBlank, rebase, settleSubmit,
  type LauncherDestination, type LauncherEntry, type LauncherState, type SubmitOutcome,
} from "./model";
import { voiceAnnouncement } from "../voice/launcher-voice";
import "./launcher.css";

// owner: conversation-launcher leaf. One shell-level instance; the integrator keeps it mounted across pages.
type LauncherGlyphName = 'message' | 'mic' | 'close' | 'send' | 'stop';
const Glyph = ({ name }: { name: LauncherGlyphName }) =>
  <MagicGlyph className="cl-glyph" name={name} />;

/** Where the student is now. Cheap and reactive; the full origin is only captured when a draft starts. */
export interface LauncherHere { key: string; label: string }

/** `unavailable`: this Mac cannot do voice, the mic only explains. `error`: the last session ended with a
 * problem; the reason is shown and pressing the mic tries again. */
export type LauncherVoiceState = "unavailable" | "error" | "ready" | "starting" | "listening" | "processing";
/** Supplied by the voice owner. The launcher never records, simulates or animates audio on its own. */
export interface LauncherVoice {
  state: LauncherVoiceState;
  /** Shown when the student presses an unavailable mic, or when an active session ends in error or unavailable. */
  reason?: string;
  /** Recent levels in 0..1 from the actual input analyser, newest last. Only drawn while listening. */
  levels?: readonly number[];
  onStart?: () => void;
  /** Must work without waiting for the model or network. */
  onStop?: () => void;
}
const NO_VOICE: LauncherVoice = { state: "unavailable", reason: "Voice isn't available yet. You can type instead." };

export interface ConversationLauncherProps<O extends { label: string }> {
  here: LauncherHere;
  /** Local read of the page's semantic context. Called when a draft starts or on "Use this page"; never on focus. */
  captureOrigin: () => O;
  /** Called only for a nonempty submit, at most once per idempotency key at a time. */
  onSubmit: (entry: LauncherEntry<O>) => SubmitOutcome | Promise<SubmitOutcome>;
  /** Proposal: "follow-up" only relabels the control while a chat is shown; the integrator routes the entry. */
  mode?: "new-chat" | "follow-up";
  /** Required for follow-up mode. Captured with the draft, never inferred at submit. */
  chatId?: string;
  placeholder?: string;
  voice?: LauncherVoice;
  /** Voice owner feedback, e.g. the heard transcript. Shown when no other note is up. */
  feedback?: string;
  newKey?: () => string;
}

export function ConversationLauncher<O extends { label: string }>({
  here, captureOrigin, onSubmit, mode = "new-chat", chatId, placeholder, voice = NO_VOICE, feedback, newKey = () => crypto.randomUUID(),
}: ConversationLauncherProps<O>) {
  const [state, setState] = useState<LauncherState<O>>(initialLauncher);
  // Transitions read and write the ref synchronously so a double press in one tick cannot send twice.
  const live = useRef(state);
  const apply = (next: LauncherState<O>) => { live.current = next; setState(next); };
  const [note, setNote] = useState<string | null>(null);
  // Voice problems carry their own recovery actions, so they are kept apart from the plain status note.
  const [voiceProblem, setVoiceProblem] = useState<{ text: string; retry: boolean } | null>(null);
  const [voiceLive, setVoiceLive] = useState("");
  const dock = useRef<HTMLDivElement>(null), mic = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null), toggle = useRef<HTMLButtonElement>(null), field = useRef<HTMLTextAreaElement>(null);
  const focusAfter = useRef<"field" | "toggle" | null>(null);
  const mounted = useRef(true);
  const id = useId();
  const { open, draft, sending, error } = state;
  const moved = !!draft && draft.originKey !== here.key;
  const currentDestination: LauncherDestination = mode === "follow-up" && chatId
    ? { kind: "follow-up", chatId } : { kind: "new-chat" };
  const destination = draft?.destination ?? currentDestination;
  const capture = () => ({ origin: captureOrigin(), originKey: here.key, destination: currentDestination });

  const openComposer = () => { focusAfter.current = "field"; setNote(null); apply(expand(live.current, capture)); };
  /** `restore` only when the dismissal started inside the launcher; outside presses keep the student's new target. */
  const close = (restore: boolean) => {
    if (!live.current.open) return;
    setNote(null);
    focusAfter.current = restore ? "toggle" : null;
    apply(collapse(live.current));
  };

  useLayoutEffect(() => {
    const target = focusAfter.current === "field" ? field.current : focusAfter.current === "toggle" ? toggle.current : null;
    focusAfter.current = null;
    if (target === field.current && field.current) {
      field.current.focus({ preventScroll: true });
      field.current.setSelectionRange(field.current.value.length, field.current.value.length);
    } else target?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // An outside press or focus arriving elsewhere (Tab, including wrap-around) dismisses without redirecting it.
  // Switching apps moves no focus inside the document, so the composer stays open.
  useEffect(() => {
    if (!open && !note && !voiceProblem) return;
    const outside = (event: Event) => {
      // The voice problem's own buttons sit outside the pill; pressing them is not an outside press.
      if (root.current?.contains(event.target as Node) || (voiceProblem && dock.current?.contains(event.target as Node))) return;
      setNote(null);
      setVoiceProblem(null);
      close(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
    };
  });

  // A session that ends in error (denied, device removed, too long) or becomes unavailable explains itself once,
  // with a keyboard route to retry or type. Ordinary transitions are announced politely, never animated here.
  const lastVoice = useRef(voice.state);
  useEffect(() => {
    const was = lastVoice.current;
    lastVoice.current = voice.state;
    const said = voiceAnnouncement(was, voice.state);
    if (said) setVoiceLive(said);
    if (voice.state === "starting") setVoiceProblem(null);
    if ((voice.state === "error" || voice.state === "unavailable") && was !== voice.state && was !== "ready" && was !== "unavailable")
      setVoiceProblem({ text: voice.reason ?? NO_VOICE.reason!, retry: voice.state === "error" });
  }, [voice.state, voice.reason]);

  const submit = async () => {
    const begun = beginSubmit(live.current, newKey);
    if (!begun) return;
    apply(begun.state);
    const key = begun.entry.idempotencyKey;
    let outcome: SubmitOutcome;
    try { outcome = await onSubmit(begun.entry); } catch { outcome = { accepted: false }; }
    if (!mounted.current) return;
    apply(settleSubmit(live.current, key, outcome));
    // Collapsed while sending: the composer is inert, so say it where it is seen; the draft dot marks the kept text.
    if (!outcome.accepted && !live.current.open && live.current.error) setNote(live.current.error);
    // The host normally moves focus to the new chat. Only if nobody claimed it, keep it on the launcher.
    if (outcome.accepted) requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || root.current?.contains(active)) toggle.current?.focus({ preventScroll: true });
    });
  };

  const onFieldKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    // IME candidate confirmation also sends Enter; it must never submit.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void submit();
  };
  const onRootKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    if (live.current.open) close(true);
    else if (note) setNote(null);
    else if (voiceProblem) setVoiceProblem(null);
    else if (voice.state === "starting" || voice.state === "listening" || voice.state === "processing") voice.onStop?.();
    else return;
    event.stopPropagation();
  };

  const voiceActive = voice.state === "starting" || voice.state === "listening" || voice.state === "processing";
  const pressVoice = () => {
    if (voice.state === "unavailable") setVoiceProblem({ text: voice.reason ?? NO_VOICE.reason!, retry: false });
    else if (voice.state === "ready" || voice.state === "error") { setNote(null); setVoiceProblem(null); voice.onStart?.(); }
    else voice.onStop?.();
  };

  const followUp = destination.kind === "follow-up";
  const toggleLabel = open ? "Close message box"
    : draft ? `Resume draft${moved ? ` from ${draft.origin.label}` : ""}`
    : followUp ? "Ask a follow-up" : "New chat";
  const blank = !draft || isBlank(draft.text);
  const sendBlocked = blank || !!sending;

  const typeInstead = () => { setVoiceProblem(null); if (!live.current.open) openComposer(); else field.current?.focus(); };
  const retryVoice = () => { setVoiceProblem(null); voice.onStart?.(); };

  return <div ref={dock} className="conversation-launcher-dock">
    <span className="cl-voice-live" role="status" aria-live="polite">{voiceLive}</span>
    {voiceProblem && <div className="cl-voice-problem" role="alert"
      onKeyDown={event => { if (event.key !== "Escape") return; event.stopPropagation(); setVoiceProblem(null); mic.current?.focus({ preventScroll: true }); }}>
      <p>{voiceProblem.text}</p>
      <p className="cl-voice-actions">
        {voiceProblem.retry && <button type="button" className="cl-text-button" onClick={retryVoice}>Try voice again</button>}
        <button type="button" className="cl-text-button" onClick={typeInstead}>Type instead</button>
      </p>
    </div>}
    <p className="cl-note" role="status">{note ?? feedback}</p>
    <div ref={root} className="conversation-launcher" data-open={open || undefined} data-voice={voiceActive ? voice.state : undefined}
      onKeyDown={onRootKey}
      // A press on the surface itself (padding, not yet revealed area) keeps focus where it was.
      onMouseDown={event => { if (!(event.target as Element).closest("button, textarea")) event.preventDefault(); }}>
      <button ref={toggle} type="button" className="cl-icon cl-toggle" aria-expanded={open} aria-controls={`${id}-composer`}
        aria-label={toggleLabel} title={toggleLabel} onClick={() => (open ? close(true) : openComposer())}>
        <Glyph name={open ? "close" : "message"}/>
        {!open && draft && <span className="cl-draft-dot" aria-hidden="true"/>}
      </button>
      <div id={`${id}-composer`} className="cl-composer" inert={!open}>
        {moved && draft && <p className="cl-origin" id={`${id}-origin`}>
          <span>From {draft.origin.label}</span>
          <button type="button" className="cl-text-button" disabled={!!sending} onClick={() => { apply(rebase(live.current, capture)); field.current?.focus(); }}>Use this page</button>
        </p>}
        {error && <p className="cl-error" id={`${id}-error`} role="alert">{error}</p>}
        <div className="cl-row">
          <textarea ref={field} className="cl-field" rows={1} value={draft?.text ?? ""} readOnly={!!sending}
            aria-label={followUp ? "Follow-up message" : "Message for a new chat"}
            aria-describedby={[moved ? `${id}-origin` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined}
            placeholder={(!moved ? placeholder : undefined) ?? (followUp ? "Ask a follow-up" : "Ask a question")}
            onChange={event => apply(edit(live.current, event.target.value))} onKeyDown={onFieldKey}/>
          <button type="button" className="cl-icon cl-send" aria-label={followUp ? "Send follow-up" : "Start chat"}
            aria-disabled={sendBlocked || undefined} aria-busy={!!sending || undefined}
            onClick={() => { if (!sendBlocked) void submit(); }}><Glyph name="send"/></button>
        </div>
      </div>
      {/* While typing, the colored Stop control carries the active voice state; levels return when collapsed. */}
      {!open && <VoiceStatus voice={voice}/>}
      <button ref={mic} type="button" className="cl-icon cl-mic"
        aria-busy={voice.state === "starting" || voice.state === "processing" || undefined}
        aria-label={voice.state === "unavailable" ? "Voice unavailable" : voiceActive ? "Stop voice" : "Start voice"}
        title={voice.state === "unavailable" ? "Voice unavailable" : undefined} onClick={pressVoice}>
        <Glyph name={voiceActive ? "stop" : "mic"}/>
      </button>
    </div>
  </div>;
}

/** Text for states without input, bars only from supplied levels. Nothing moves unless the input does. */
function VoiceStatus({ voice }: { voice: LauncherVoice }): ReactNode {
  if (voice.state === "starting") return <span className="cl-voice-text">Starting</span>;
  if (voice.state === "processing") return <span className="cl-voice-text">Working</span>;
  if (voice.state !== "listening") return null;
  const levels = voice.levels?.slice(-5) ?? [];
  if (!levels.length) return <span className="cl-voice-text">Listening</span>;
  return <span className="cl-levels" role="img" aria-label="Listening">
    {levels.map((level, index) => <span key={index} style={{ transform: `scaleY(${Math.max(0.12, Math.min(1, level))})` }}/>)}
  </span>;
}
