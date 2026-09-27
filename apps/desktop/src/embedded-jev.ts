// owner: embedded-jev. September 27 decision (docs/decisions.md, "Embedded Jev key"): until a
// hosted gateway exists, a build may carry the owner's TypeSafe key and run the existing gateway
// in the main process on loopback. The key is extractable from any build that includes it; the
// team accepted that risk for now. It never reaches the worker, the renderer, logs or Git.
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createGateway, DEFAULT_LIMITS } from "../../gateway/src/gateway";

// Replaced at build time by scripts/build.ts from MAGIC_EMBED_TYPESAFE_KEY; undefined under tsx.
declare const __MAGIC_EMBEDDED_TYPESAFE_KEY__: string | undefined;
const embeddedKey = (): string =>
  typeof __MAGIC_EMBEDDED_TYPESAFE_KEY__ === "string" ? __MAGIC_EMBEDDED_TYPESAFE_KEY__.trim() : "";
/**
 * owner: voice-plan. The spoken-action Jev Choice runs in main with this same key (the gateway has no
 * action-choice route). Main only; never pass it to the worker, the renderer, logs or Git.
 */
export const embeddedJevKey = (): string => embeddedKey();

/**
 * Operator decision 2026-09-27 (demo): the repo defaults (5 requests an hour, 1 at a time per device)
 * stalled judgments mid-demo. The embedded gateway runs for one laptop, so its per-device caps are
 * lifted to keep results coming; the body size and per-request timeout stay as the defaults.
 */
const DEMO_LIMITS = {
  ...DEFAULT_LIMITS,
  globalDailyRequestLimit: 5_000,
  deviceDailyLimit: 5_000,
  deviceHourlyLimit: 1_000,
  deviceConcurrency: 6,
  globalConcurrency: 12,
};

export interface EmbeddedJev {
  /** Loopback URL for the desktop's ordinary gateway client. */
  url: string;
  close(): Promise<void>;
}

/**
 * Starts the gateway on 127.0.0.1 with an OS-assigned port when this build carries a key.
 * Caps are the gateway's repo defaults and apply per laptop. Returns null for source builds.
 */
export async function startEmbeddedJev(dataDir: string, key = embeddedKey()): Promise<EmbeddedJev | null> {
  if (!key) return null;
  const handle = createGateway({
    host: "127.0.0.1",
    port: 0,
    dbPath: join(dataDir, "jev-embedded.sqlite"),
    apiKey: key,
    limits: DEMO_LIMITS,
    // The gateway's lines never contain bodies, tokens or the key; keep the main process quiet.
    log: () => {},
  });
  try {
    await handle.listening;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
  const { port } = handle.server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => handle.close() };
}
