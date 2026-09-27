// owner: T05e. What the sign-in window's preload needs about UW's NetID login page, with no
// imports: the sandboxed preload can't load Node modules, and main and the tests share it.

/** UW's NetID login origin, measured in the P1 trial (research/piece-P1/brief-uw-sso.md §1). */
export const NETID_LOGIN_ORIGIN = "https://login.wisc.edu";
/** Field names on UW's NetID form (measured 2026-09-27 from the public page, execution=e1s2). */
export const NETID_FORM = Object.freeze({
  form: "form#loginForm",
  username: "j_username",
  password: "j_password",
  submit: "_eventId_proceed",
});

/**
 * True only for a page on UW's exact NetID login origin (https, default port, no userinfo), under
 * the IdP's /idp/ path. A look-alike host, another port or scheme, or a subdomain is refused.
 */
export function isNetIdLoginPage(input: unknown): boolean {
  if (typeof input !== "string" || input.length > 8000) return false;
  try {
    const url = new URL(input);
    return (
      url.origin === NETID_LOGIN_ORIGIN &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith("/idp/")
    );
  } catch {
    return false;
  }
}

export interface RememberedSignIn {
  netid: string;
  password: string;
}
/** What the sign-in window's box shows. Never carries the credential except `fill`. */
export type SignInPageState =
  | { offer: false }
  | {
      offer: true;
      checked: boolean;
      disabledReason?: string;
      notice?: "failed";
      fill?: RememberedSignIn;
    };
export function isSignInPageState(value: unknown): value is SignInPageState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.offer === false) return true;
  if (v.offer !== true || typeof v.checked !== "boolean") return false;
  if (v.disabledReason !== undefined && typeof v.disabledReason !== "string") return false;
  if (v.notice !== undefined && v.notice !== "failed") return false;
  if (v.fill === undefined) return true;
  const fill = v.fill as Record<string, unknown> | null;
  return !!fill && typeof fill.netid === "string" && typeof fill.password === "string";
}

export const REMEMBER_LABEL = "Remember my sign-in on this computer";
export const REMEMBER_NOTE =
  "Stored encrypted on this computer only, and only ever entered on UW's own sign-in page. Remove it any time in My Magic UW under Sources › UW Canvas (Forget my sign-in).";
export const REMEMBER_FAILED =
  "Your saved sign-in didn't work, so My Magic UW removed it. Sign in as usual; tick the box to save the new one.";

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/**
 * The box's markup, set into a closed shadow root beside UW's form so the page's own scripts can't
 * reach it. Off by default; a disabled box says why. Only fixed texts, escaped.
 */
export function rememberBoxMarkup(state: {
  checked: boolean;
  disabledReason?: string;
  notice?: "failed";
}): string {
  const disabled = state.disabledReason !== undefined;
  return [
    "<style>",
    ":host{display:block;margin:14px 0;font:13px/1.45 system-ui,sans-serif;color:#282927}",
    "label{display:flex;gap:8px;align-items:flex-start;cursor:pointer}",
    "label.off{cursor:default;color:#77776b}",
    "input{margin:2px 0 0}",
    "p{margin:4px 0 0 24px;font-size:12px;color:#5f5f55}",
    "p.warn{color:#8a3b12}",
    "</style>",
    state.notice === "failed" ? `<p class="warn" role="alert">${escape(REMEMBER_FAILED)}</p>` : "",
    `<label class="${disabled ? "off" : "on"}">`,
    `<input type="checkbox" id="magic-remember"${state.checked && !disabled ? " checked" : ""}${disabled ? " disabled" : ""}>`,
    `<span>${escape(REMEMBER_LABEL)}</span>`,
    "</label>",
    `<p>${escape(disabled ? state.disabledReason! : REMEMBER_NOTE)}</p>`,
  ].join("");
}

/** The student's own click on UW's submit button, or Enter in the form, must be this recent. */
export const SUBMIT_INTENT_MS = 2000;
/** True when a form's resolved action (or the submitter's formaction) posts to the NetID origin. */
export function formPostsToNetId(actionUrl: string | null): boolean {
  if (!actionUrl) return false;
  try {
    const url = new URL(actionUrl);
    return url.origin === NETID_LOGIN_ORIGIN && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** The capture message the preload sends: the typed sign-in only when the box is ticked. */
export type SignInCaptureMessage =
  | { remember: false }
  | { remember: true; signIn: RememberedSignIn };
/** UW's NetID form, as the preload found it in the page (DOM glue in signin-preload.ts). */
export interface NetIdFormHandle {
  username: { value: string };
  password: { value: string };
  /** Puts the box beside UW's submit button; returns the checkbox, or null. */
  insertBox(markup: string): BoxHandle | null;
  /** Fires input events on both fields and submits through UW's own button. */
  submit(): void;
  isForm(target: unknown): boolean;
  connected(): boolean;
  /** Where a submit would post: the submitter's formaction, else the form's action, resolved. */
  actionUrl(): string | null;
  /** The form and both fields are rendered and visible (not hidden, transparent or zero-size). */
  visible(): boolean;
  /** A trusted click on UW's submit button, or a trusted Enter keydown inside the form. */
  onSubmitIntent(listener: () => void): void;
}
export interface BoxHandle {
  checked: boolean;
  /** `trusted` is the change event's isTrusted: only the student's own click counts. */
  onChange(listener: (trusted: boolean) => void): void;
}
export interface SignInPageEnv {
  /** window.top === window, read live. */
  isTop(): boolean;
  /** location.href, read live. */
  href(): string;
  findForm(): NetIdFormHandle | null;
  onSubmit(
    listener: (event: { target: unknown; isTrusted: boolean; defaultPrevented: boolean }) => void,
  ): void;
  /** invoke("magic-signin:page") */
  pageState(): Promise<unknown>;
  /** send("magic-signin:capture", …) */
  capture(message: SignInCaptureMessage): void;
  /** A clock (ms), for the submit-intent window. */
  now(): number;
}

/**
 * The sign-in page's rules. Acts only in the top frame on UW's exact NetID login origin with the
 * NetID form present; re-checks both before filling, with the form visible and posting to the
 * NetID origin. The box starts as main says (off unless a sign-in is saved) and changes only on
 * the student's own click. A capture is sent only for the student's own submit (a trusted click
 * on UW's button or Enter in the form within SUBMIT_INTENT_MS), never for the automatic one.
 * A fill happens once, only when main sent it.
 */
export async function runSignInPage(
  env: SignInPageEnv,
): Promise<"skipped" | "offered" | "filled"> {
  const here = () => env.isTop() && isNetIdLoginPage(env.href());
  if (!here()) return "skipped";
  const form = env.findForm();
  if (!form) return "skipped";
  let state: unknown;
  try {
    state = await env.pageState();
  } catch {
    return "skipped";
  }
  if (!isSignInPageState(state) || !state.offer || !here()) return "skipped";
  const offered = state;
  const disabled = offered.disabledReason !== undefined;
  let checked = offered.checked && !disabled;
  const box = form.insertBox(rememberBoxMarkup(offered));
  box?.onChange((trusted) => {
    if (!trusted || disabled) {
      box.checked = checked;
      return;
    }
    checked = box.checked;
  });
  let autoSubmitting = false;
  // A trusted submit event alone isn't proof: the page can call requestSubmit(). The student's own
  // click on UW's button, or Enter in the form, must have come just before.
  let intentAt = Number.NEGATIVE_INFINITY;
  form.onSubmitIntent(() => {
    intentAt = env.now();
  });
  env.onSubmit((event) => {
    const elapsed = env.now() - intentAt;
    if (
      !form.isForm(event.target) ||
      !event.isTrusted ||
      event.defaultPrevented ||
      !(elapsed >= 0 && elapsed <= SUBMIT_INTENT_MS) ||
      autoSubmitting ||
      disabled ||
      !here()
    )
      return;
    env.capture(
      checked
        ? { remember: true, signIn: { netid: form.username.value, password: form.password.value } }
        : { remember: false },
    );
  });
  const fill = offered.fill;
  // Filled only into a rendered, visible NetID form that posts back to the NetID origin.
  if (
    !fill ||
    !here() ||
    !form.connected() ||
    !form.visible() ||
    !formPostsToNetId(form.actionUrl())
  )
    return "offered";
  form.username.value = fill.netid;
  form.password.value = fill.password;
  autoSubmitting = true;
  form.submit();
  return "filled";
}
// end owner: T05e
