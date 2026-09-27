import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handleWebhook, parseOrderEvent, verifySignature } from "../api/lemon-webhook";

const SECRET = "whsec_test_only";
const USER = "7d0c9f3a-2b1e-4c5d-8e9f-0a1b2c3d4e5f";
const ENV = {
  LEMONSQUEEZY_WEBHOOK_SECRET: SECRET,
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
};

function order(eventName: string, extra: { userId?: string | null; status?: string; test?: boolean; id?: string; variant?: number } = {}) {
  return {
    meta: {
      event_name: eventName,
      test_mode: extra.test ?? false,
      custom_data: extra.userId === null ? {} : { user_id: extra.userId ?? USER },
    },
    data: {
      type: "orders",
      id: extra.id ?? "1001",
      attributes: {
        status: extra.status ?? "paid",
        customer_id: 55,
        total: 1000,
        currency: "USD",
        created_at: "2026-09-27T12:00:00.000Z",
        user_email: "student@wisc.edu",
        user_name: "A Student",
        first_order_item: { variant_id: extra.variant ?? 42 },
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
      if (method === "PATCH") {
        const orderId = q.get("lemon_order_id")!.replace("eq.", "");
        for (const row of entitlements.values()) if (row.lemon_order_id === orderId) Object.assign(row, body);
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

test("signature: only the exact body signed with the shared secret is accepted", () => {
  const raw = JSON.stringify(order("order_created"));
  const sig = createHmac("sha256", SECRET).update(raw).digest("hex");
  assert.equal(verifySignature(raw, sig, SECRET), true);
  assert.equal(verifySignature(raw + " ", sig, SECRET), false);
  assert.equal(verifySignature(raw, sig, "another-secret"), false);
  assert.equal(verifySignature(raw, null, SECRET), false);
  assert.equal(verifySignature(raw, "zz", SECRET), false);
});

test("parsing keeps identifiers and amounts, and drops the buyer's name and email", () => {
  const event = parseOrderEvent(order("order_created"))!;
  assert.deepEqual(event, {
    eventName: "order_created",
    orderId: "1001",
    userId: USER,
    testMode: false,
    status: "paid",
    customerId: "55",
    variantId: "42",
    totalCents: 1000,
    currency: "USD",
    createdAt: "2026-09-27T12:00:00.000Z",
  });
  assert.equal(JSON.stringify(event).includes("student@wisc.edu"), false);
  assert.equal(parseOrderEvent(order("order_created", { userId: "not-a-uuid" }))!.userId, null);
  assert.equal(parseOrderEvent({ meta: {}, data: { type: "subscriptions", id: "1" } }), null);
});

test("a paid order marks the account paid, once, even when Lemon Squeezy retries", async () => {
  const db = fakeSupabase();
  const first = await handleWebhook(signed(order("order_created")), ENV, db.fetchImpl);
  assert.deepEqual(await first.json(), { outcome: "applied" });
  assert.deepEqual(
    { status: db.entitlements.get(USER)!.status, test: db.entitlements.get(USER)!.test_mode, order: db.entitlements.get(USER)!.lemon_order_id },
    { status: "paid", test: false, order: "1001" },
  );
  const retry = await handleWebhook(signed(order("order_created")), ENV, db.fetchImpl);
  assert.deepEqual(await retry.json(), { outcome: "duplicate" });
  assert.equal(db.events.size, 1);
  assert.equal(JSON.stringify([...db.events.values()]).includes("student@wisc.edu"), false);
});

test("a refund marks the order refunded, and a late retry of the original order cannot undo it", async () => {
  const db = fakeSupabase();
  await handleWebhook(signed(order("order_created")), ENV, db.fetchImpl);
  const refund = await handleWebhook(signed(order("order_refunded", { status: "refunded" })), ENV, db.fetchImpl);
  assert.deepEqual(await refund.json(), { outcome: "applied" });
  assert.equal(db.entitlements.get(USER)!.status, "refunded");
  db.events.delete("order_created:1001"); // as if the first delivery's record were lost
  await handleWebhook(signed(order("order_created")), ENV, db.fetchImpl);
  assert.equal(db.entitlements.get(USER)!.status, "refunded");
});

test("rejected before any database call: bad signature, missing configuration, wrong method", async () => {
  const db = fakeSupabase();
  assert.equal((await handleWebhook(signed(order("order_created"), "wrong"), ENV, db.fetchImpl)).status, 401);
  assert.equal((await handleWebhook(signed(order("order_created")), { ...ENV, SUPABASE_SERVICE_ROLE_KEY: "" }, db.fetchImpl)).status, 503);
  assert.equal((await handleWebhook(new Request("https://site.example/api/lemon-webhook"), ENV, db.fetchImpl)).status, 405);
  assert.deepEqual(db.calls, []);
});

test("an order with no account attached is recorded as unlinked, not guessed from its email", async () => {
  const db = fakeSupabase();
  const res = await handleWebhook(signed(order("order_created", { userId: null })), ENV, db.fetchImpl);
  assert.deepEqual(await res.json(), { outcome: "unlinked" });
  assert.equal(db.entitlements.size, 0);
  assert.equal(db.events.get("order_created:1001")!.outcome, "unlinked");
});

test("test-mode orders are recorded as tests and never replace a real purchase", async () => {
  const db = fakeSupabase();
  await handleWebhook(signed(order("order_created", { test: true, id: "t1" })), ENV, db.fetchImpl);
  assert.equal(db.entitlements.get(USER)!.test_mode, true);
  await handleWebhook(signed(order("order_created", { id: "r1" })), ENV, db.fetchImpl);
  assert.equal(db.entitlements.get(USER)!.test_mode, false);
  const later = await handleWebhook(signed(order("order_created", { test: true, id: "t2" })), ENV, db.fetchImpl);
  assert.deepEqual(await later.json(), { outcome: "ignored" });
  assert.deepEqual({ order: db.entitlements.get(USER)!.lemon_order_id, test: db.entitlements.get(USER)!.test_mode }, { order: "r1", test: false });
});

test("other products and other events are ignored; a store outage returns 500 so Lemon Squeezy retries", async () => {
  const db = fakeSupabase();
  const other = await handleWebhook(signed(order("order_created", { variant: 7 })), { ...ENV, LEMONSQUEEZY_VARIANT_ID: "42" }, db.fetchImpl);
  assert.deepEqual(await other.json(), { outcome: "ignored" });
  const sub = await handleWebhook(signed(order("subscription_created", { id: "9" })), ENV, db.fetchImpl);
  assert.deepEqual(await sub.json(), { outcome: "ignored" });
  assert.equal(db.entitlements.size, 0);
  db.setFailWrites(true);
  const down = await handleWebhook(signed(order("order_created", { id: "2002" })), ENV, db.fetchImpl);
  assert.equal(down.status, 500);
  db.setFailWrites(false);
  const retried = await handleWebhook(signed(order("order_created", { id: "2002" })), ENV, db.fetchImpl);
  assert.deepEqual(await retried.json(), { outcome: "applied" });
});
