/**
 * owner: T30. The Microsoft sign-in window (Electron). One app-owned window on `persist:uw`, so
 * UW single sign-on carries over. The redirect to `http://localhost` is intercepted here
 * (`will-redirect` / `will-navigate`, then a failed load as the last catch); no listener opens.
 *
 * - silent (hidden): only login.microsoftonline.com and login.wisc.edu. Anything else, or a page
 *   that sits waiting (a sign-in form, Duo, a consent screen), closes the window and reports
 *   `interaction`. Nothing is ever typed, clicked, read or injected.
 * - visible: Microsoft's own window for the student (first-time consent, UW's approval request
 *   form); Duo is the student's own step.
 */
import { BrowserWindow } from "electron";
import { parseRedirect, REDIRECT_URI, type AuthWindow, type AuthorizeOutcome } from "./outlook";

const SILENT_HOSTS = new Set(["login.microsoftonline.com", "login.wisc.edu"]);
function visibleHost(hostname: string): boolean {
  return (
    SILENT_HOSTS.has(hostname) ||
    hostname === "login.microsoft.com" ||
    hostname.endsWith(".microsoftonline.com") ||
    hostname === "wisc.edu" ||
    hostname.endsWith(".wisc.edu") ||
    hostname === "duosecurity.com" ||
    hostname.endsWith(".duosecurity.com")
  );
}
function allowed(input: string, mode: "silent" | "visible"): boolean {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    return mode === "silent" ? SILENT_HOSTS.has(url.hostname) : visibleHost(url.hostname);
  } catch {
    return false;
  }
}
export function electronAuthWindow(options: {
  parent: () => BrowserWindow | null;
  headless: boolean;
  /** A hidden round ends as `interaction` after this long without reaching the redirect. */
  silentTimeoutMs?: number;
  /** A hidden page that finished loading and stays this long is waiting for the student. */
  idleMs?: number;
}): AuthWindow {
  return {
    run(url: string, mode: "silent" | "visible"): Promise<AuthorizeOutcome> {
      if (mode === "visible" && options.headless)
        return Promise.resolve({ kind: "closed" });
      return new Promise<AuthorizeOutcome>((resolve) => {
        const parent = options.parent();
        const win = new BrowserWindow({
          show: mode === "visible",
          width: 520,
          height: 680,
          ...(mode === "visible" && parent ? { parent } : {}),
          title: "Connect Outlook · Microsoft",
          autoHideMenuBar: true,
          webPreferences: {
            partition: "persist:uw",
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
          },
        });
        let settled = false,
          idle: ReturnType<typeof setTimeout> | undefined;
        const finish = (outcome: AuthorizeOutcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(idle);
          resolve(outcome);
          if (!win.isDestroyed()) win.close();
        };
        const timer = setTimeout(
          () => finish({ kind: "interaction" }),
          mode === "silent" ? (options.silentTimeoutMs ?? 20_000) : 30 * 60_000,
        );
        const intercept = (event: Electron.Event, target: string) => {
          if (target.startsWith(REDIRECT_URI)) {
            event.preventDefault();
            const outcome = parseRedirect(target);
            finish(outcome ?? { kind: "interaction" });
            return;
          }
          if (!allowed(target, mode)) {
            event.preventDefault();
            // Hidden: leaving the two sign-in hosts means the student is needed.
            if (mode === "silent") finish({ kind: "interaction" });
          }
        };
        win.webContents.on("will-redirect", intercept);
        win.webContents.on("will-navigate", intercept);
        win.webContents.on("did-fail-load", (_event, _code, _description, failed, mainFrame) => {
          if (mainFrame && failed.startsWith(REDIRECT_URI)) finish(parseRedirect(failed) ?? { kind: "interaction" });
        });
        win.webContents.on("did-start-navigation", () => clearTimeout(idle));
        win.webContents.on("did-finish-load", () => {
          if (mode !== "silent") return;
          // A hidden page that stays put is a form waiting for the student: never fill it.
          clearTimeout(idle);
          idle = setTimeout(() => finish({ kind: "interaction" }), options.idleMs ?? 4000);
        });
        // Permissions on `persist:uw` are already refused by main for the whole partition.
        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        win.on("closed", () => finish(mode === "silent" ? { kind: "interaction" } : { kind: "closed" }));
        win.loadURL(url).catch(() => {
          /* the intercepted redirect aborts the load; the handlers above settle it */
        });
      });
    },
  };
}
