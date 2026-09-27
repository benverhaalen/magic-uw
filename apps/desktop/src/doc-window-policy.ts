/**
 * owner: doc-window. The rules for the signed-in document window, kept free of Electron so they
 * are unit-tested: which links open in the app (Word/Office online and Google Docs, https only),
 * where the window may navigate (those hosts plus the sign-in hosts the UW sign-in window already
 * allows, and Microsoft's and Google's own login hosts), and what happens to everything else.
 *
 * The window never fills a field, never automates Duo and holds no credential: it is an ordinary
 * page on the app-owned `persist:uw` session, so UW single sign-on can carry through by itself.
 */
import { posix, win32 } from "node:path";

const MAX_URL = 4000;

/** https, no user info, bounded; anything else is not a document link. */
function httpsUrl(input: unknown): URL | null {
  if (typeof input !== "string" || input.length > MAX_URL) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}
const under = (hostname: string, domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);

/** Word/Office online, SharePoint/OneDrive and Google Docs/Drive. */
export function isDocumentHost(hostname: string): boolean {
  return (
    under(hostname, "officeapps.live.com") ||
    under(hostname, "office.com") ||
    // Microsoft now serves Word online from `word.cloud.microsoft` (a Microsoft-owned brand TLD).
    under(hostname, "cloud.microsoft") ||
    // Covers `<tenant>.sharepoint.com` and `<tenant>-my.sharepoint.com` (OneDrive for Business).
    under(hostname, "sharepoint.com") ||
    hostname === "onedrive.live.com" ||
    hostname === "docs.google.com" ||
    hostname === "drive.google.com"
  );
}

/** A login page: where an interactive sign-in would wait for the student. */
export function isLoginHost(hostname: string): boolean {
  return (
    hostname === "login.wisc.edu" ||
    under(hostname, "duosecurity.com") ||
    hostname === "login.microsoft.com" ||
    under(hostname, "microsoftonline.com") ||
    hostname === "login.live.com" ||
    hostname === "accounts.google.com"
  );
}

/**
 * Sign-in hosts the window may pass through: the UW sign-in window's own set (wisc.edu and Duo),
 * Microsoft's and Google's login hosts, and the two Google hops a Workspace SAML sign-in makes
 * (the `/a/<domain>/acs` assertion consumer and the cookie hop on accounts.youtube.com).
 */
function isSignInPath(url: URL): boolean {
  const host = url.hostname;
  return (
    under(host, "wisc.edu") ||
    isLoginHost(host) ||
    host === "accounts.youtube.com" ||
    (host === "www.google.com" && url.pathname.startsWith("/a/"))
  );
}

/** A link that opens in the document window. */
export function isDocumentUrl(input: unknown): boolean {
  const url = httpsUrl(input);
  return url !== null && isDocumentHost(url.hostname);
}

/** An ordinary web link the default browser may open: http(s) without user info. */
export function externalUrl(input: unknown): string {
  if (typeof input !== "string" || input.length > MAX_URL) throw new Error("Invalid link.");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid link.");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Only ordinary web links can be opened.");
  return url.toString();
}

/**
 * - `navigate`: a main-frame navigation the page started (a link, a script, a form).
 * - `redirect`: a main-frame server redirect.
 * - `window-open`: a popup or a `target=_blank` link.
 */
export type NavigationKind = "navigate" | "redirect" | "window-open";
/**
 * `allow`: stay in (or, for a popup, open another) document window. `external`: the default
 * browser gets the target instead. `block`: nothing opens; a blocked redirect shows the fallback
 * bar, because a redirect URL can carry sign-in state that must not be handed to another app.
 */
export type NavigationDecision = "allow" | "external" | "block";

export function navigationDecision(target: string, kind: NavigationKind): NavigationDecision {
  const url = httpsUrl(target);
  if (kind === "window-open") {
    if (url && isDocumentHost(url.hostname)) return "allow";
    return isOrdinaryLink(target) ? "external" : "block";
  }
  if (url && (isDocumentHost(url.hostname) || isSignInPath(url))) return "allow";
  if (kind === "redirect") return "block";
  return isOrdinaryLink(target) ? "external" : "block";
}
function isOrdinaryLink(target: string): boolean {
  try {
    externalUrl(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * A path the student chose is strictly inside the Downloads folder. Both are resolved first, so
 * `..` segments can't climb out; case-insensitive only on Windows and macOS.
 */
export function insideFolder(path: string, folder: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!path || !folder) return false;
  const paths = platform === "win32" ? win32 : posix;
  const fold = (value: string) => (platform === "win32" || platform === "darwin" ? value.toLowerCase() : value);
  const rel = paths.relative(fold(paths.resolve(folder)), fold(paths.resolve(path)));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel);
}

export const HEADLESS_DOCUMENT = "External windows are disabled in headless mode.";

/**
 * The `magic:open-document` contract. A document link opens the signed-in document window; any
 * other ordinary web link falls back to the default browser, exactly like `magic:open`.
 */
export async function handleOpenDocument(
  input: unknown,
  deps: {
    headless: boolean;
    openWindow(url: string): void;
    openExternal(url: string): Promise<void>;
  },
): Promise<{ opened: "window" | "browser" }> {
  if (deps.headless) throw new Error(HEADLESS_DOCUMENT);
  if (isDocumentUrl(input)) {
    deps.openWindow(new URL(input as string).toString());
    return { opened: "window" };
  }
  await deps.openExternal(externalUrl(input));
  return { opened: "browser" };
}

/**
 * Whether UW single sign-on carried through, decided once per window: the document loaded without
 * a login page waiting for the student (`true`), or a login page sat idle (`false`). A login host
 * that moves on within the idle window is an SSO bounce and does not count.
 */
export function ssoTracker(options: { idleMs: number; report(carried: boolean): void; onInteractive(): void }) {
  let decided = false,
    idle: ReturnType<typeof setTimeout> | undefined;
  const decide = (carried: boolean) => {
    if (decided) return;
    decided = true;
    options.report(carried);
  };
  return {
    /** A main-frame navigation started: a waiting login page, if any, moved on. */
    navigating() {
      clearTimeout(idle);
    },
    /** The main frame finished loading this URL. */
    loaded(current: string) {
      clearTimeout(idle);
      const url = httpsUrl(current);
      if (!url) return;
      if (isLoginHost(url.hostname)) {
        idle = setTimeout(() => {
          decide(false);
          options.onInteractive();
        }, options.idleMs);
        return;
      }
      if (isDocumentHost(url.hostname)) decide(true);
    },
    dispose() {
      clearTimeout(idle);
    },
  };
}

/** At most this many document windows are open at once; a page's popups past it open nothing. */
export const MAX_DOC_WINDOWS = 5;

/**
 * The open document windows, keyed by their document view's contents. `closeAll` runs before a
 * sign-out or purge clears `persist:uw`, so no live document page can write storage after it.
 */
export function docWindowRegistry<K, W extends { destroy(): void }>(limit = MAX_DOC_WINDOWS) {
  const windows = new Map<K, W>();
  return {
    add: (key: K, win: W) => void windows.set(key, win),
    get: (key: K) => windows.get(key),
    has: (key: K) => windows.has(key),
    delete: (key: K) => void windows.delete(key),
    /** A page may open another document window only below the limit. */
    full: () => windows.size >= limit,
    closeAll() {
      // `destroy`, not `close`: a page's beforeunload handler cannot keep its window open.
      for (const win of [...windows.values()]) win.destroy();
      windows.clear();
    },
  };
}
