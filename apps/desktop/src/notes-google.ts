/**
 * owner: notes. Google Docs sync, main-process side: OAuth 2.0 for installed apps with PKCE and
 * a loopback redirect (no client secret; the client ID comes from MAGIC_GOOGLE_CLIENT_ID), the
 * `drive.file` scope only, and a proxy that performs the worker's Drive requests. Tokens live in
 * the encrypted vault (Electron safeStorage) and never leave main; the worker sees only Drive
 * responses. Purge clears the vault, so it removes the token too.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { z } from "zod";

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const VAULT_KEY = "notes:google";
const CONNECT_TIMEOUT_MS = 5 * 60_000;

const tokenResponse = z.object({
  access_token: z.string().min(1).max(4000),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).max(4000).optional(),
  scope: z.string().max(2000).optional(),
});
const saved = z.object({ refresh: z.string().min(1).max(4000), access: z.string().max(4000), expiresAt: z.number() });
type Saved = z.infer<typeof saved>;
export const driveRequestSchema = z
  .object({
    method: z.enum(["GET", "POST", "PATCH"]),
    url: z.string().max(4000),
    headers: z.object({ "content-type": z.string().max(200) }).strict().optional(),
    body: z.instanceof(Uint8Array).optional(),
  })
  .strict();

/** Only Drive's files endpoints on googleapis.com, https, no credentials in the URL. */
export function checkedDriveUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.googleapis.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/(?:upload\/)?drive\/v3\/files(?:\/[^/]+(?:\/export)?)?$/.test(url.pathname) ||
    [...url.searchParams.keys()].some((k) => /token|key|secret/i.test(k))
  )
    throw new Error("Drive request refused.");
  return url.href;
}

export interface GoogleNotesAuthOptions {
  clientId: string | undefined;
  vault: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void>; deletePrefix(prefix: string): Promise<void> };
  openExternal(url: string): Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}
export function createGoogleNotesAuth(options: GoogleNotesAuthOptions) {
  const http = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let pending: Promise<boolean> | null = null;
  async function read(): Promise<Saved | null> {
    const raw = await options.vault.get(VAULT_KEY);
    if (!raw) return null;
    const parsed = saved.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }
  async function exchange(body: Record<string, string>): Promise<z.infer<typeof tokenResponse>> {
    const response = await http(TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Google sign-in failed (HTTP ${response.status}).`);
    return tokenResponse.parse(await response.json());
  }
  async function connectOnce(): Promise<boolean> {
    const clientId = options.clientId;
    if (!clientId) return false;
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(24).toString("base64url");
    let server: Server | undefined;
    let redirect = "";
    try {
      const code = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Google sign-in timed out.")), CONNECT_TIMEOUT_MS);
        server = createServer((req, res) => {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          const done = (text: string) => {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(`<!doctype html><title>My Magic UW</title><p>${text}</p>`);
          };
          if (url.searchParams.get("state") !== state) return done("This sign-in link doesn't match. Start again from the app.");
          clearTimeout(timer);
          const got = url.searchParams.get("code");
          if (!got) {
            done("Google sign-in was cancelled. You can close this tab.");
            reject(new Error("Google sign-in was cancelled."));
            return;
          }
          done("Signed in. You can close this tab and return to My Magic UW.");
          resolve(got);
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server!.address();
          if (!address || typeof address === "string") return reject(new Error("Loopback unavailable."));
          redirect = `http://127.0.0.1:${address.port}`;
          const auth = new URL(AUTH);
          for (const [k, v] of Object.entries({
            client_id: clientId,
            redirect_uri: redirect,
            response_type: "code",
            scope: GOOGLE_SCOPE,
            code_challenge: challenge,
            code_challenge_method: "S256",
            state,
            access_type: "offline",
            prompt: "consent",
          }))
            auth.searchParams.set(k, v);
          options.openExternal(auth.href).catch(reject);
        });
      });
      const token = await exchange({ client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, grant_type: "authorization_code" });
      if (!token.refresh_token) throw new Error("Google did not return a refresh token.");
      if (token.scope && !token.scope.split(" ").includes(GOOGLE_SCOPE)) throw new Error("Google did not grant the Drive file scope.");
      await options.vault.set(VAULT_KEY, JSON.stringify({ refresh: token.refresh_token, access: token.access_token, expiresAt: now() + token.expires_in * 1000 }));
      return true;
    } finally {
      server?.close();
    }
  }
  async function accessToken(): Promise<string | null> {
    const current = await read();
    if (!current || !options.clientId) return null;
    if (current.access && current.expiresAt - 60_000 > now()) return current.access;
    const token = await exchange({ client_id: options.clientId, refresh_token: current.refresh, grant_type: "refresh_token" });
    await options.vault.set(VAULT_KEY, JSON.stringify({ ...current, access: token.access_token, expiresAt: now() + token.expires_in * 1000 }));
    return token.access_token;
  }
  return {
    configured: () => Boolean(options.clientId),
    async status() {
      return { connected: Boolean(options.clientId && (await read())) };
    },
    /** One sign-in at a time; the student finishes it in their default browser. */
    async connect() {
      pending ??= connectOnce().finally(() => (pending = null));
      return { connected: await pending };
    },
    async disconnect() {
      await options.vault.deletePrefix(VAULT_KEY);
      return { connected: false };
    },
    async request(raw: unknown): Promise<{ status: number; body: Uint8Array }> {
      const request = driveRequestSchema.parse(raw);
      const url = checkedDriveUrl(request.url);
      const token = await accessToken();
      if (!token) throw new Error("Google Docs isn't connected.");
      const response = await http(url, {
        method: request.method,
        headers: { authorization: `Bearer ${token}`, ...(request.headers ?? {}) },
        ...(request.body ? { body: request.body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
      return { status: response.status, body: new Uint8Array(await response.arrayBuffer()) };
    },
  };
}
