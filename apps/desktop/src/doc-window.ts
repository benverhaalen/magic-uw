/**
 * owner: doc-window. The signed-in document window: a synced note's Word online or Google Doc,
 * opened on the app-owned `persist:uw` session so UW single sign-on (login.wisc.edu) can carry
 * through without a second login. Unverified live; it degrades to the student's own sign-in on
 * the provider's page, with a bar offering the default browser instead.
 *
 * - The document view: `persist:uw`, sandboxed, context-isolated, no Node, no preload, so the page
 *   has no bridge and no IPC; main's `validateSender` also rejects any sender but the workspace.
 * - Every main-frame navigation and redirect is checked (`navigationDecision`); popups to a
 *   document host open another document window (at most MAX_DOC_WINDOWS), everything else goes
 *   to the default browser. Sign-out and purge destroy every document window before the clear.
 * - The bar view: app-owned HTML on its own in-memory partition, no script. Its two links are
 *   intercepted here on `will-navigate`; nothing it loads can reach the document or the app.
 * - Nothing is typed, clicked, read or injected. The trial log records one boolean per window.
 */
import { app, BaseWindow, dialog, WebContentsView, type DownloadItem, type WebContents } from "electron";
import { join } from "node:path";
import { docWindowRegistry, externalUrl, insideFolder, navigationDecision, ssoTracker } from "./doc-window-policy";

const BAR_HEIGHT = 40;
const BAR_BASE = "https://magic-doc-bar.invalid/";
const BAR_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%;font:13px system-ui,-apple-system,"Segoe UI",sans-serif;background:#fff8e1;color:#3b2f00}
body{display:flex;align-items:center;gap:12px;padding:0 12px;border-bottom:1px solid #e6d9a8;box-sizing:border-box}
span{flex:1}a{color:#5a3e00;font-weight:600}
</style></head><body>
<span>Your UW sign-in didn't carry over here. You can sign in on this page, or use your browser.</span>
<a href="${BAR_BASE}open-browser">Open in browser instead</a>
<a href="${BAR_BASE}dismiss" aria-label="Dismiss">Dismiss</a>
</body></html>`;

export interface DocWindows {
  open(url: string): void;
  /** The document view's contents belong to a document window (downloads are allowed there). */
  owns(contents: WebContents): boolean;
  /** Called from the session's `will-download`: the normal save prompt, Downloads folder only. */
  download(item: DownloadItem, contents: WebContents): void;
  /** Close every document window; sign-out and purge call it before clearing `persist:uw`. */
  closeAll(): void;
}

export function createDocWindows(options: {
  openExternal(url: string): Promise<void>;
  /** Dev-only live-trial log; receives `{ event, carried }` and nothing else. */
  trialLog(event: { event: "doc-window.sso"; carried: boolean }): void;
  idleMs?: number;
}): DocWindows {
  const windows = docWindowRegistry<WebContents, BaseWindow>();

  function openExternalSafely(target: string) {
    try {
      void options.openExternal(externalUrl(target)).catch(() => {});
    } catch {
      /* not an ordinary web link: nothing opens */
    }
  }

  function open(documentUrl: string) {
    const win = new BaseWindow({
      width: 1100,
      height: 820,
      title: `Document · ${new URL(documentUrl).hostname}`,
      autoHideMenuBar: true,
    });
    const doc = new WebContentsView({
      webPreferences: {
        partition: "persist:uw",
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    const bar = new WebContentsView({
      webPreferences: {
        partition: "doc-window-bar",
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        javascript: false,
      },
    });
    win.contentView.addChildView(doc);
    win.contentView.addChildView(bar);
    windows.add(doc.webContents, win);
    let barShown = false;
    const layout = () => {
      if (win.isDestroyed()) return;
      const [width, height] = win.getContentSize();
      const top = barShown ? BAR_HEIGHT : 0;
      bar.setBounds({ x: 0, y: 0, width, height: top });
      doc.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
    };
    const showBar = (shown: boolean) => {
      if (barShown === shown) return;
      barShown = shown;
      layout();
    };
    win.on("resize", layout);
    layout();

    // The bar: app-owned HTML, no script; its links are handled here and never load.
    bar.webContents.on("will-navigate", (event) => {
      event.preventDefault();
      if (event.url === `${BAR_BASE}open-browser`) {
        openExternalSafely(documentUrl);
        win.close();
      } else if (event.url === `${BAR_BASE}dismiss`) showBar(false);
    });
    bar.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void bar.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BAR_HTML)}`).catch(() => {});

    const sso = ssoTracker({
      idleMs: options.idleMs ?? 4000,
      report: (carried) => options.trialLog({ event: "doc-window.sso", carried }),
      onInteractive: () => showBar(true),
    });
    const contents = doc.webContents;
    // Main-frame navigations and redirects: the allowlist on every hop.
    contents.on("will-navigate", (event) => {
      if (!event.isMainFrame) return;
      const decision = navigationDecision(event.url, "navigate");
      if (decision === "allow") return;
      event.preventDefault();
      if (decision === "external") openExternalSafely(event.url);
      else showBar(true);
    });
    contents.on("will-redirect", (event) => {
      if (!event.isMainFrame) return;
      if (navigationDecision(event.url, "redirect") === "allow") return;
      // A redirect off the allowlist can carry sign-in state: nothing opens, the bar is offered.
      event.preventDefault();
      showBar(true);
    });
    contents.setWindowOpenHandler(({ url }) => {
      const decision = navigationDecision(url, "window-open");
      // A page cannot fill the desktop: past the limit, a document popup opens nothing.
      if (decision === "allow") {
        if (!windows.full()) open(url);
      }
      else if (decision === "external") openExternalSafely(url);
      return { action: "deny" };
    });
    contents.on("did-start-navigation", (event) => {
      if (event.isMainFrame && !event.isSameDocument) sso.navigating();
    });
    contents.on("did-finish-load", () => sso.loaded(contents.getURL()));
    contents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      if (!win.isDestroyed()) win.setTitle(title ? `${title.slice(0, 120)} · Document` : win.getTitle());
    });

    win.on("closed", () => {
      sso.dispose();
      windows.delete(contents);
      // A BaseWindow does not close its views' contents on its own.
      if (!contents.isDestroyed()) contents.close();
      if (!bar.webContents.isDestroyed()) bar.webContents.close();
    });
    void contents.loadURL(documentUrl).catch(() => {
      /* a blocked redirect aborts the load; the bar is already offered */
    });
  }

  return {
    open,
    owns: (contents) => windows.has(contents),
    closeAll: () => windows.closeAll(),
    download(item, contents) {
      const win = windows.get(contents);
      const downloads = app.getPath("downloads");
      // Electron's normal save prompt, starting in Downloads. `setSavePath` must be called inside
      // `will-download`, so the prompt is the synchronous one; a folder outside Downloads cancels.
      const chosen = win
        ? dialog.showSaveDialogSync(win, { defaultPath: join(downloads, item.getFilename()) })
        : undefined;
      if (chosen && insideFolder(chosen, downloads)) item.setSavePath(chosen);
      else {
        item.cancel();
        if (chosen && win)
          void dialog.showMessageBox(win, {
            type: "info",
            message: "Files from a document window save to your Downloads folder.",
          });
      }
    },
  };
}
