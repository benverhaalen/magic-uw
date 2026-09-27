// owner: platform-fix. The host side of "Delete local data", apart from main.ts so it can be tested
// without Electron: every app-owned session loses its storage and its HTTP cache (as sign-out
// already does), and every app-owned folder goes.
export interface PurgeableSession {
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
}

export async function purgeHostData(input: {
  sessions: readonly PurgeableSession[];
  folders: readonly string[];
  remove(path: string): Promise<void>;
  /** Other host work that runs alongside (planning scope reset). */
  also?: readonly Promise<unknown>[];
}): Promise<void> {
  await Promise.all([
    ...input.folders.map((folder) => input.remove(folder)),
    ...input.sessions.flatMap((session) => [session.clearStorageData(), session.clearCache()]),
    ...(input.also ?? []),
  ]);
}
