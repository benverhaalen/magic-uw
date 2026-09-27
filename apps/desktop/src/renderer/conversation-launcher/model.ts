// owner: conversation-launcher leaf. Pure launcher state; the component only renders it.
// Drafts live in renderer memory: they can contain coursework and are never saved or sent before submit.

export type LauncherDestination = { kind: "new-chat" } | { kind: "follow-up"; chatId: string };

/** What a nonempty submit hands to the integrator. Structurally the chat lane's `ChatEntry` when `O` is its `ChatOrigin`. */
export interface LauncherEntry<O> {
  prompt: string;
  /** Captured with the draft; route changes never silently redirect a message. */
  destination: LauncherDestination;
  /** Captured once when the draft started (or explicitly rebased). Never refreshed behind the student's back. */
  origin: O;
  /** One per submit gesture. Retrying unchanged text reuses it, so the owner can return the same chat. */
  idempotencyKey: string;
}

/** The integrator's answer. Accepted means the chat owner took the entry; it does not mean an answer arrived. */
export type SubmitOutcome = { accepted: true } | { accepted: false; message?: string };

export interface Draft<O> {
  text: string;
  origin: O;
  /** `here.key` when the origin was captured, to tell the student when they have moved away from it. */
  originKey: string;
  destination?: LauncherDestination;
  /** Latched at the first submit of this text; cleared when the text or origin changes. */
  key: string | null;
}

export interface LauncherState<O> {
  open: boolean;
  draft: Draft<O> | null;
  /** The key of the submission in flight; further submits are ignored until it settles. */
  sending: string | null;
  error: string | null;
}

export const initialLauncher = <O>(): LauncherState<O> => ({ open: false, draft: null, sending: null, error: null });

export const isBlank = (text: string) => text.trim() === "";

/** Opening never captures again while a draft is held: the draft keeps the context it was written in. */
export function expand<O>(state: LauncherState<O>, capture: () => { origin: O; originKey: string; destination?: LauncherDestination }): LauncherState<O> {
  if (state.open) return state;
  const draft = state.draft ?? { text: "", ...capture(), key: null };
  return { ...state, open: true, draft };
}

/** Escape, close, outside press or focus leaving. A blank draft is dropped so the next open takes fresh context. */
export function collapse<O>(state: LauncherState<O>): LauncherState<O> {
  if (!state.open) return state;
  const keep = state.draft && (!isBlank(state.draft.text) || state.sending);
  return { ...state, open: false, draft: keep ? state.draft : null, error: keep ? state.error : null };
}

export function edit<O>(state: LauncherState<O>, text: string): LauncherState<O> {
  if (!state.draft || state.sending) return state;
  const key = text === state.draft.text ? state.draft.key : null;
  return { ...state, draft: { ...state.draft, text, key }, error: null };
}

/** Explicit "Use this page": the only way a held draft changes context. */
export function rebase<O>(state: LauncherState<O>, capture: () => { origin: O; originKey: string; destination?: LauncherDestination }): LauncherState<O> {
  if (!state.draft || state.sending) return state;
  return { ...state, draft: { ...state.draft, ...capture(), key: null }, error: null };
}

/** Returns the entry to send, or null when there is nothing to send or a send is in flight. */
export function beginSubmit<O>(state: LauncherState<O>, freshKey: () => string): { state: LauncherState<O>; entry: LauncherEntry<O> } | null {
  const draft = state.draft;
  if (!draft || state.sending || isBlank(draft.text)) return null;
  const key = draft.key ?? freshKey();
  return {
    state: { ...state, sending: key, error: null, draft: { ...draft, key } },
    entry: { prompt: draft.text, origin: draft.origin, destination: draft.destination ?? { kind: "new-chat" }, idempotencyKey: key },
  };
}

export const SUBMIT_FAILED = "The chat didn't start. Your message is still here.";

/** Settles only the submission that is still current. Acceptance clears the draft; failure keeps text and origin. */
export function settleSubmit<O>(state: LauncherState<O>, key: string, outcome: SubmitOutcome): LauncherState<O> {
  if (state.sending !== key) return state;
  if (outcome.accepted) return initialLauncher<O>();
  return { ...state, sending: null, error: outcome.message || SUBMIT_FAILED };
}
