/**
 * T30: the app's own Microsoft sign-in, in main. Real @azure/msal-node against a fake token
 * endpoint (its network client), a fake window, a fake Graph and an in-memory file store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { INetworkModule, NetworkRequestOptions, NetworkResponse } from "@azure/msal-node";
import {
  classifyAuthorizeError,
  createOutlook,
  parseRedirect,
  readOutlookConfig,
  type AuthWindow,
  type AuthorizeOutcome,
  type Encryptor,
  type FileStore,
} from "../apps/desktop/src/outlook";
import { GRAPH_READ_SCOPES } from "../packages/connectors/src/graph";

const CLIENT = "11111111-2222-3333-4444-555555555555";
const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OID = "99999999-8888-7777-6666-555555555555";
const AUTHORITY = "https://login.microsoftonline.com/organizations";
const authOptions = {
  knownAuthorities: ["login.microsoftonline.com"],
  authorityMetadata: JSON.stringify({
    token_endpoint: `${AUTHORITY}/oauth2/v2.0/token`,
    authorization_endpoint: `${AUTHORITY}/oauth2/v2.0/authorize`,
    end_session_endpoint: `${AUTHORITY}/oauth2/v2.0/logout`,
    issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
    jwks_uri: `${AUTHORITY}/discovery/v2.0/keys`,
  }),
  cloudDiscoveryMetadata: JSON.stringify({
    tenant_discovery_endpoint: `${AUTHORITY}/v2.0/.well-known/openid-configuration`,
    "api-version": "1.1",
    metadata: [
      {
        preferred_network: "login.microsoftonline.com",
        preferred_cache: "login.windows.net",
        aliases: ["login.microsoftonline.com", "login.windows.net", "login.microsoft.com", "sts.windows.net"],
      },
    ],
  }),
};
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function idToken() {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url({ alg: "none", typ: "JWT" }),
    b64url({
      aud: CLIENT, iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, iat: now, nbf: now, exp: now + 3600,
      oid: OID, tid: TENANT, sub: "sub", preferred_username: "student@wisc.edu", name: "A Student", ver: "2.0",
    }),
    "sig",
  ].join(".");
}
/** The token endpoint: a code grant, then refresh grants. Counts every call. */
function fakeTokenEndpoint(options: { grantedScopes?: string } = {}) {
  const posts: string[] = [];
  let n = 0;
  const network: INetworkModule = {
    async sendGetRequestAsync<T>(url: string): Promise<NetworkResponse<T>> {
      throw new Error(`unexpected GET ${url}`);
    },
    async sendPostRequestAsync<T>(url: string, request?: NetworkRequestOptions): Promise<NetworkResponse<T>> {
      assert.equal(url.split("?")[0], `${AUTHORITY}/oauth2/v2.0/token`);
      const body = String(request?.body ?? "");
      posts.push(body);
      n++;
      return {
        status: 200,
        headers: {},
        body: {
          token_type: "Bearer",
          scope: options.grantedScopes ?? "https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Files.Read https://graph.microsoft.com/Notes.Read https://graph.microsoft.com/Files.ReadWrite.AppFolder",
          expires_in: 3600,
          ext_expires_in: 3600,
          access_token: `ACCESS-TOKEN-${n}`,
          refresh_token: `REFRESH-TOKEN-${n}`,
          id_token: idToken(),
          client_info: b64url({ uid: OID, utid: TENANT }),
        } as T,
      };
    },
  };
  return { network, posts };
}
/** A visible marker proves the file went through the encryptor (safeStorage in the app). */
const encryptor: Encryptor = {
  available: () => true,
  encrypt: (value) => Buffer.concat([Buffer.from("ENC1:"), Buffer.from(value, "utf8").map((b) => b ^ 0x5a)]),
  decrypt: (value) => {
    assert.equal(value.subarray(0, 5).toString(), "ENC1:");
    return Buffer.from(value.subarray(5).map((b) => b ^ 0x5a)).toString("utf8");
  },
};
function memoryFiles(): FileStore & { data: Map<string, Buffer> } {
  const data = new Map<string, Buffer>();
  return {
    data,
    async read(path) {
      return data.get(path) ?? null;
    },
    async write(path, value) {
      data.set(path, Buffer.from(value));
    },
    async remove(path) {
      data.delete(path);
    },
  };
}
function scriptedWindow(script: ((url: string, mode: "silent" | "visible") => AuthorizeOutcome)[]) {
  const runs: { url: string; mode: "silent" | "visible" }[] = [];
  const window: AuthWindow = {
    async run(url, mode) {
      runs.push({ url, mode });
      const step = script.shift();
      if (!step) throw new Error("the window was not expected to open again");
      return step(url, mode);
    },
  };
  return { window, runs };
}
const stateOf = (url: string) => new URL(url).searchParams.get("state") ?? "";
const refuseFetch: typeof fetch = async () => {
  throw new Error("no network in this test");
};

test("no client ID configured: 'not set up', and no window, token or network call", async () => {
  assert.equal(await readOutlookConfig({}, async () => null), null);
  assert.equal(await readOutlookConfig({ MAGIC_MS_CLIENT_ID: "not-a-guid" }, async () => null), null);
  assert.deepEqual(await readOutlookConfig({}, async () => JSON.stringify({ clientId: CLIENT })), {
    clientId: CLIENT,
    authority: "https://login.microsoftonline.com/organizations",
  });
  assert.equal((await readOutlookConfig({ MAGIC_MS_CLIENT_ID: CLIENT, MAGIC_MS_TENANT: "wisc.edu" }, async () => null))!.authority, "https://login.microsoftonline.com/wisc.edu");
  let fetched = 0;
  const { window, runs } = scriptedWindow([]);
  const outlook = createOutlook({
    config: null, cachePath: "cache", statePath: "state", encryptor, files: memoryFiles(), window,
    consented: async () => true,
    fetch: (async () => { fetched++; throw new Error(); }) as typeof fetch,
  });
  assert.equal((await outlook.connectSilently({ allowVisible: true })).state, "not_set_up");
  assert.equal((await outlook.connect()).state, "not_set_up");
  assert.equal((await outlook.status()).outlook, "not_set_up");
  const proxied = await outlook.graphProxy({ url: "https://graph.microsoft.com/v1.0/me/calendarView/delta" });
  assert.equal(proxied.status, 401);
  assert.equal(runs.length, 0);
  assert.equal(fetched, 0);
});

test("silent first: the cache, then prompt=none in the hidden window; Microsoft's window once, then the encrypted cache renews silently", async () => {
  const token = fakeTokenEndpoint();
  const files = memoryFiles();
  const { window, runs } = scriptedWindow([
    () => ({ kind: "error", error: "interaction_required", description: "AADSTS65001: The user or administrator has not consented", state: stateOf(runs[0]!.url) }),
    (url) => ({ kind: "code", code: "CODE-1", state: stateOf(url) }),
  ]);
  const outlook = createOutlook({
    config: { clientId: CLIENT, authority: AUTHORITY }, cachePath: "cache", statePath: "state", encryptor, files, window,
    consented: async () => true, networkClient: token.network, authOptions, fetch: refuseFetch,
  });
  const connected = await outlook.connectSilently({ allowVisible: true });
  assert.equal(connected.state, "connected");
  assert.deepEqual(runs.map((r) => r.mode), ["silent", "visible"]);
  const silent = new URL(runs[0]!.url);
  assert.equal(silent.searchParams.get("prompt"), "none");
  assert.equal(silent.searchParams.get("domain_hint"), "wisc.edu");
  assert.equal(silent.searchParams.get("code_challenge_method"), "S256");
  assert.equal(silent.searchParams.get("redirect_uri"), "http://localhost");
  assert.equal(silent.searchParams.get("client_id"), CLIENT);
  for (const scope of GRAPH_READ_SCOPES) assert.match(silent.searchParams.get("scope")!, new RegExp(scope.replace(".", "\\.")));
  assert.equal(new URL(runs[1]!.url).searchParams.get("prompt"), null, "the visible round lets Microsoft show consent");
  assert.match(token.posts[0]!, /grant_type=authorization_code/);
  assert.match(token.posts[0]!, /code_verifier=/);
  assert.doesNotMatch(token.posts[0]!, /client_secret/, "a public client: no secret");
  // The cache on disk is only ever the encryptor's output.
  const cache = files.data.get("cache")!;
  assert.equal(cache.subarray(0, 5).toString(), "ENC1:");
  assert.equal(cache.includes(Buffer.from("REFRESH-TOKEN-1")), false);
  assert.equal(cache.includes(Buffer.from("ACCESS-TOKEN-1")), false);
  assert.equal(files.data.get("state")!.includes(Buffer.from("TOKEN")), false, "the state file holds no token");
  // A restart: a new instance reads the encrypted cache; the token comes back with no network.
  const restarted = createOutlook({
    config: { clientId: CLIENT, authority: AUTHORITY }, cachePath: "cache", statePath: "state", encryptor, files,
    window: scriptedWindow([]).window, consented: async () => true, networkClient: token.network, authOptions, fetch: refuseFetch,
  });
  const posts = token.posts.length;
  assert.equal(await restarted.token(), "ACCESS-TOKEN-1");
  assert.equal(token.posts.length, posts, "served from the cache");
  assert.equal((await restarted.connectSilently({ allowVisible: true })).state, "connected");
  assert.equal(await restarted.token({ forceRefresh: true }), "ACCESS-TOKEN-2");
  assert.match(token.posts.at(-1)!, /grant_type=refresh_token/);
  const status = await restarted.status({ messages: 3, events: 2 });
  assert.equal(status.outlook, "connected");
  assert.deepEqual(status.counts, { messages: 3, events: 2 });
  assert.ok(status.scopes.includes("Mail.Read") && status.scopes.includes("Notes.Read"));
  assert.equal(status.canWriteCalendar, false);
});

test("the worker never sees a token: the proxy attaches it and returns status, headers and body only", async () => {
  const token = fakeTokenEndpoint();
  const files = memoryFiles();
  const { window, runs } = scriptedWindow([(url) => ({ kind: "code", code: "C", state: stateOf(url) })]);
  const seen: { url: string; auth: string | null }[] = [];
  const graphFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(input), auth: headers.get("authorization") });
    return new Response(JSON.stringify({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=x" }), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": "x=y", "x-ms-ags-diagnostic": "z" },
    });
  }) as typeof fetch;
  const outlook = createOutlook({
    config: { clientId: CLIENT, authority: AUTHORITY }, cachePath: "cache", statePath: "state", encryptor, files, window,
    consented: async () => true, networkClient: token.network, authOptions, fetch: graphFetch,
  });
  await outlook.connectSilently({ allowVisible: true });
  assert.equal(runs.length, 1);
  const answer = await outlook.graphProxy({ url: "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=a", prefer: "odata.maxpagesize=100" });
  assert.equal(seen[0]!.auth, "Bearer ACCESS-TOKEN-1");
  assert.equal(JSON.stringify(answer).includes("ACCESS-TOKEN"), false);
  assert.equal(JSON.stringify(answer).includes("REFRESH-TOKEN"), false);
  assert.deepEqual(Object.keys(answer).sort(), ["body", "headers", "status", "url"]);
  assert.deepEqual(Object.keys(answer.headers), ["content-type"]);
  // Anything off the allowlist is refused before a token is even read.
  await assert.rejects(outlook.graphProxy({ url: "https://graph.microsoft.com/v1.0/me/sendMail" }));
  await assert.rejects(outlook.graphProxy({ url: "https://graph.microsoft.com/v1.0/me/events", method: "POST" }));
  await assert.rejects(outlook.graphProxy({ url: "https://graph.microsoft.com/v1.0/me/messages/x", prefer: "return=representation" }));
  assert.equal(seen.length, 1);
});

test("UW blocks consent: 'needs UW approval', and nothing re-prompts or retries on its own", async () => {
  const files = memoryFiles();
  const token = fakeTokenEndpoint();
  const { window, runs } = scriptedWindow([
    (url) => ({ kind: "error", error: "consent_required", description: "AADSTS65001: no consent", state: stateOf(url) }),
    (url) => ({ kind: "error", error: "access_denied", description: "AADSTS90094: Admin consent is required for the permissions requested by this application.", state: stateOf(url) }),
  ]);
  const outlook = createOutlook({
    config: { clientId: CLIENT, authority: AUTHORITY }, cachePath: "cache", statePath: "state", encryptor, files, window,
    consented: async () => true, networkClient: token.network, authOptions, fetch: refuseFetch,
  });
  const blocked = await outlook.connectSilently({ allowVisible: true });
  assert.equal(blocked.state, "needs_uw_approval");
  assert.equal(blocked.reason, "AADSTS90094");
  const status = await outlook.status();
  assert.equal(status.outlook, "needs_uw_approval");
  assert.equal(status.approvalRequest, "not_sent");
  // Launch and later sign-ins: no window, no request, no loop.
  for (let i = 0; i < 3; i++) assert.equal((await outlook.connectSilently({ allowVisible: true })).state, "needs_uw_approval");
  assert.equal(runs.length, 2);
  assert.equal(token.posts.length, 0);
});

test("the approval-request form (AADSTS90095) is 'needs UW approval, request unknown'; a manual Connect tries once more", async () => {
  const { window, runs } = scriptedWindow([
    (url) => ({ kind: "error", error: "interaction_required", description: "", state: stateOf(url) }),
    (url) => ({ kind: "error", error: "access_denied", description: "AADSTS90095: Admin consent required, request access", state: stateOf(url) }),
    (url) => ({ kind: "error", error: "interaction_required", description: "", state: stateOf(url) }),
    () => ({ kind: "closed" }),
  ]);
  const outlook = createOutlook({
    config: { clientId: CLIENT, authority: AUTHORITY }, cachePath: "cache", statePath: "state", encryptor, files: memoryFiles(), window,
    consented: async () => true, networkClient: fakeTokenEndpoint().network, authOptions, fetch: refuseFetch,
  });
  await outlook.connectSilently({ allowVisible: true });
  assert.equal((await outlook.status()).approvalRequest, "unknown");
  const manual = await outlook.connect();
  assert.equal(manual.state, "needs_uw_approval", "closing Microsoft's window keeps the known block");
  assert.equal(runs.length, 4, "one silent and one visible round per attempt, never more");
});

test("launch is silent only; Microsoft's window opens on its own at most once, after a UW sign-in", async () => {
  const interaction = (url: string): AuthorizeOutcome => ({ kind: "error", error: "login_required", description: "", state: stateOf(url) });
  const { window, runs } = scriptedWindow([interaction, interaction, () => ({ kind: "closed" }), interaction]);
  const outlook = createOutlook({
    config: { clientId: CLIENT, authority: AUTHORITY }, cachePath: "cache", statePath: "state", encryptor, files: memoryFiles(), window,
    consented: async () => true, networkClient: fakeTokenEndpoint().network, authOptions, fetch: refuseFetch,
  });
  assert.equal((await outlook.connectSilently({ allowVisible: false })).state, "not_connected");
  assert.deepEqual(runs.map((r) => r.mode), ["silent"]);
  await outlook.connectSilently({ allowVisible: true });
  assert.deepEqual(runs.map((r) => r.mode), ["silent", "silent", "visible"]);
  await outlook.connectSilently({ allowVisible: true });
  assert.deepEqual(runs.map((r) => r.mode), ["silent", "silent", "visible", "silent"], "not shown again on its own");
});

test("without the setup agreement nothing runs", async () => {
  const { window, runs } = scriptedWindow([]);
  const outlook = createOutlook({
    config: { clientId: CLIENT, authority: AUTHORITY }, cachePath: "cache", statePath: "state", encryptor, files: memoryFiles(), window,
    consented: async () => false, networkClient: fakeTokenEndpoint().network, authOptions, fetch: refuseFetch,
  });
  assert.equal((await outlook.connect()).reason, "setup_consent_required");
  assert.equal((await outlook.graphProxy({ url: "https://graph.microsoft.com/v1.0/me/calendarView/delta" })).status, 401);
  assert.equal(runs.length, 0);
});

test("partial grant: only the scopes Microsoft returned are recorded and used", async () => {
  const token = fakeTokenEndpoint({ grantedScopes: "https://graph.microsoft.com/User.Read https://graph.microsoft.com/Notes.Read https://graph.microsoft.com/Files.Read" });
  const { window } = scriptedWindow([(url) => ({ kind: "code", code: "C", state: stateOf(url) })]);
  const outlook = createOutlook({
    config: { clientId: CLIENT, authority: AUTHORITY }, cachePath: "cache", statePath: "state", encryptor, files: memoryFiles(), window,
    consented: async () => true, networkClient: token.network, authOptions, fetch: refuseFetch,
  });
  const state = await outlook.connectSilently({ allowVisible: true });
  assert.deepEqual([...state.scopes].sort(), ["Files.Read", "Notes.Read", "User.Read"]);
});

test("calendar writes: a request without a proposal main issued (a model's) is refused before any network", async () => {
  let fetched = 0;
  const { window, runs } = scriptedWindow([]);
  const outlook = createOutlook({
    config: { clientId: CLIENT, authority: AUTHORITY }, cachePath: "cache", statePath: "state", encryptor, files: memoryFiles(), window,
    consented: async () => true, networkClient: fakeTokenEndpoint().network, authOptions,
    fetch: (async () => { fetched++; throw new Error(); }) as typeof fetch,
  });
  const modelRequest = { subject: "Study group", start: "2026-09-28T15:00:00Z", end: "2026-09-28T16:00:00Z" };
  await assert.rejects(outlook.createEvent(modelRequest), /Only a proposal you confirmed/);
  await assert.rejects(outlook.createEvent("123e4567-e89b-12d3-a456-426614174000"), /Only a proposal you confirmed/);
  await assert.rejects(outlook.createEvent(undefined), /Only a proposal you confirmed/);
  const proposal = outlook.proposeEvent({ ...modelRequest, joinUrl: "https://zoom.us/j/123?pwd=secret" });
  assert.equal(proposal.joinUrl, "https://zoom.us/j/123");
  assert.match(proposal.proposalId, /^[0-9a-f-]{36}$/);
  assert.equal(fetched, 0);
  assert.equal(runs.length, 0);
  assert.throws(() => outlook.proposeEvent({ subject: "x", start: "2026-09-28T16:00:00Z", end: "2026-09-28T15:00:00Z" }));
});

test("redirects and Microsoft's error codes are read in code", () => {
  assert.deepEqual(parseRedirect("http://localhost/?code=abc&state=s1"), { kind: "code", code: "abc", state: "s1" });
  assert.deepEqual(parseRedirect("http://localhost:5173/?error=access_denied&error_description=AADSTS65004%3A+declined&state=s"), {
    kind: "error", error: "access_denied", description: "AADSTS65004: declined", state: "s",
  });
  assert.equal(parseRedirect("https://evil.example.com/?code=x"), undefined);
  assert.equal(classifyAuthorizeError("interaction_required", "", "silent").kind, "interaction");
  assert.equal(classifyAuthorizeError("invalid_request", "AADSTS65001: x", "silent").kind, "interaction");
  assert.equal(classifyAuthorizeError("invalid_request", "AADSTS65001: x", "visible").kind, "needs_uw_approval");
  assert.equal(classifyAuthorizeError("access_denied", "AADSTS90094: admin", "visible").kind, "needs_uw_approval");
  assert.equal(classifyAuthorizeError("access_denied", "AADSTS65004: declined", "visible").kind, "declined");
});
