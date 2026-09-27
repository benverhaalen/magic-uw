import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { grantsAccess, handleWebhook, parseSubscriptionEvent, verifySignature } from "../api/lemon-webhook";

const SECRET = "whsec_test_only";
const USER = "7d0c9f3a-2b1e-4c5d-8e9f-0a1b2c3d4e5f";
const ENV = {
  LEMONSQUEEZY_WEBHOOK_SECRET: SECRET,
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
};

function subscription(
  eventName: string,
  extra: { userId?: string | null; status?: string; test?: boolean; id?: string; variant?: number; updated?: string; endsAt?: string | null } = {},
) {
  return {
    meta: {
      event_name: eventName,
      test_mode: extra.test ?? false,
      custom_data: extra.userId === null ? {} : { user_id: extra.userId ?? USER },
    },
    data: {
      type: "subscriptions",
      id: extra.id ?? "501",
      attributes: {
        status: extra.status ?? "active",
        customer_id: 55,
        variant_id: extra.variant ?? 42,
        renews_at: "2026-10-27T12:00:00.000Z",
        ends_at: extra.endsAt ?? null,
        updated_at: extra.updated ?? "2026-09-27T12:00:00.000Z",
        user_email: "student@wisc.edu",
        user_name: "A Student",
        card_last_four: "4242",
      },
    },
  };
}

/** An in-memory stand-in for the two Supabase tables, answering the REST calls the webhook makes. */
function fakeSupabase() {
  const entitlements = new Map<string, Record<string, unknown>>();
  const events = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  let failWrites = false;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    assert.equal((init?.headers as Record<string, string>).apikey, "service-role-test");
    const q = url.searchParams;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const ok = (data: unknown = null) => new Response(data === null ? "" : JSON.stringify(data), { status: 200 });
    if (failWrites && method !== "GET") return new Response("down", { status: 503 });
    if (url.pathname.endsWith("/entitlements")) {
      if (method === "GET") {
        const row = entitlements.get(q.get("user_id")!.replace("eq.", ""));
        return ok(row ? [row] : []);
      }
      if (method === "POST") {
        entitlements.set(body.user_id, { ...entitlements.get(body.user_id), ...body });
        return ok();
      }
    }
    if (url.pathname.endsWith("/lemon_events")) {
      if (method === "GET") {
        const id = q.get("id")!.replace("eq.", "");
        return ok(events.has(id) ? [{ id }] : []);
      }
      if (!events.has(body.id)) events.set(body.id, body);
      return ok();
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { entitlements, events, calls, fetchImpl, setFailWrites: (v: boolean) => (failWrites = v) };
}

function signed(body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  return new Request("https://site.example/api/lemon-webhook", {
    method: "POST",
    headers: { "x-signature": createHmac("sha256", secret).update(raw).digest("hex"), "content-type": "application/json" },
    body: raw,
  });
}

const deliver = async (db: ReturnType<typeof fakeSupabase>, body: unknown, env: Record<string, string> = ENV) =>
  (await (await handleWebhook(signed(body), env, db.fetchImpl)).json()) as { outcome?: string };

test("signature: only the exact body signed with the shared secret is accepted", () => {
  const raw = JSON.stringify(subscription("subscription_created"));
  const sig = createHmac("sha256", SECRET).update(raw).digest("hex");
  assert.equal(verifySignature(raw, sig, SECRET), true);
  assert.equal(verifySignature(raw + " ", sig, SECRET), false);
  assert.equal(verifySignature(raw, sig, "another-secret"), false);
  assert.equal(verifySignature(raw, null, SECRET), false);
  assert.equal(verifySignature(raw, "zz", SECRET), false);
});

test("parsing keeps identifiers, status and dates, and drops the subscriber's name, email and card", () => {
  const event = parseSubscriptionEvent(subscription("subscription_created"))!;
  assert.deepEqual(event, {
    eventName: "subscription_created",
    subscriptionId: "501",
    userId: USER,
    testMode: false,
    status: "active",
    customerId: "55",
    variantId: "42",
    renewsAt: "2026-10-27T12:00:00.000Z",
    endsAt: null,
    updatedAt: "2026-09-27T12:00:00.000Z",
  });
  assert.equal(/student@wisc.edu|A Student|4242/.test(JSON.stringify(event)), false);
  assert.equal(parseSubscriptionEvent(subscription("subscription_created", { userId: "not-a-uuid" }))!.userId, null);
  assert.equal(parseSubscriptionEvent({ meta: {}, data: { type: "orders", id: "1" } }), null);
});

test("access: active, trial and a retrying payment count; a cancelled month runs to its end; tests never count", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  const sub = (status: string, endsAt: string | null = null, testMode = false) => grantsAccess({ status, testMode, endsAt }, now);
  assert.deepEqual(
    [sub("active"), sub("on_trial"), sub("past_due"), sub("cancelled", "2026-10-27T00:00:00Z"), sub("cancelled", "2026-09-30T00:00:00Z")],
    [true, true, true, true, false],
  );
  assert.deepEqual([sub("paused"), sub("unpaid"), sub("expired"), sub("active", null, true)], [false, false, false, false]);
});

test("a new subscription is mirrored once, even when Lemon Squeezy retries the delivery", async () => {
  const db = fakeSupabase();
  assert.deepEqual(await deliver(db, subscription("subscription_created")), { outcome: "applied" });
  const row = db.entitlements.get(USER)!;
  assert.deepEqual(
    { sub: row.lemon_subscription_id, status: row.status, test: row.test_mode, renews: row.renews_at },
    { sub: "501", status: "active", test: false, renews: "2026-10-27T12:00:00.000Z" },
  );
  assert.deepEqual(await deliver(db, subscription("subscription_created")), { outcome: "duplicate" });
  assert.equal(db.events.size, 1);
  assert.equal(/student@wisc.edu|4242/.test(JSON.stringify([...db.events.values(), ...db.entitlements.values()])), false);
});

test("cancelling keeps the end date; a late delivery of an older state can't undo it", async () => {
  const db = fakeSupabase();
  await deliver(db, subscription("subscription_created"));
  const cancel = subscription("subscription_cancelled", { status: "cancelled", endsAt: "2026-10-27T12:00:00.000Z", updated: "2026-09-28T09:00:00.000Z" });
  assert.deepEqual(await deliver(db, cancel), { outcome: "applied" });
  assert.deepEqual([db.entitlements.get(USER)!.status, db.entitlements.get(USER)!.ends_at], ["cancelled", "2026-10-27T12:00:00.000Z"]);
  const late = subscription("subscription_updated", { status: "active", updated: "2026-09-27T12:00:00.000Z" });
  assert.deepEqual(await deliver(db, late), { outcome: "stale" });
  assert.equal(db.entitlements.get(USER)!.status, "cancelled");
  await deliver(db, subscription("subscription_expired", { status: "expired", endsAt: "2026-10-27T12:00:00.000Z", updated: "2026-10-27T12:00:01.000Z" }));
  assert.equal(db.entitlements.get(USER)!.status, "expired");
});

test("a test subscription never replaces a real one that gives access, and a lapsed one is replaced by a new one", async () => {
  const db = fakeSupabase();
  await deliver(db, subscription("subscription_created", { id: "real" }));
  const test = subscription("subscription_created", { id: "t1", test: true, updated: "2026-09-29T00:00:00.000Z" });
  assert.deepEqual(await deliver(db, test), { outcome: "stale" });
  assert.equal(db.entitlements.get(USER)!.lemon_subscription_id, "real");
  await deliver(db, subscription("subscription_expired", { id: "real", status: "expired", updated: "2026-11-01T00:00:00.000Z" }));
  const again = subscription("subscription_created", { id: "second", updated: "2026-11-05T00:00:00.000Z" });
  assert.deepEqual(await deliver(db, again), { outcome: "applied" });
  assert.deepEqual([db.entitlements.get(USER)!.lemon_subscription_id, db.entitlements.get(USER)!.status], ["second", "active"]);
});

test("rejected before any database call: bad signature, missing configuration, wrong method", async () => {
  const db = fakeSupabase();
  assert.equal((await handleWebhook(signed(subscription("subscription_created"), "wrong"), ENV, db.fetchImpl)).status, 401);
  assert.equal((await handleWebhook(signed(subscription("subscription_created")), { ...ENV, SUPABASE_SERVICE_ROLE_KEY: "" }, db.fetchImpl)).status, 503);
  assert.equal((await handleWebhook(new Request("https://site.example/api/lemon-webhook"), ENV, db.fetchImpl)).status, 405);
  assert.deepEqual(db.calls, []);
});

test("a subscription with no account attached is recorded as unlinked, not guessed from its email", async () => {
  const db = fakeSupabase();
  assert.deepEqual(await deliver(db, subscription("subscription_created", { userId: null })), { outcome: "unlinked" });
  assert.equal(db.entitlements.size, 0);
  assert.equal(db.events.get("subscription_created:501:2026-09-27T12:00:00.000Z")!.outcome, "unlinked");
});

test("other products, orders and payment events are ignored; a store outage returns 500 so Lemon Squeezy retries", async () => {
  const db = fakeSupabase();
  assert.deepEqual(await deliver(db, subscription("subscription_created", { variant: 7 }), { ...ENV, LEMONSQUEEZY_VARIANT_ID: "42" }), {
    outcome: "ignored",
  });
  assert.deepEqual(await deliver(db, { meta: { event_name: "order_created" }, data: { type: "orders", id: "1", attributes: {} } }), {
    outcome: "ignored",
  });
  assert.deepEqual(await deliver(db, { ...subscription("subscription_payment_success"), data: { type: "subscription-invoices", id: "9" } }), {
    outcome: "ignored",
  });
  assert.equal(db.entitlements.size, 0);
  db.setFailWrites(true);
  assert.equal((await handleWebhook(signed(subscription("subscription_created", { id: "2002" })), ENV, db.fetchImpl)).status, 500);
  db.setFailWrites(false);
  assert.deepEqual(await deliver(db, subscription("subscription_created", { id: "2002" })), { outcome: "applied" });
});
