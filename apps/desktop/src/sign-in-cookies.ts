// UW's NetID login (Shibboleth at login.wisc.edu) answers "Stale Request" when a sign-in reuses a
// login flow left half-finished, for example by a sign-in window closed before it completed. UW's
// own fix is to clear that site's cookies (kb.wisc.edu/helpdesk/79133). Before a sign-in window
// opens after one that did not finish, main clears only login.wisc.edu's cookies: Duo's
// "Remember me" (duosecurity.com), the Canvas session, and every other site are kept.
// Only cookie names, domains and paths are read, never values.

const LOGIN_HOST = "login.wisc.edu";

export interface CookieLike {
  name: string;
  domain?: string;
  path?: string;
}
export interface CookieStore {
  get(filter: Record<string, never>): Promise<CookieLike[]>;
  remove(url: string, name: string): Promise<void>;
}

/** A cookie set by UW's login page itself (host-only or `.login.wisc.edu`), nothing wider. */
export function isUwLoginCookie(cookie: CookieLike): boolean {
  return (cookie.domain ?? "").replace(/^\./, "").toLowerCase() === LOGIN_HOST;
}

/** Removes UW's login-page cookies from a session; returns how many were removed. */
export async function clearUwLoginCookies(store: CookieStore): Promise<number> {
  const stale = (await store.get({})).filter(isUwLoginCookie);
  for (const cookie of stale) await store.remove(`https://${LOGIN_HOST}${cookie.path || "/"}`, cookie.name);
  return stale.length;
}
