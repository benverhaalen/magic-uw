// Lemon Squeezy → Supabase: mirrors each account's $5-a-month subscription.
// Deployed by Vercel as POST /api/lemon-webhook. Self-contained (no relative imports, no
// packages) so it runs without an install step. See docs/accounts-and-payments.md.
//
// Server-only environment: LEMONSQUEEZY_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Optional: LEMONSQUEEZY_VARIANT_ID limits which product counts as the app.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookEnv {
  LEMONSQUEEZY_WEBHOOK_SECRET?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  LEMONSQUEEZY_VARIANT_ID?: string;
}

type Fetch = typeof fetch;
type Outcome = "applied" | "unlinked" | "ignored" | "stale" | "duplicate";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Every event that carries the subscription's full current state. Payment events carry
// invoices instead; the status change they cause also arrives as subscription_updated.
const HANDLED = new Set([
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_resumed",
  "subscription_expired",
  "subscription_paused",
  "subscription_unpaused",
]);
const STATUSES = new Set(["on_trial", "active", "past_due", "paused", "unpaid", "cancelled", "expired"]);

/** Lemon Squeezy signs the raw body with HMAC-SHA256 and sends the hex digest in X-Signature. */
export function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Whether a subscription gives the app right now. Same rule as the subscription_access view in
 * supabase/migrations/20260927160000_monthly_subscription.sql: a failed renewal keeps access
 * while Lemon Squeezy retries, and a cancelled subscription runs to the end of its paid month.
 */
export function grantsAccess(sub: { status: string; testMode: boolean; endsAt: string | null }, now: number): boolean {
  if (sub.testMode) return false;
  if (sub.status === "on_trial" || sub.status === "active" || sub.status === "past_due") return true;
  return sub.status === "cancelled" && sub.endsAt !== null && Date.parse(sub.endsAt) > now;
}

export interface SubscriptionEvent {
  eventName: string;
  subscriptionId: string;
  userId: string | null;
  testMode: boolean;
  status: string;
  customerId: string | null;
  variantId: string | null;
  renewsAt: string | null;
  endsAt: string | null;
  updatedAt: string | null;
}

/** Reads only the fields we store; the subscriber's name, email and card are ignored. */
export function parseSubscriptionEvent(body: unknown): SubscriptionEvent | null {
  if (!body || typeof body !== "object") return null;
  const { meta, data } = body as { meta?: Record<string, unknown>; data?: Record<string, unknown> };
  const eventName = typeof meta?.event_name === "string" ? meta.event_name : "";
  if (!data || data.type !== "subscriptions" || (typeof data.id !== "string" && typeof data.id !== "number")) return null;
  const attrs = (data.attributes ?? {}) as Record<string, unknown>;
  const custom = (meta?.custom_data ?? {}) as Record<string, unknown>;
  const userId = typeof custom.user_id === "string" && UUID.test(custom.user_id) ? custom.user_id.toLowerCase() : null;
  const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : null);
  const time = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
  return {
    eventName,
    subscriptionId: String(data.id),
    userId,
    testMode: Boolean(meta?.test_mode ?? attrs.test_mode),
    status: typeof attrs.status === "string" ? attrs.status : "",
    customerId: str(attrs.customer_id),
    variantId: str(attrs.variant_id),
    renewsAt: time(attrs.renews_at),
    endsAt: time(attrs.ends_at),
    updatedAt: time(attrs.updated_at),
  };
}

function rest(env: Required<Pick<WebhookEnv, "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY">>, fetchImpl: Fetch) {
  const base = `${env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1`;
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  async function call(path: string, init: RequestInit & { prefer?: string } = {}) {
    const { prefer, ...rest } = init;
    const response = await fetchImpl(`${base}${path}`, {
      ...rest,
      headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) },
    });
    if (!response.ok) throw new Error(`Supabase ${response.status} on ${path.split("?")[0]}`);
    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : null;
  }
  return {
    entitlementFor: async (userId: string) =>
      ((await call(
        `/entitlements?user_id=eq.${userId}&select=lemon_subscription_id,status,test_mode,ends_at,lemon_updated_at`,
      )) as { lemon_subscription_id: string; status: string; test_mode: boolean; ends_at: string | null; lemon_updated_at: string }[])[0] ??
      null,
    upsertEntitlement: (row: Record<string, unknown>) =>
      call(`/entitlements?on_conflict=user_id`, {
        method: "POST",
        body: JSON.stringify(row),
        prefer: "resolution=merge-duplicates,return=minimal",
      }),
    seen: async (id: string) =>
      ((await call(`/lemon_events?id=eq.${encodeURIComponent(id)}&select=id`)) as unknown[]).length > 0,
    record: (row: Record<string, unknown>) =>
      call(`/lemon_events?on_conflict=id`, {
        method: "POST",
        body: JSON.stringify(row),
        prefer: "resolution=ignore-duplicates,return=minimal",
      }),
  };
}

/**
 * Applies one verified event. The row always holds the subscription's latest known state, so a
 * retried or out-of-order delivery can't move it backwards. When an account has two
 * subscriptions (a new one after the old ended, or a test beside a real one), the one that gives
 * access wins, then the more recently updated.
 */
export async function applyEvent(event: SubscriptionEvent, env: WebhookEnv, fetchImpl: Fetch, now = Date.now()): Promise<Outcome> {
  const db = rest(env as Required<Pick<WebhookEnv, "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY">>, fetchImpl);
  const id = `${event.eventName}:${event.subscriptionId}:${event.updatedAt ?? ""}`;
  if (await db.seen(id)) return "duplicate";
  let outcome: Outcome;
  if (!HANDLED.has(event.eventName) || !STATUSES.has(event.status) || !event.updatedAt) outcome = "ignored";
  else if (env.LEMONSQUEEZY_VARIANT_ID && event.variantId && event.variantId !== env.LEMONSQUEEZY_VARIANT_ID)
    outcome = "ignored";
  else if (!event.userId) outcome = "unlinked";
  else {
    const current = await db.entitlementFor(event.userId);
    const newer = !current || Date.parse(event.updatedAt) >= Date.parse(current.lemon_updated_at);
    let keep = false;
    if (current && current.lemon_subscription_id === event.subscriptionId) keep = !newer;
    else if (current) {
      const incoming = grantsAccess(event, now);
      const existing = grantsAccess({ status: current.status, testMode: current.test_mode, endsAt: current.ends_at }, now);
      keep = existing && !incoming ? true : existing === incoming ? !newer : false;
    }
    if (keep) outcome = "stale";
    else {
      await db.upsertEntitlement({
        user_id: event.userId,
        lemon_subscription_id: event.subscriptionId,
        status: event.status,
        test_mode: event.testMode,
        lemon_customer_id: event.customerId,
        variant_id: event.variantId,
        renews_at: event.renewsAt,
        ends_at: event.endsAt,
        lemon_updated_at: event.updatedAt,
        updated_at: new Date(now).toISOString(),
      });
      outcome = "applied";
    }
  }
  await db.record({
    id,
    event_name: event.eventName || "unknown",
    lemon_id: event.subscriptionId,
    user_id: event.userId,
    test_mode: event.testMode,
    outcome,
  });
  return outcome;
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function handleWebhook(request: Request, env: WebhookEnv, fetchImpl: Fetch): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!env.LEMONSQUEEZY_WEBHOOK_SECRET || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)
    return json(503, { error: "not_configured" });
  const raw = await request.text();
  if (raw.length > 256_000) return json(413, { error: "too_large" });
  if (!verifySignature(raw, request.headers.get("x-signature"), env.LEMONSQUEEZY_WEBHOOK_SECRET))
    return json(401, { error: "bad_signature" });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "bad_json" });
  }
  const event = parseSubscriptionEvent(body);
  if (!event) return json(200, { outcome: "ignored" });
  try {
    return json(200, { outcome: await applyEvent(event, env, fetchImpl) });
  } catch {
    // Lemon Squeezy retries non-2xx responses, so a Supabase outage is recovered automatically.
    return json(500, { error: "store_failed" });
  }
}

export function POST(request: Request): Promise<Response> {
  return handleWebhook(request, process.env as WebhookEnv, fetch);
}
