/**
 * owner: T30. Outlook through the app's own Microsoft sign-in (main process only, no Electron
 * import so it tests under Node).
 *
 * - Our own Entra app registration: a public client (no secret), the client ID from
 *   `MAGIC_MS_CLIENT_ID` or `outlook-settings.json`. Without one: "not set up", no network call.
 *   Never Outlook on the web's session, cookies or tokens, and never a Microsoft client ID.
 * - OAuth 2.0 authorization code with PKCE through @azure/msal-node. The authorize page runs in
 *   an app-owned window on the `persist:uw` partition (UW single sign-on carries over); the
 *   redirect to `http://localhost` is intercepted in that window (`AuthWindow`), so no listener
 *   is opened.
 * - Silent first (the lead, 2026-09-26): the MSAL cache, then `prompt=none` in a hidden window;
 *   Microsoft's own window only when it answers interaction/consent/login required, once on its
 *   own; after that only a manual Connect retries. A tenant that blocks consent is
 *   `needs_uw_approval` and is never re-prompted automatically.
 * - Tokens: MSAL's cache, encrypted through `safeStorage` (the `Encryptor`), in main only. The
 *   worker gets Graph data through `graphProxy`, never a token.
 */
import {
  CryptoProvider,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type Configuration,
  type ICachePlugin,
  type INetworkModule,
  type TokenCacheContext,
} from "@azure/msal-node";
import { randomUUID } from "node:crypto";
import {
  evidenceUrlSchema,
  type CalendarProposal,
  type OutlookConnectionState,
  type OutlookStatus,
} from "@magic/contracts";
import {
  APP_FOLDER_TYPES,
  GRAPH_CREATE_EVENT_URL,
  GRAPH_READ_SCOPES,
  GRAPH_ROOT,
  GRAPH_WRITE_SCOPE,
  checkedGraphPrefer,
  checkedGraphUrl,
} from "../../../packages/connectors/src/graph";

export const REDIRECT_URI = "http://localhost";
export const UW_DOMAIN_HINT = "wisc.edu";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------
export interface OutlookConfig {
  clientId: string;
  /** `organizations` (any work or school tenant) unless a tenant is configured. */
  authority: string;
}
/** The client ID from the environment or the settings file; null means "not set up". */
export async function readOutlookConfig(
  env: Record<string, string | undefined>,
  readSettings: () => Promise<string | null>,
): Promise<OutlookConfig | null> {
  let clientId = env.MAGIC_MS_CLIENT_ID?.trim();
  let tenant = env.MAGIC_MS_TENANT?.trim();
  if (!clientId) {
    try {
      const raw = await readSettings();
      const parsed = raw ? (JSON.parse(raw) as { clientId?: unknown; tenant?: unknown }) : {};
      if (typeof parsed.clientId === "string") clientId = parsed.clientId.trim();
      if (!tenant && typeof parsed.tenant === "string") tenant = parsed.tenant.trim();
    } catch {
      return null;
    }
  }
  if (!clientId || !GUID.test(clientId)) return null;
  const safeTenant =
    tenant && (/^[a-z0-9.-]{1,100}$/i.test(tenant) || GUID.test(tenant)) ? tenant : "organizations";
  return { clientId, authority: `https://login.microsoftonline.com/${safeTenant}` };
}

// ---------------------------------------------------------------------------------------------
// The encrypted token cache
// ---------------------------------------------------------------------------------------------
export interface Encryptor {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
export interface FileStore {
  read(path: string): Promise<Buffer | null>;
  write(path: string, value: Buffer | string): Promise<void>;
  remove(path: string): Promise<void>;
}
/** MSAL's cache plugin: the serialized cache is only ever on disk encrypted. */
export function encryptedCachePlugin(path: string, encryptor: Encryptor, files: FileStore): ICachePlugin {
  return {
    async beforeCacheAccess(context: TokenCacheContext) {
      const stored = await files.read(path);
      if (!stored || !encryptor.available()) return;
      try {
        context.tokenCache.deserialize(encryptor.decrypt(stored));
      } catch {
        /* an unreadable cache is an empty one: the student connects again */
      }
    },
    async afterCacheAccess(context: TokenCacheContext) {
      if (!context.cacheHasChanged) return;
      if (!encryptor.available()) throw new Error("Secure credential storage is unavailable.");
      await files.write(path, encryptor.encrypt(context.tokenCache.serialize()));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Authorize outcomes
// ---------------------------------------------------------------------------------------------
export type AuthorizeOutcome =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; error: string; description: string; state: string }
  /** The hidden window met a page that needs the student (a sign-in form, Duo, consent). */
  | { kind: "interaction" }
  /** The student closed Microsoft's window. */
  | { kind: "closed" };
/** Runs one authorize URL in an app-owned window on `persist:uw` and reports how it ended. */
export interface AuthWindow {
  run(url: string, mode: "silent" | "visible"): Promise<AuthorizeOutcome>;
}
/** Parses the intercepted redirect (`http://localhost/?code=…` or `?error=…`). */
export function parseRedirect(input: string): AuthorizeOutcome | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || url.hostname !== "localhost") return undefined;
  const p = url.searchParams;
  const state = p.get("state") ?? "";
  const code = p.get("code");
  if (code) return { kind: "code", code, state };
  const error = p.get("error");
  if (error)
    return { kind: "error", error, description: (p.get("error_description") ?? "").slice(0, 2000), state };
  return undefined;
}
export type AuthErrorClass = "interaction" | "needs_uw_approval" | "declined" | "error";
/**
 * Microsoft's answer, in code. AADSTS90094 (admin consent required) and AADSTS90095 (the
 * admin-consent request form) are UW's block. After the visible window, AADSTS65001 (no
 * consent) means consent could not be granted there either. In the hidden window,
 * interaction_required / login_required / consent_required (and 65001) mean "show the window".
 */
export function classifyAuthorizeError(
  error: string,
  description: string,
  mode: "silent" | "visible",
): { kind: AuthErrorClass; code: string | null } {
  const code = description.match(/AADSTS\d{5,6}/)?.[0] ?? null;
  if (code === "AADSTS90094" || code === "AADSTS90095") return { kind: "needs_uw_approval", code };
  const interaction =
    ["interaction_required", "login_required", "consent_required"].includes(error) ||
    code === "AADSTS65001" ||
    code === "AADSTS50058";
  if (mode === "silent" && interaction) return { kind: "interaction", code: code ?? error };
  if (mode === "visible" && (code === "AADSTS65001" || error === "consent_required"))
    return { kind: "needs_uw_approval", code: code ?? error };
  if (code === "AADSTS65004" || error === "access_denied") return { kind: "declined", code: code ?? error };
  return { kind: "error", code: code ?? error.slice(0, 60) };
}

// ---------------------------------------------------------------------------------------------
// State (not secret: no token, no address) and the auth service
// ---------------------------------------------------------------------------------------------
export interface OutlookState {
  state: OutlookConnectionState;
  scopes: string[];
  reason: string | null;
  approvalRequest: OutlookStatus["approvalRequest"];
  /** Microsoft's window was already shown on its own once; later only a manual Connect shows it. */
  autoPrompted: boolean;
  lastSyncAt: string | null;
  /**
   * The scope strings exactly as Microsoft returned them (for example
   * "https://graph.microsoft.com/Mail.Read"): a silent request in the same form matches MSAL's
   * cached token instead of renewing it on every call.
   */
  tokenScopes: string[];
}
const initialState = (): OutlookState => ({
  state: "not_connected",
  scopes: [],
  reason: null,
  approvalRequest: null,
  autoPrompted: false,
  lastSyncAt: null,
  tokenScopes: [],
});
export interface GraphProxyPayload {
  url?: unknown;
  prefer?: unknown;
  forceRefresh?: unknown;
  binary?: unknown;
  method?: unknown;
  bodyBase64?: unknown;
  contentType?: unknown;
  ifNoneMatch?: unknown;
}
export interface GraphProxyResult {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: string;
}
export interface OutlookDeps {
  config: OutlookConfig | null;
  cachePath: string;
  statePath: string;
  encryptor: Encryptor;
  files: FileStore;
  window: AuthWindow;
  /** The `uw` consent record (setup checkbox) is current. */
  consented(): Promise<boolean>;
  /** Graph and the pre-authenticated download host; never the `persist:uw` session. */
  fetch?: typeof fetch;
  /** Tests: a fake token endpoint (and authority metadata so MSAL makes no discovery call). */
  networkClient?: INetworkModule;
  authOptions?: Pick<Configuration["auth"], "authorityMetadata" | "cloudDiscoveryMetadata" | "knownAuthorities">;
  now?: () => Date;
}
export const DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
const JSON_MAX_BYTES = 8 * 1024 * 1024;
function downloadHostAllowed(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname.endsWith(".sharepoint.com") ||
        url.hostname.endsWith(".files.1drv.com") ||
        url.hostname.endsWith(".1drv.com") ||
        url.hostname.endsWith(".onedrive.com"))
    );
  } catch {
    return false;
  }
}
async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) {
    await response.body?.cancel();
    throw new Error("too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("too_large");
    }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks);
}

export function createOutlook(deps: OutlookDeps) {
  const now = deps.now ?? (() => new Date());
  const doFetch = deps.fetch ?? fetch;
  const crypto = new CryptoProvider();
  let state: OutlookState | undefined;
  let app: PublicClientApplication | undefined;
  let connecting: Promise<OutlookState> | undefined;

  async function load(): Promise<OutlookState> {
    if (state) return state;
    try {
      const raw = await deps.files.read(deps.statePath);
      state = raw ? { ...initialState(), ...(JSON.parse(raw.toString("utf8")) as Partial<OutlookState>) } : initialState();
    } catch {
      state = initialState();
    }
    return state;
  }
  async function save(next: Partial<OutlookState>): Promise<OutlookState> {
    state = { ...(await load()), ...next };
    await deps.files.write(deps.statePath, JSON.stringify(state));
    return state;
  }
  function msal(): PublicClientApplication {
    if (!deps.config) throw new Error("not_set_up");
    app ??= new PublicClientApplication({
      auth: { clientId: deps.config.clientId, authority: deps.config.authority, ...deps.authOptions },
      cache: { cachePlugin: encryptedCachePlugin(deps.cachePath, deps.encryptor, deps.files) },
      ...(deps.networkClient ? { system: { networkClient: deps.networkClient } } : {}),
    });
    return app;
  }
  async function account(): Promise<AccountInfo | undefined> {
    const accounts = await msal().getTokenCache().getAllAccounts();
    return accounts[0];
  }
  function grantedFrom(result: AuthenticationResult): string[] {
    const wanted = [...GRAPH_READ_SCOPES, GRAPH_WRITE_SCOPE].map((s) => s.toLowerCase());
    return [
      ...new Set(
        result.scopes
          .map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, ""))
          .filter((s) => wanted.includes(s.toLowerCase())),
      ),
    ];
  }
  /** The access token for Graph, renewed silently from the encrypted refresh token. */
  async function token(options: { forceRefresh?: boolean; scopes?: string[] } = {}): Promise<string> {
    const current = await load();
    const who = await account();
    if (!who) throw new Error("no_account");
    const scopes =
      options.scopes ??
      (current.tokenScopes.length
        ? current.tokenScopes
        : current.scopes.filter((s) => s !== "offline_access"));
    const result = await msal().acquireTokenSilent({
      account: who,
      scopes: scopes.length ? scopes : ["User.Read"],
      forceRefresh: options.forceRefresh === true,
    });
    return result.accessToken;
  }
  /** One authorize round in the window; returns the new state. */
  async function authorize(mode: "silent" | "visible", scopes: readonly string[]): Promise<OutlookState | "interaction"> {
    const pkce = await crypto.generatePkceCodes();
    const expected = randomUUID();
    const url = await msal().getAuthCodeUrl({
      scopes: [...scopes],
      redirectUri: REDIRECT_URI,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: "S256",
      state: expected,
      domainHint: UW_DOMAIN_HINT,
      responseMode: "query",
      ...(mode === "silent" ? { prompt: "none" } : {}),
    });
    const outcome = await deps.window.run(url, mode);
    if (outcome.kind === "interaction") return "interaction";
    if (outcome.kind === "closed") {
      const current = await load();
      // Closing Microsoft's window is the student's choice; a known UW block stays known.
      return current.state === "needs_uw_approval" ? current : save({ state: "not_connected", reason: "closed" });
    }
    if (outcome.state !== expected) return save({ state: "error", reason: "state_mismatch" });
    if (outcome.kind === "error") {
      const verdict = classifyAuthorizeError(outcome.error, outcome.description, mode);
      if (verdict.kind === "interaction") return "interaction";
      if (verdict.kind === "needs_uw_approval")
        return save({
          state: "needs_uw_approval",
          reason: verdict.code,
          // 90094: no request form (nothing could be sent); 90095 or 65001: the form may have been used.
          approvalRequest: verdict.code === "AADSTS90094" ? "not_sent" : "unknown",
        });
      return save({ state: verdict.kind === "declined" ? "not_connected" : "error", reason: verdict.code });
    }
    const result = await msal().acquireTokenByCode({
      code: outcome.code,
      scopes: [...scopes],
      redirectUri: REDIRECT_URI,
      codeVerifier: pkce.verifier,
    });
    const granted = grantedFrom(result);
    const previous = await load();
    const raw = result.scopes.filter((s) => !/^(?:openid|profile|email|offline_access)$/i.test(s));
    return save({
      state: "connected",
      scopes: [...new Set([...previous.scopes, ...granted])],
      // The read token's scopes; the write scope is asked for on its own (createEvent).
      tokenScopes: scopes.includes(GRAPH_WRITE_SCOPE) && scopes.length === 1 ? previous.tokenScopes : raw,
      reason: null,
      approvalRequest: null,
    });
  }
  async function refuseUnlessReady(): Promise<OutlookState | null> {
    if (!deps.config) return { ...(await load()), state: "not_set_up" };
    if (!(await deps.consented())) return { ...(await load()), state: "not_connected", reason: "setup_consent_required" };
    if (!deps.encryptor.available()) return save({ state: "error", reason: "secure_storage_unavailable" });
    return null;
  }
  /**
   * Silent connect (launch, and after a confirmed UW sign-in): the cache; then `prompt=none` in
   * the hidden window; Microsoft's window only once on its own, and never for a known UW block.
   */
  async function run(manual: boolean, allowVisible: boolean): Promise<OutlookState> {
    const refused = await refuseUnlessReady();
    if (refused) return refused;
    const current = await load();
    if (await account()) {
      try {
        await token();
        return save({ state: "connected", reason: null });
      } catch {
        /* the refresh token no longer works: sign in again below */
        if (current.state === "connected") await save({ state: "expired", reason: "refresh_failed" });
      }
    }
    if (!manual && current.state === "needs_uw_approval") return current;
    const silent = await authorize("silent", GRAPH_READ_SCOPES);
    if (silent !== "interaction") return silent;
    if (!manual && (current.autoPrompted || !allowVisible)) {
      return current.state === "expired" ? current : save({ state: current.state === "connected" ? "expired" : "not_connected", reason: "interaction_required" });
    }
    await save({ autoPrompted: true });
    const visible = await authorize("visible", GRAPH_READ_SCOPES);
    return visible === "interaction" ? save({ state: "not_connected", reason: "interaction_required" }) : visible;
  }
  function single(manual: boolean, allowVisible = true): Promise<OutlookState> {
    connecting ??= run(manual, allowVisible).finally(() => {
      connecting = undefined;
    });
    return connecting;
  }
  async function status(counts: OutlookStatus["counts"] = { messages: 0, events: 0 }, icsConnected = false): Promise<OutlookStatus> {
    const current = await load();
    const outlook: OutlookConnectionState = deps.config ? current.state : "not_set_up";
    return {
      outlook,
      scopes: deps.config ? current.scopes : [],
      canWriteCalendar: current.scopes.some((s) => s.toLowerCase() === GRAPH_WRITE_SCOPE.toLowerCase()),
      approvalRequest: outlook === "needs_uw_approval" ? current.approvalRequest : null,
      reason: deps.config ? current.reason : null,
      lastSyncAt: current.lastSyncAt,
      counts,
      icsConnected,
    };
  }
  /** Deletes the tokens (the encrypted cache) and the state. Delta links are main's vault's. */
  async function disconnect(): Promise<void> {
    app = undefined;
    await deps.files.remove(deps.cachePath);
    await deps.files.remove(deps.statePath);
    state = initialState();
  }
  /** Sign-out: the tokens go, the state says "not connected", the choice to connect stays. */
  async function signOut(): Promise<void> {
    app = undefined;
    await deps.files.remove(deps.cachePath);
    await save({ state: "not_connected", reason: "signed_out", autoPrompted: false });
  }

  /**
   * The worker's Graph proxy: the allowlisted URL, GET only (one PUT into the app folder), the
   * bearer token attached here. The worker gets the status, three headers and the body.
   */
  async function graphProxy(payload: GraphProxyPayload, signal?: AbortSignal): Promise<GraphProxyResult> {
    const method = payload.method === "PUT" ? "PUT" : "GET";
    if (payload.method !== undefined && payload.method !== "GET" && payload.method !== "PUT")
      throw new Error("graph_method");
    const target = checkedGraphUrl(payload.url, method);
    const prefer = checkedGraphPrefer(payload.prefer);
    const ifNoneMatch =
      typeof payload.ifNoneMatch === "string" && /^[\x21-\x7e ]{1,200}$/.test(payload.ifNoneMatch)
        ? payload.ifNoneMatch
        : undefined;
    let body: Buffer | undefined;
    let contentType: string | undefined;
    if (method === "PUT") {
      if (typeof payload.contentType !== "string" || !APP_FOLDER_TYPES.has(payload.contentType))
        throw new Error("graph_content_type");
      if (typeof payload.bodyBase64 !== "string" || payload.bodyBase64.length > Math.ceil(DOWNLOAD_MAX_BYTES / 3) * 4 + 4)
        throw new Error("graph_body");
      body = Buffer.from(payload.bodyBase64, "base64");
      contentType = payload.contentType;
    }
    if (!deps.config || !(await deps.consented())) return { status: 401, url: target, headers: {}, body: "" };
    let bearer: string;
    try {
      bearer = await token({
        forceRefresh: payload.forceRefresh === true,
        ...(method === "PUT" ? {} : {}),
      });
    } catch {
      const current = await load();
      if (current.state === "connected") await save({ state: "expired", reason: "refresh_failed" });
      return { status: 401, url: target, headers: {}, body: "" };
    }
    const response = await doFetch(target, {
      method,
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: payload.binary === true ? "*/*" : "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
        ...(ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {}),
        ...(contentType ? { "Content-Type": contentType } : {}),
      },
      ...(body ? { body: new Uint8Array(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    const headers: Record<string, string> = {};
    for (const key of ["content-type", "retry-after", "etag"])
      if (response.headers.get(key)) headers[key] = response.headers.get(key)!.slice(0, 500);
    if (payload.binary === true) {
      let file = response;
      if (response.status === 302 || response.status === 301 || response.status === 307) {
        const location = response.headers.get("location") ?? "";
        await response.body?.cancel();
        // The pre-authenticated download URL: fetched here with no Authorization header.
        if (!downloadHostAllowed(location)) return { status: 502, url: target, headers, body: "" };
        file = await doFetch(location, { redirect: "manual", ...(signal ? { signal } : {}) });
        if (file.headers.get("etag")) headers.etag = file.headers.get("etag")!.slice(0, 500);
      }
      if (file.status !== 200) {
        await file.body?.cancel();
        return { status: file.status, url: target, headers, body: "" };
      }
      try {
        return { status: 200, url: target, headers, body: (await readLimited(file, DOWNLOAD_MAX_BYTES)).toString("base64") };
      } catch {
        return { status: 413, url: target, headers, body: "" };
      }
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return { status: response.status, url: target, headers, body: "" };
    }
    try {
      const text = (await readLimited(response, JSON_MAX_BYTES)).toString("utf8");
      return { status: response.status, url: target, headers, body: text };
    } catch {
      return { status: 413, url: target, headers, body: "" };
    }
  }
  /** One message's body as text, fetched now for the student and never stored. */
  async function mailBody(messageId: string): Promise<{ contentType: "text"; body: string }> {
    const url = checkedGraphUrl(`${GRAPH_ROOT}/me/messages/${encodeURIComponent(messageId)}?$select=body`);
    const answer = await graphProxy({ url, prefer: 'outlook.body-content-type="text"' });
    const retry = answer.status === 401 ? await graphProxy({ url, prefer: 'outlook.body-content-type="text"', forceRefresh: true }) : answer;
    if (retry.status !== 200) throw new Error("This message could not be opened from Outlook right now.");
    const parsed = JSON.parse(retry.body) as { body?: { content?: unknown } };
    const content = typeof parsed.body?.content === "string" ? parsed.body.content : "";
    return { contentType: "text", body: content.slice(0, 200000) };
  }

  // -------------------------------------------------------------------------------------------
  // Calendar writes, behind the student's click
  // -------------------------------------------------------------------------------------------
  const proposals = new Map<string, CalendarProposal & { used: boolean }>();
  /** Builds a proposal; nothing is written. Its id is main's, random, single-use, ten minutes. */
  function proposeEvent(input: unknown): CalendarProposal {
    const value = input as Record<string, unknown> | null;
    const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);
    const subject = text(value?.subject, 255);
    const start = text(value?.start, 40),
      end = text(value?.end, 40);
    if (!subject || !start || !end) throw new Error("A meeting needs a title, a start and an end.");
    const startMs = Date.parse(start),
      endMs = Date.parse(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || endMs - startMs > 14 * 86400000)
      throw new Error("The meeting's times are not valid.");
    const timeZone = text(value?.timeZone, 60) ?? "UTC";
    const location = text(value?.location, 255);
    const joinRaw = text(value?.joinUrl, 2000);
    let joinUrl: string | undefined;
    if (joinRaw) {
      const url = new URL(joinRaw);
      joinUrl = `${url.origin}${url.pathname}`;
      if (!evidenceUrlSchema.safeParse(joinUrl).success || url.protocol !== "https:") joinUrl = undefined;
    }
    const proposal: CalendarProposal = {
      proposalId: randomUUID(),
      subject,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      timeZone: "UTC",
      ...(location ? { location } : {}),
      ...(joinUrl ? { joinUrl } : {}),
      expiresAt: new Date(now().getTime() + 10 * 60_000).toISOString(),
    };
    void timeZone;
    for (const [id, p] of proposals) if (Date.parse(p.expiresAt) < now().getTime()) proposals.delete(id);
    proposals.set(proposal.proposalId, { ...proposal, used: false });
    return proposal;
  }
  /**
   * Writes the event, only for a proposal this process issued, not expired, not used. Anything
   * else (an id a model made up, a request with no id, a replay) is refused before any network.
   * Calendars.ReadWrite is asked for here, the first time, in Microsoft's window.
   */
  async function createEvent(proposalId: unknown): Promise<{ created: boolean; webLink?: string }> {
    if (typeof proposalId !== "string" || !GUID.test(proposalId))
      throw new Error("Only a proposal you confirmed can be added to your calendar.");
    const proposal = proposals.get(proposalId);
    if (!proposal || proposal.used || Date.parse(proposal.expiresAt) < now().getTime())
      throw new Error("Only a proposal you confirmed can be added to your calendar.");
    const refused = await refuseUnlessReady();
    if (refused) throw new Error("Connect Outlook first.");
    proposal.used = true;
    let current = await load();
    if (!current.scopes.some((s) => s.toLowerCase() === GRAPH_WRITE_SCOPE.toLowerCase())) {
      const granted = await authorize("visible", [GRAPH_WRITE_SCOPE]);
      if (granted === "interaction" || granted.state !== "connected")
        return { created: false };
      current = granted;
    }
    const writeScope =
      current.tokenScopes.find((s) => /calendars.readwrite$/i.test(s)) ?? GRAPH_WRITE_SCOPE;
    const bearer = await token({ scopes: [writeScope] });
    const response = await doFetch(GRAPH_CREATE_EVENT_URL, {
      method: "POST",
      redirect: "manual",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: proposal.subject,
        start: { dateTime: proposal.start.replace(/Z$/, ""), timeZone: "UTC" },
        end: { dateTime: proposal.end.replace(/Z$/, ""), timeZone: "UTC" },
        ...(proposal.location ? { location: { displayName: proposal.location } } : {}),
        ...(proposal.joinUrl ? { body: { contentType: "text", content: `Join: ${proposal.joinUrl}` } } : {}),
      }),
    });
    if (response.status !== 201) {
      await response.body?.cancel();
      return { created: false };
    }
    const created = JSON.parse((await readLimited(response, JSON_MAX_BYTES)).toString("utf8")) as { webLink?: unknown };
    return { created: true, ...(typeof created.webLink === "string" ? { webLink: created.webLink } : {}) };
  }

  return {
    configured: () => Boolean(deps.config),
    /**
     * Silent: at launch nothing is ever shown (`allowVisible` false); after a confirmed UW sign-in
     * Microsoft's window may open once for the first-time consent.
     */
    connectSilently: (options: { allowVisible: boolean }) => single(false, options.allowVisible),
    /** The student's "Connect Outlook": silent, then Microsoft's window. */
    connect: () => single(true),
    status,
    state: load,
    token,
    graphProxy,
    mailBody,
    proposeEvent,
    createEvent,
    disconnect,
    signOut,
    async recordSync(at: string, failures: Record<string, string>) {
      const failed = Object.values(failures);
      if (failed.includes("unauthorized")) await save({ state: "expired", reason: "refresh_failed", lastSyncAt: at });
      else await save({ lastSyncAt: at });
    },
  };
}
export type Outlook = ReturnType<typeof createOutlook>;
