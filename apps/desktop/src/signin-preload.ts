// owner: T05e. The UW sign-in window's preload: the "Remember my sign-in" box, the capture and
// the fill (plan D39, spec A1). It exposes nothing to the page (no contextBridge), and Electron
// loads a preload in the top frame only, never in an iframe. The rules live in runSignInPage
// (signin-page.ts, tested); this file is only the DOM glue. It acts only when the top frame is on
// UW's exact NetID login origin with the NetID form on screen. Every other page, Duo's included,
// is left untouched: Duo is never read, filled, clicked or approved here.
//
// Two IPC messages, both checked in main by sender, frame and origin:
// - magic-signin:page (invoke): the box's state, and once per automatic window the saved sign-in
// - magic-signin:capture (send): on the student's own submit, the typed sign-in when the box is
//   ticked, or { remember: false } when it isn't
// The password crosses once at capture and once at fill. Nothing here logs.
import { ipcRenderer } from "electron";
import { NETID_FORM, runSignInPage, type NetIdFormHandle } from "./signin-page";

function findForm(): NetIdFormHandle | null {
  const form = document.querySelector<HTMLFormElement>(NETID_FORM.form);
  const username = form?.elements.namedItem(NETID_FORM.username);
  const password = form?.elements.namedItem(NETID_FORM.password);
  if (
    !form ||
    !(username instanceof HTMLInputElement) ||
    !(password instanceof HTMLInputElement) ||
    password.type !== "password"
  )
    return null;
  const button = form.querySelector(`button[name="${NETID_FORM.submit}"]`);
  const submitter = button instanceof HTMLButtonElement && button.form === form ? button : undefined;
  return {
    username,
    password,
    insertBox(markup) {
      // A closed shadow root: the page's own scripts can't read or tick the box.
      const host = document.createElement("div");
      const shadow = host.attachShadow({ mode: "closed" });
      shadow.innerHTML = markup;
      const anchor = submitter?.closest("div");
      if (anchor && form.contains(anchor)) anchor.before(host);
      else form.append(host);
      const box = shadow.querySelector("input");
      if (!box) return null;
      return {
        get checked() {
          return box.checked;
        },
        set checked(value) {
          box.checked = value;
        },
        onChange(listener) {
          box.addEventListener("change", (event) => listener(event.isTrusted));
        },
      };
    },
    submit() {
      for (const input of [username, password])
        input.dispatchEvent(new Event("input", { bubbles: true }));
      form.requestSubmit(submitter);
    },
    isForm: (target) => target === form,
    connected: () => form.isConnected,
    actionUrl() {
      // getAttribute, not form.action: a field named "action" would shadow the property.
      const raw = submitter?.getAttribute("formaction") ?? form.getAttribute("action") ?? "";
      try {
        return new URL(raw, window.location.href).href;
      } catch {
        return null;
      }
    },
    visible: () =>
      [form, username, password].every(
        (element) =>
          element.getClientRects().length > 0 &&
          element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      ),
    onSubmitIntent(listener) {
      window.addEventListener(
        "click",
        (event) => {
          if (event.isTrusted && submitter && event.target instanceof Node && submitter.contains(event.target))
            listener();
        },
        true,
      );
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.isTrusted && event.key === "Enter" && event.target instanceof Node && form.contains(event.target))
            listener();
        },
        true,
      );
    },
  };
}

function start() {
  void runSignInPage({
    isTop: () => window.top === window,
    href: () => window.location.href,
    findForm,
    // Bubbling to window: the page's own handlers have run, so defaultPrevented is final.
    onSubmit: (listener) => window.addEventListener("submit", listener),
    pageState: () => ipcRenderer.invoke("magic-signin:page"),
    capture: (message) => ipcRenderer.send("magic-signin:capture", message),
    now: () => performance.now(),
  }).catch(() => {});
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
// end owner: T05e
