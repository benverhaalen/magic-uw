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
    limits: DEFAULT_LIMITS,
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
