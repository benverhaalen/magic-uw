import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface SecretEncryption {
  available(): boolean;
  encrypt(value: string): Uint8Array;
  decrypt(value: Uint8Array): string;
}
/** App-owned capabilities only. Never reads or imports any browser's cookie storage. */
export function createSecretVault(path: string, encryption: SecretEncryption) {
  let queue: Promise<unknown> = Promise.resolve();
  async function read(): Promise<Record<string, string>> {
    if (!encryption.available())
      throw new Error("OS-backed secret storage is unavailable.");
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("Local secret storage could not be read.");
    }
    try {
      const value: unknown = JSON.parse(encryption.decrypt(bytes));
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.values(value).some((v) => typeof v !== "string")
      )
        throw new Error();
      return value as Record<string, string>;
    } catch {
      throw new Error(
        "Local secrets could not be decrypted. Reconnect the source.",
      );
    }
  }
  function mutate(fn: (values: Record<string, string>) => void) {
    const operation = queue.then(async () => {
      const values = await read();
      fn(values);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, encryption.encrypt(JSON.stringify(values)), {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return {
    async list(prefix: string) {
      await queue;
      return Object.entries(await read())
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value }));
    },
    async get(key: string) {
      await queue;
      return (await read())[key];
    },
    set(key: string, value: string) {
      if (key.length > 500 || value.length > 16000)
        throw new Error("Secret exceeds its local limit.");
      return mutate((values) => {
        values[key] = value;
      });
    },
    deletePrefix(prefix: string) {
      return mutate((values) => {
        for (const key of Object.keys(values))
          if (key.startsWith(prefix)) delete values[key];
      });
    },
    async clear() {
      await queue;
      await rm(path, { force: true });
    },
  };
}
