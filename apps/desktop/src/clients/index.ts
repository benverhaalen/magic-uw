import type { ClientHealth, ClientId, ClientMode, ClientStatus, ConsentRecord } from "@magic/contracts";
import { z } from "zod"; // owner: client-health
import { checkHealth, createApiKeyStore, type HealthDeps } from "./health"; // owner: client-health
import { clearInstantCaches, writeClientMode } from "./instant"; // owner: client-health
import { hasCurrentConsent } from "@magic/domain";
import {
  authStatus,
  chooseClient,
  clientIdSchema,
  detectClient,
  detectClients,
  isProfileReady,
  prepareProfile,
  profileEnv,
  resetClientSetup,
  type ClientsDeps,
} from "./profiles";
import { createTerminalHost, type TerminalHostDeps } from "./terminal-host";

export * from "./profiles";
export * from "./terminal-host";
export * from "./instant"; // owner: client-health
export * from "./health"; // owner: client-health

/** A client's terminal needs that provider's own current consent record (recipient = id). */
export function providerConsented(records: readonly ConsentRecord[] | undefined, id: ClientId): boolean {
  return hasCurrentConsent(records, id);
}

/** Main's facade: every entry validates the client id as it arrives over IPC. */
export function createClients(deps: TerminalHostDeps) {
  const terminal = createTerminalHost(deps);
  const parseId = (value: unknown): ClientId => {
    const r = clientIdSchema.safeParse(value);
    if (!r.success) throw new Error("Unknown client.");
    return r.data;
  };
  return {
    detect: (): Promise<ClientStatus[]> => detectClients(deps),
    async prepare(value: unknown): Promise<ClientStatus> {
      const id = parseId(value);
      await prepareProfile(id, deps);
      const status = await detectClient(id, deps);
      return { ...status, profileReady: await isProfileReady(id, deps.userData) };
    },
    authStatus: async (value: unknown): Promise<ClientStatus> => authStatus(parseId(value), deps),
    choose: async (value: unknown): Promise<void> => chooseClient(parseId(value), deps.userData),
    /** owner: reconfigure. Ends client sessions, then removes the app's client setup (see resetClientSetup). */
    async reset(): Promise<void> {
      terminal.closeAll();
      await resetClientSetup(deps.userData);
      clearInstantCaches();
    },
    /** For the runner wiring (follow-up): the chosen client's profile environment. */
    profileEnv: (id: ClientId) => profileEnv(id, deps),
    terminal,
  };
}
export type Clients = ReturnType<typeof createClients>;
export type { ClientsDeps };

// owner: client-health (D50). Health, the saved mode per client and Gemini's key, over IPC from
// main. Every entry validates what the renderer sent; a key's value never leaves main.
const modeSchema = z.enum(["instant", "isolated", "api_key"]);
export function createClientHealth(deps: HealthDeps & { vault: Parameters<typeof createApiKeyStore>[0] }) {
  const keys = createApiKeyStore(deps.vault, deps.env ?? process.env);
  const healthDeps: HealthDeps = { ...deps, keyStatus: keys.status };
  const parseId = (value: unknown): ClientId => {
    const r = clientIdSchema.safeParse(value);
    if (!r.success) throw new Error("Unknown client.");
    return r.data;
  };
  const parseMode = (value: unknown): ClientMode | undefined => {
    if (value === undefined) return undefined;
    const r = modeSchema.safeParse(value);
    if (!r.success) throw new Error("Unknown connection mode.");
    return r.data;
  };
  return {
    health: async (id: unknown, mode?: unknown): Promise<ClientHealth> => checkHealth(parseId(id), parseMode(mode), healthDeps),
    /** Saves a mode only when this client can use it here; answers with the health in that mode. */
    async setMode(id: unknown, mode: unknown): Promise<ClientHealth> {
      const client = parseId(id);
      const wanted = parseMode(mode);
      if (!wanted) throw new Error("Unknown connection mode.");
      const health = await checkHealth(client, wanted, healthDeps);
      if (!health.modes.includes(wanted))
        throw new Error(health.instant.reason ?? "This connection mode isn't available for this client.");
      await writeClientMode(client, wanted, deps.userData);
      return health;
    },
    geminiKey: { status: keys.status, save: keys.save, remove: keys.remove },
    /** Main and worker only. */
    geminiKeyValue: keys.value,
  };
}
export type ClientHealthRuntime = ReturnType<typeof createClientHealth>;
// end owner: client-health
