import type { ClientId, ClientStatus, ConsentRecord } from "@magic/contracts";
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
  type ClientsDeps,
} from "./profiles";
import { createTerminalHost, type TerminalHostDeps } from "./terminal-host";

export * from "./profiles";
export * from "./terminal-host";

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
    /** For the runner wiring (follow-up): the chosen client's profile environment. */
    profileEnv: (id: ClientId) => profileEnv(id, deps),
    terminal,
  };
}
export type Clients = ReturnType<typeof createClients>;
export type { ClientsDeps };
