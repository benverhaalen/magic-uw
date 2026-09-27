/**
 * The egress policy (T06; spec G1; docs/ai-and-privacy.md "Accepted disclosure flow").
 *
 * - The setup checkbox writes a `uw` consent record (plus `jev` and the chosen provider).
 *   Until it exists, main refuses every channel that can reach UW or Jev
 *   (`consentGateAllows`), and a worker-side public client can be wrapped the same way
 *   (`gatePublicClient`).
 * - `maySend` (@magic/domain) refuses any hosted recipient without its own current record.
 * - The first send of a sensitive category to a recipient, or every send with "always
 *   preview", is held as `preview_required` until a `preview.ack` for exactly that payload
 *   hash. Declining writes `blocked`. A background caller gets the same answer and waits;
 *   it never prompts.
 *
 * Dates, hashes and permissions are decided here in code; nothing here sends a request.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  consentChangeSchema,
  previewAckSchema,
  type ConsentChange,
  type ConsentRecord,
  type ContextManifest,
  type EgressReceipt,
  type Store,
} from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION, hasCurrentConsent } from "@magic/domain";
import {
  MaterialReadError,
  type PublicClient,
} from "../../connectors/src/network";

export { CONSENT_DISCLOSURE_VERSION };

/** Every main-process channel that can reach the network (T05d's gate call sites). */
export type ConsentGatedChannel =
  | "magic:signin"
  | "magic:sync"
  | "magic:planning-sync"
  | "source-fetch"
  | "planning-public-read"
  | "planning-refresh"
  | "evaluate";

/**
 * Main's gate decision, a pure function of the records. Reading UW (sign-in, sync, planning,
 * source reads) needs the setup record; `evaluate` (the Jev gateway) needs Jev's own record.
 */
export function consentGateAllows(
  channel: ConsentGatedChannel,
  records: readonly ConsentRecord[] | undefined,
): boolean {
  return hasCurrentConsent(records, channel === "evaluate" ? "jev" : "uw");
}

/** True once the setup checkbox has been agreed for the current disclosure. */
export function hasSetupConsent(
  records: readonly ConsentRecord[] | undefined,
): boolean {
  return hasCurrentConsent(records, "uw");
}

/**
 * Wraps a direct (worker-side) public client so it reads nothing until `allowed()` is true.
 * The refusal throws before any socket is opened.
 */
export function gatePublicClient(
  client: PublicClient,
  allowed: () => boolean,
): PublicClient {
  const check = () => {
    if (!allowed()) throw new MaterialReadError("consent_required");
  };
  return {
    isCanvas: (url) => client.isCanvas(url),
    async get(url, options) {
      check();
      return client.get(url, options);
    },
    async text(url, options) {
      check();
      return client.text(url, options);
    },
    async feed(secretUrl, canvasOrigin, signal) {
      check();
      return client.feed(secretUrl, canvasOrigin, signal);
    },
    async signedDownload(url, allowedOrigins, signal) {
      check();
      return client.signedDownload(url, allowedOrigins, signal);
    },
  };
}

/** The only writer of consent records (the `consent` command). Returns the student message. */
export function applyConsent(
  store: Store,
  raw: ConsentChange,
  at: string,
): string {
  const change = consentChangeSchema.parse(raw);
  if (!store.setConsent)
    throw new Error("This workspace cannot record consent.");
  if (
    change.action === "grant" &&
    change.disclosureVersion !== CONSENT_DISCLOSURE_VERSION
  )
    throw new Error(
      "This agreement screen is out of date. Reopen it to see the current disclosure.",
    );
  store.setConsent(change, at);
  if (change.action === "revoke")
    return change.recipient === "uw"
      ? "Agreement withdrawn. Magic Canvas will not contact UW until you agree again. Saved coursework stays on this device."
      : "Agreement withdrawn. Nothing more is sent to this service; data already sent cannot be retracted.";
  return change.recipient === "uw"
    ? "Agreement saved. You can now sign in to UW."
    : "Agreement saved.";
}

export const sensitiveCategories = [
  "student_work",
  "grades",
  "comments",
  "communications",
] as const;

/** sha256 over a canonical JSON form (sorted keys), so equal payloads hash equally. */
export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(canonical(payload)).digest("hex");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** A receipt describes the manifest actually evaluated: recipient, categories, IDs, size. */
export function buildReceipt(
  manifest: Pick<
    ContextManifest,
    "recipient" | "purpose" | "categories" | "resourceIds" | "characters"
  >,
  status: EgressReceipt["status"],
  at: string,
  id: string = randomUUID(),
): EgressReceipt {
  return {
    id,
    recipient: manifest.recipient,
    purpose: manifest.purpose,
    categories: [...manifest.categories],
    resourceIds: [...manifest.resourceIds],
    characters: manifest.characters,
    status,
    createdAt: at,
  };
}

export type EgressDecision =
  | { status: "allowed"; payloadHash: string }
  | { status: "blocked"; reason: string; receiptId: string }
  | {
      status: "preview_required";
      reason: string;
      previewId: string;
      payloadHash: string;
      /** The exact payload to show; the ack must carry its hash. */
      payload: unknown;
      /** False for a background caller: it waits for the student and never prompts. */
      prompt: boolean;
    };

type EgressManifest = Omit<ContextManifest, "payload"> & { payload: unknown };

interface Pending {
  manifest: EgressManifest;
  payloadHash: string;
}

export interface EgressPolicy {
  /**
   * Decides one send. `manifest.allowed` must come from `maySend` for the current settings.
   * A blocked or held decision writes its receipt here; an allowed one is the caller's to
   * record with `record(manifest, "sent")` just before the call.
   */
  check(
    manifest: EgressManifest,
    options: { at: string; background?: boolean },
  ): EgressDecision;
  /** The `preview.ack` command. Binds the answer to the previewed payload's hash. */
  acknowledge(raw: unknown, at: string): string;
  record(
    manifest: EgressManifest,
    status: "sent" | "failed",
    at: string,
  ): void;
  /** Held previews, for the UI and for a waiting background job. */
  pending(): { previewId: string; recipient: string; payloadHash: string }[];
}

/**
 * One policy per store: previews and approvals are held in memory for the running
 * workspace (a restart asks again, which is the safe side). Whether a category was already
 * sent to a recipient comes from the persisted `sent` receipts, so a purge asks again too.
 */
const policies = new WeakMap<Store, EgressPolicy>();
export function egressFor(store: Store): EgressPolicy {
  let policy = policies.get(store);
  if (!policy) policies.set(store, (policy = createEgressPolicy(store)));
  return policy;
}

export function createEgressPolicy(store: Store): EgressPolicy {
  const pending = new Map<string, Pending>();
  const approved = new Set<string>();
  const key = (recipient: string, hash: string) => `${recipient}\u0000${hash}`;
  function firstSend(recipient: string, categories: readonly string[]) {
    const sent = new Set(
      store
        .receipts()
        .filter((r) => r.recipient === recipient && r.status === "sent")
        .flatMap((r) => r.categories),
    );
    return categories.filter(
      (c) =>
        (sensitiveCategories as readonly string[]).includes(c) && !sent.has(c),
    );
  }
  return {
    check(manifest, { at, background = false }) {
      if (!manifest.allowed) {
        const receipt = buildReceipt(manifest, "blocked", at);
        store.addReceipt(receipt);
        return {
          status: "blocked",
          reason: manifest.reason,
          receiptId: receipt.id,
        };
      }
      const hash = payloadHash(manifest.payload);
      if (approved.delete(key(manifest.recipient, hash)))
        return { status: "allowed", payloadHash: hash };
      const always = store.privacy().alwaysPreview === true;
      const fresh = firstSend(manifest.recipient, manifest.categories);
      if (!always && !fresh.length)
        return { status: "allowed", payloadHash: hash };
      const reason = always
        ? "Always preview is on: review exactly what would be sent."
        : `First time sharing ${fresh.join(", ").replaceAll("_", " ")} with this service: review exactly what would be sent.`;
      // A repeated request for the same payload reuses its preview (no duplicate receipt).
      for (const [previewId, held] of pending)
        if (
          held.payloadHash === hash &&
          held.manifest.recipient === manifest.recipient
        )
          return {
            status: "preview_required",
            reason,
            previewId,
            payloadHash: hash,
            payload: manifest.payload,
            prompt: !background,
          };
      const previewId = randomUUID();
      pending.set(previewId, { manifest, payloadHash: hash });
      store.addReceipt(buildReceipt(manifest, "preview_required", at, previewId));
      return {
        status: "preview_required",
        reason,
        previewId,
        payloadHash: hash,
        payload: manifest.payload,
        prompt: !background,
      };
    },
    acknowledge(raw, at) {
      const ack = previewAckSchema.parse(raw);
      const held = pending.get(ack.id);
      if (!held || held.payloadHash !== ack.payloadHash)
        throw new Error(
          "This preview no longer matches what would be sent. Nothing was sent.",
        );
      pending.delete(ack.id);
      if (ack.decision === "decline") {
        store.addReceipt(buildReceipt(held.manifest, "blocked", at));
        return "Nothing was sent.";
      }
      approved.add(key(held.manifest.recipient, held.payloadHash));
      return "Approved. Only the content you reviewed will be sent.";
    },
    record(manifest, status, at) {
      store.addReceipt(buildReceipt(manifest, status, at));
    },
    pending() {
      return [...pending].map(([previewId, held]) => ({
        previewId,
        recipient: held.manifest.recipient,
        payloadHash: held.payloadHash,
      }));
    },
  };
}
