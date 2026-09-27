// Lemon Squeezy → Supabase: records whether an account has paid for the app.
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
type Outcome = "applied" | "unlinked" | "ignored" | "duplicate";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLED = new Set(["order_created", "order_refunded"]);

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

export interface OrderEvent {
  eventName: string;
  orderId: string;
  userId: string | null;
  testMode: boolean;
  status: string;
  customerId: string | null;
  variantId: string | null;
  totalCents: number | null;
  currency: string | null;
  createdAt: string | null;
}

/** Reads only the fields we store; names, emails and addresses in the order are ignored. */
export function parseOrderEvent(body: unknown): OrderEvent | null {
  if (!body || typeof body !== "object") return null;
  const { meta, data } = body as { meta?: Record<string, unknown>; data?: Record<string, unknown> };
  const eventName = typeof meta?.event_name === "string" ? meta.event_name : "";
  if (!data || data.type !== "orders" || (typeof data.id !== "string" && typeof data.id !== "number")) return null;
  const attrs = (data.attributes ?? {}) as Record<string, unknown>;
  const custom = (meta?.custom_data ?? {}) as Record<string, unknown>;
  const item = (attrs.first_order_item ?? {}) as Record<string, unknown>;
  const userId = typeof custom.user_id === "string" && UUID.test(custom.user_id) ? custom.user_id.toLowerCase() : null;
  const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : null);
  return {
    eventName,
    orderId: String(data.id),
    userId,
    testMode: Boolean(meta?.test_mode ?? attrs.test_mode),
    status: typeof attrs.status === "string" ? attrs.status : "",
    customerId: str(attrs.customer_id),
    variantId: str(item.variant_id),
    totalCents: typeof attrs.total === "number" && attrs.total >= 0 ? Math.round(attrs.total) : null,
    currency: typeof attrs.currency === "string" ? attrs.currency : null,
    createdAt: typeof attrs.created_at === "string" ? attrs.created_at : null,
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
      ((await call(`/entitlements?user_id=eq.${userId}&select=status,test_mode,lemon_order_id`)) as {
        status: string;
        test_mode: boolean;
        lemon_order_id: string;
      }[])[0] ?? null,
    upsertEntitlement: (row: Record<string, unknown>) =>
      call(`/entitlements?on_conflict=user_id`, {
        method: "POST",
        body: JSON.stringify(row),
        prefer: "resolution=merge-duplicates,return=minimal",
      }),
    markRefunded: (orderId: string) =>
      call(`/entitlements?lemon_order_id=eq.${encodeURIComponent(orderId)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "refunded", updated_at: new Date().toISOString() }),
        prefer: "return=minimal",
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

/** Applies one verified event. Idempotent: a retried delivery changes nothing twice. */
export async function applyEvent(event: OrderEvent, env: WebhookEnv, fetchImpl: Fetch): Promise<Outcome> {
  const db = rest(env as Required<Pick<WebhookEnv, "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY">>, fetchImpl);
  const id = `${event.eventName}:${event.orderId}`;
  if (await db.seen(id)) return "duplicate";
  let outcome: Outcome;
  if (!HANDLED.has(event.eventName)) outcome = "ignored";
  else if (env.LEMONSQUEEZY_VARIANT_ID && event.variantId && event.variantId !== env.LEMONSQUEEZY_VARIANT_ID)
    outcome = "ignored";
  else if (event.eventName === "order_refunded") {
    await db.markRefunded(event.orderId);
    outcome = "applied";
  } else if (!event.userId) outcome = "unlinked";
  else if (event.status !== "paid") outcome = "ignored";
  else {
    const current = await db.entitlementFor(event.userId);
    const refundedAlready = current?.lemon_order_id === event.orderId && current.status === "refunded";
    const wouldDowngrade = current && current.status === "paid" && !current.test_mode && event.testMode;
    if (refundedAlready || wouldDowngrade) outcome = "ignored";
    else {
      await db.upsertEntitlement({
        user_id: event.userId,
        status: "paid",
        test_mode: event.testMode,
        lemon_order_id: event.orderId,
        lemon_customer_id: event.customerId,
        variant_id: event.variantId,
        total_cents: event.totalCents,
        currency: event.currency,
        purchased_at: event.createdAt,
        updated_at: new Date().toISOString(),
      });
      outcome = "applied";
    }
  }
  await db.record({
    id,
    event_name: event.eventName || "unknown",
    order_id: event.orderId,
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
  const event = parseOrderEvent(body);
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
