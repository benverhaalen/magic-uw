import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccount, OFFLINE_GRACE_MS } from "../apps/desktop/src/account";

const CONFIG = { url: "https://proj.supabase.co", anonKey: "sb_publishable_test", accountUrl: "https://magic-uw-omega.vercel.app/account/" };

function memoryVault() {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key),
    set: async (key: string, value: string) => void values.set(key, value),
    deletePrefix: async (prefix: string) => {
      for (const key of [...values.keys()]) if (key.startsWith(prefix)) values.delete(key);
    },
  };
}

/** A stand-in for Supabase Auth and the entitlements table. */
function fakeServer(options: { entitlement?: { status: string; test_mode: boolean } | null } = {}) {
  const state = {
    offline: false,
    entitlement: options.entitlement === undefined ? null : options.entitlement,
    refreshRejected: false,
    requests: [] as { path: string; auth?: string; body?: Record<string, unknown> }[],
    issued: 0,
  };
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    if (state.offline) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.apikey, CONFIG.anonKey, "only the public key is ever sent");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    state.requests.push({ path: url.pathname + url.search, auth: headers.Authorization, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    const session = () => {
      state.issued++;
      return json(200, { access_token: `access-${state.issued}`, refresh_token: `refresh-${state.issued}`, expires_in: 3600, user: { email: "student@wisc.edu" } });
    };
    if (url.pathname === "/auth/v1/otp") return json(200, {});
    if (url.pathname === "/auth/v1/verify") return body?.token === "123456" ? session() : json(403, { error_code: "otp_expired" });
    if (url.pathname === "/auth/v1/token") return state.refreshRejected ? json(400, { error_code: "refresh_token_not_found" }) : session();
    if (url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    if (url.pathname === "/rest/v1/entitlements") {
      if (!headers.Authorization?.startsWith("Bearer access-")) return json(401, {});
      return json(200, state.entitlement ? [state.entitlement] : []);
    }
    return json(404, {});
  }) as typeof fetch;
  return { state, fetchImpl };
}

async function signedIn(options: Parameters<typeof fakeServer>[0] = {}, now = () => 1_800_000_000_000) {
  const server = fakeServer(options);
  const vault = memoryVault();
  const account = createAccount(CONFIG, { vault, fetch: server.fetchImpl, now });
  assert.deepEqual(await account.sendCode("student@wisc.edu"), { sent: true });
  assert.deepEqual(await account.verifyCode("student@wisc.edu", "123 456"), { signedIn: true });
  return { server, vault, account };
}

test("without a Supabase URL and key, accounts are off and nothing is contacted", async () => {
  const server = fakeServer();
  const account = createAccount({}, { vault: memoryVault(), fetch: server.fetchImpl });
  assert.deepEqual(await account.status(), { state: "unconfigured" });
  assert.deepEqual(await account.sendCode("student@wisc.edu"), { sent: false, reason: "unavailable" });
  assert.equal(server.state.requests.length, 0);
});

test("signing in with an emailed code keeps only the refresh token, in the vault", async () => {
  const { vault, server } = await signedIn();
  assert.equal(vault.values.get("account:refresh"), "refresh-1");
  assert.equal(vault.values.get("account:email"), "student@wisc.edu");
  assert.equal([...vault.values.values()].some((v) => v.startsWith("access-")), false, "access tokens stay in memory");
  assert.deepEqual(server.state.requests[1]!.body, { type: "email", email: "student@wisc.edu", token: "123456" });
});

test("bad input never reaches the server; a wrong code is reported as such", async () => {
  const server = fakeServer();
  const account = createAccount(CONFIG, { vault: memoryVault(), fetch: server.fetchImpl });
  assert.deepEqual(await account.sendCode("not an email"), { sent: false, reason: "invalid" });
  assert.deepEqual(await account.verifyCode("student@wisc.edu", "12ab"), { signedIn: false, reason: "invalid" });
  assert.equal(server.state.requests.length, 0);
  assert.deepEqual(await account.verifyCode("student@wisc.edu", "999999"), { signedIn: false, reason: "wrong-code" });
});

test("status reads the account's own entitlement: paid, not bought, refunded, test only", async () => {
  for (const [entitlement, purchase, entitled] of [
    [{ status: "paid", test_mode: false }, "paid", true],
    [null, "not-bought", false],
    [{ status: "refunded", test_mode: false }, "refunded", false],
    [{ status: "paid", test_mode: true }, "test-only", false],
  ] as const) {
    const { account } = await signedIn({ entitlement });
    const status = await account.status();
    assert.equal(status.state, "signed-in");
    assert.deepEqual(status.state === "signed-in" && { purchase: status.purchase, entitled: status.entitled, offline: status.offline }, { purchase, entitled, offline: false });
  }
});

test("offline, a confirmed purchase keeps counting for the grace period, then becomes unknown", async () => {
  let clock = 1_800_000_000_000;
  const { account, server } = await signedIn({ entitlement: { status: "paid", test_mode: false } }, () => clock);
  assert.equal((await account.status()).state, "signed-in");
  server.state.offline = true;
  clock += OFFLINE_GRACE_MS - 60_000;
  const within = await account.status();
  assert.deepEqual(within.state === "signed-in" && { purchase: within.purchase, entitled: within.entitled, offline: within.offline }, { purchase: "paid", entitled: true, offline: true });
  clock += 120_000;
  const after = await account.status();
  assert.deepEqual(after.state === "signed-in" && { purchase: after.purchase, entitled: after.entitled }, { purchase: "unknown", entitled: false });
});

test("an expired access token is refreshed with the stored refresh token, which rotates", async () => {
  let clock = 1_800_000_000_000;
  const { account, vault, server } = await signedIn({ entitlement: { status: "paid", test_mode: false } }, () => clock);
  clock += 2 * 60 * 60 * 1000;
  await account.status();
  assert.ok(server.state.requests.some((r) => r.path.startsWith("/auth/v1/token") && r.body?.refresh_token === "refresh-1"));
  assert.equal(vault.values.get("account:refresh"), "refresh-2");
});

test("a sign-in the server no longer accepts is forgotten; sign-out clears everything", async () => {
  let clock = 1_800_000_000_000;
  const first = await signedIn({}, () => clock);
  first.server.state.refreshRejected = true;
  clock += 2 * 60 * 60 * 1000;
  assert.deepEqual(await first.account.status(), { state: "signed-out" });
  assert.equal([...first.vault.values.keys()].some((k) => k.startsWith("account:")), false);

  const second = await signedIn({ entitlement: { status: "paid", test_mode: false } });
  await second.account.status();
  await second.account.signOut();
  assert.ok(second.server.state.requests.some((r) => r.path.startsWith("/auth/v1/logout")));
  assert.equal(second.vault.values.size, 0);
  assert.deepEqual(await second.account.status(), { state: "signed-out" });
});

test("the buy link is the website's account page, https only", () => {
  const vault = memoryVault();
  assert.equal(createAccount(CONFIG, { vault }).buyUrl(), "https://magic-uw-omega.vercel.app/account/?buy=1");
  assert.equal(createAccount({ ...CONFIG, accountUrl: "http://insecure.example/account/" }, { vault }).buyUrl(), null);
});
