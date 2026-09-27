/**
 * Encryption at rest for the most sensitive columns (docs/ai-and-privacy.md, "At rest").
 *
 * - AES-256-GCM, a fresh 96-bit IV per value, the column name as associated data (a value
 *   cannot be moved to another column and still open).
 * - One 32-byte install secret, created and wrapped by Electron safeStorage in main and sent
 *   to the worker at start over its message channel; HKDF derives the at-rest key and the
 *   pseudonym key from it. Neither is written anywhere in plaintext.
 * - Resource payloads keep their non-sensitive fields in the clear (title, dates, category,
 *   links) and move the sensitive ones into one sealed field: mail preview, gist, sender name
 *   and address and text; notes text and parts. A value that cannot be opened (a destroyed or
 *   different key) reads as its clear part with the sensitive fields empty.
 * - Leaf module: node:crypto only, so storage can import it without a cycle.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

export const SEAL_PREFIX = "enc1:";
const IV = 12, TAG = 16;

export function deriveInstallKeys(secret: Uint8Array): { atRest: Buffer; pseudonym: Buffer } {
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", secret, "magic-canvas-install", info, 32));
  return { atRest: derive("at-rest-v1"), pseudonym: derive("pseudonym-v1") };
}
/** A short check value stored beside the data, so a different key is detected, not guessed. */
export function keyCheck(key: Uint8Array): string {
  return createHmac("sha256", key).update("magic-canvas-key-check-v1").digest("hex").slice(0, 16);
}

export function seal(key: Uint8Array, plaintext: Uint8Array | string, aad: string): string {
  const iv = randomBytes(IV);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext), cipher.final()]);
  return SEAL_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}
export function open(key: Uint8Array, sealed: string, aad: string): Buffer {
  if (!sealed.startsWith(SEAL_PREFIX)) throw new Error("not_sealed");
  const raw = Buffer.from(sealed.slice(SEAL_PREFIX.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(raw.subarray(IV, IV + TAG));
  return Buffer.concat([decipher.update(raw.subarray(IV + TAG)), decipher.final()]);
}
export const isSealed = (value: unknown): value is string => typeof value === "string" && value.startsWith(SEAL_PREFIX);

type Item = Record<string, unknown> & { text?: unknown; parts?: unknown; mail?: Record<string, unknown>; notes?: unknown; __sealed?: unknown };
const MAIL_FIELDS = ["preview", "gist", "fromName", "fromAddress"] as const;
export const RESOURCE_AAD = "resource_versions.payload";
export const PLANNING_CAPTURE_AAD = "planning_captures.payload";
export const PLANNING_VERSION_AAD = "planning_versions.payload";
export const LIFE_SENDER_AAD = "life_items.sender";
export const LIFE_GIST_AAD = "life_items.gist";

/** True for the resource kinds whose payload is sealed (mail and notes). */
export function sensitiveItem(item: unknown): boolean {
  const i = item as Item | null;
  return !!i && typeof i === "object" && (!!i.mail || !!i.notes);
}

export interface AtRestCodec {
  setKey(key: Uint8Array | null): void;
  hasKey(): boolean;
  /** A sensitive item written while no key was set (the lazy pass must run again). */
  unsealedWrites(): boolean;
  clearUnsealedWrites(): void;
  sealItem<T>(item: T): T;
  openItem<T>(item: T): T;
  /** The searchable projection: mail indexes its subject and category only while sealed. */
  searchable<T extends { title: string; text: string }>(item: T): T;
  sealJson(value: unknown, aad: string): string;
  /** One text column: sealed with a key, as written without one; a value that cannot be opened reads as "". */
  sealText(value: string, aad: string): string;
  openText(value: string, aad: string): string;
  openJson(text: string, aad: string): unknown;
  stats(): { sealed: number; opened: number; failed: number };
}

export function createAtRestCodec(): AtRestCodec {
  let key: Buffer | null = null;
  let dirty = false;
  const stats = { sealed: 0, opened: 0, failed: 0 };
  return {
    setKey(value) {
      key?.fill(0);
      key = value ? Buffer.from(value) : null;
    },
    hasKey: () => !!key,
    unsealedWrites: () => dirty,
    clearUnsealedWrites() {
      dirty = false;
    },
    sealItem<T>(item: T): T {
      const i = item as Item;
      if (!sensitiveItem(i) || i.__sealed) return item;
      if (!key) {
        dirty = true;
        return item;
      }
      const secret: Record<string, unknown> = { text: i.text };
      if (i.parts !== undefined) secret.parts = i.parts;
      const clear: Item = { ...i, text: "" };
      delete clear.parts;
      if (i.mail) {
        const mail = { ...i.mail };
        for (const f of MAIL_FIELDS) if (mail[f] !== undefined) {
          secret[f] = mail[f];
          delete mail[f];
        }
        mail.preview = "";
        clear.mail = mail;
      }
      clear.__sealed = seal(key, JSON.stringify(secret), RESOURCE_AAD);
      stats.sealed++;
      return clear as T;
    },
    openItem<T>(item: T): T {
      const i = item as Item;
      if (!i || typeof i !== "object" || !isSealed(i.__sealed)) return item;
      const { __sealed, ...clear } = i;
      if (!key) {
        stats.failed++;
        return clear as T;
      }
      try {
        const secret = JSON.parse(open(key, __sealed, RESOURCE_AAD).toString("utf8")) as Record<string, unknown>;
        const out: Item = { ...clear, text: secret.text };
        if (secret.parts !== undefined) out.parts = secret.parts;
        if (clear.mail) {
          const mail = { ...(clear.mail as Record<string, unknown>) };
          for (const f of MAIL_FIELDS) if (secret[f] !== undefined) mail[f] = secret[f];
          out.mail = mail;
        }
        stats.opened++;
        return out as T;
      } catch {
        stats.failed++;
        return clear as T;
      }
    },
    searchable(item) {
      const i = item as unknown as Item;
      if (!key || !i.mail) return item;
      const category = typeof i.mail.category === "string" ? i.mail.category : "";
      return { ...item, title: category ? `${item.title}\n${category}` : item.title, text: "", parts: undefined };
    },
    sealJson(value, aad) {
      const json = JSON.stringify(value);
      if (!key) {
        dirty = true;
        return json;
      }
      stats.sealed++;
      return seal(key, json, aad);
    },
    sealText(value, aad) {
      if (!key) {
        if (value) dirty = true;
        return value;
      }
      stats.sealed++;
      return seal(key, value, aad);
    },
    openText(value, aad) {
      if (!isSealed(value)) return value;
      if (!key) {
        stats.failed++;
        return "";
      }
      try {
        stats.opened++;
        return open(key, value, aad).toString("utf8");
      } catch {
        stats.failed++;
        return "";
      }
    },
    openJson(text, aad) {
      if (!isSealed(text)) return JSON.parse(text);
      if (!key) throw new Error("This record is encrypted and the key is not available.");
      stats.opened++;
      return JSON.parse(open(key, text, aad).toString("utf8"));
    },
    stats: () => ({ ...stats }),
  };
}
