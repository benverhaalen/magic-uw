// owner: accounts. The student's My Magic UW account and whether it has bought the app.
// Sign-in is an emailed 6-digit code (Supabase email OTP); the refresh token lives in the
// encrypted vault and the short-lived access token only in memory, never in the renderer.
// This module reports status only: nothing in the app is locked by it yet.
// See docs/accounts-and-payments.md.
import type { AccountPurchase, AccountStatus } from "@magic/contracts";

export interface AccountConfig {
  /** Supabase project URL, e.g. https://abc.supabase.co. Absent: accounts are off. */
  url?: string;
  /** The project's public (anon / publishable) key. */
  anonKey?: string;
  /** The website's account page, opened to buy. */
  accountUrl?: string;
}

interface Vault {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

/** A paid status keeps counting for this long without reaching the server (offline grace). */
export const OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const CODE = /^\d{6,10}$/;
const KEY = { refresh: "account:refresh", email: "account:email", cache: "account:cache" } as const;

class AuthRejected extends Error {}

export function createAccount(
  config: AccountConfig,
  deps: { vault: Vault; fetch?: typeof fetch; now?: () => number },
) {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const base = config.url?.replace(/\/+$/, "");
  const configured = Boolean(base && config.anonKey && /^https:\/\//.test(base));
  let access: { token: string; expiresAt: number } | null = null;

  async function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
    const response = await fetchImpl(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        apikey: config.anonKey!,
        "Content-Type": "application/json",
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (response.status === 429) throw new AuthRejected("429");
    if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 422)
      throw new AuthRejected(String(data.error_code ?? data.msg ?? response.status));
    if (!response.ok) throw new Error(`Account server ${response.status}`);
    return data;
  }

  async function keepSession(data: Record<string, unknown>) {
    const token = data.access_token, refresh = data.refresh_token, expires = data.expires_in;
    if (typeof token !== "string" || typeof refresh !== "string") throw new Error("The sign-in response was incomplete.");
    access = { token, expiresAt: now() + (typeof expires === "number" ? expires : 3600) * 1000 };
    await deps.vault.set(KEY.refresh, refresh);
    const email = (data.user as { email?: unknown } | undefined)?.email;
    if (typeof email === "string") await deps.vault.set(KEY.email, email);
  }

  async function accessToken(): Promise<string | null> {
    if (access && access.expiresAt - now() > 60_000) return access.token;
    const refresh = await deps.vault.get(KEY.refresh);
    if (!refresh) return null;
    try {
      await keepSession(await call("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: refresh } }));
    } catch (error) {
      if (error instanceof AuthRejected) {
        // The server no longer accepts this sign-in (signed out elsewhere, or expired): forget it.
        await forget();
        return null;
      }
      throw error;
    }
    return access!.token;
  }

  async function forget() {
    access = null;
    await deps.vault.deletePrefix("account:");
  }

  function purchaseOf(row: { status?: unknown; test_mode?: unknown } | undefined): AccountPurchase {
    if (!row) return "not-bought";
    if (row.status === "refunded") return "refunded";
    if (row.status === "paid") return row.test_mode ? "test-only" : "paid";
    return "not-bought";
  }

  async function cached(): Promise<{ purchase: AccountPurchase; checkedAt: number } | null> {
    try {
      const value = JSON.parse((await deps.vault.get(KEY.cache)) ?? "null");
      return value && typeof value.checkedAt === "number" && typeof value.purchase === "string" ? value : null;
    } catch {
      return null;
    }
  }

  return {
    configured,
    buyUrl(): string | null {
      if (!config.accountUrl || !/^https:\/\//.test(config.accountUrl)) return null;
      const url = new URL(config.accountUrl);
      url.searchParams.set("buy", "1");
      return url.href;
    },

    async status(): Promise<AccountStatus> {
      if (!configured) return { state: "unconfigured" };
      const email = await deps.vault.get(KEY.email);
      if (!(await deps.vault.get(KEY.refresh))) return { state: "signed-out" };
      try {
        const token = await accessToken();
        if (!token) return { state: "signed-out" };
        const rows = (await call("/rest/v1/entitlements?select=status,test_mode", { token })) as unknown;
        const purchase = purchaseOf(Array.isArray(rows) ? rows[0] : undefined);
        const checkedAt = now();
        await deps.vault.set(KEY.cache, JSON.stringify({ purchase, checkedAt }));
        return { state: "signed-in", email: email ?? "", purchase, entitled: purchase === "paid", checkedAt: new Date(checkedAt).toISOString(), offline: false };
      } catch (error) {
        if (error instanceof AuthRejected) return { state: "signed-out" };
        // Offline or the server is down: fall back to the last confirmed answer, for a while.
        const last = await cached();
        const withinGrace = last ? now() - last.checkedAt < OFFLINE_GRACE_MS : false;
        const purchase: AccountPurchase = !last ? "unknown" : last.purchase === "paid" && !withinGrace ? "unknown" : last.purchase;
        return {
          state: "signed-in",
          email: email ?? "",
          purchase,
          entitled: purchase === "paid",
          checkedAt: last ? new Date(last.checkedAt).toISOString() : undefined,
          offline: true,
        };
      }
    },

    async sendCode(email: string): Promise<{ sent: boolean; reason?: "invalid" | "rate-limited" | "unavailable" }> {
      if (!configured) return { sent: false, reason: "unavailable" };
      const address = email.trim();
      if (!EMAIL.test(address)) return { sent: false, reason: "invalid" };
      try {
        await call("/auth/v1/otp", { method: "POST", body: { email: address, create_user: true } });
        return { sent: true };
      } catch (error) {
        if (error instanceof AuthRejected && /rate|429/i.test(error.message)) return { sent: false, reason: "rate-limited" };
        return { sent: false, reason: error instanceof AuthRejected ? "invalid" : "unavailable" };
      }
    },

    async verifyCode(email: string, code: string): Promise<{ signedIn: boolean; reason?: "invalid" | "wrong-code" | "unavailable" }> {
      if (!configured) return { signedIn: false, reason: "unavailable" };
      const address = email.trim();
      const token = code.replace(/\s+/g, "");
      if (!EMAIL.test(address) || !CODE.test(token)) return { signedIn: false, reason: "invalid" };
      try {
        await keepSession(await call("/auth/v1/verify", { method: "POST", body: { type: "email", email: address, token } }));
        return { signedIn: true };
      } catch (error) {
        return { signedIn: false, reason: error instanceof AuthRejected ? "wrong-code" : "unavailable" };
      }
    },

    async signOut(): Promise<void> {
      const token = access?.token;
      if (configured && token) await call("/auth/v1/logout?scope=local", { method: "POST", token }).catch(() => undefined);
      await forget();
    },
  };
}
