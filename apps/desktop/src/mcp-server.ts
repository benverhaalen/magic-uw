import { appendFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createStore, readerReceiptLogPath, ReaderSchemaError } from "@magic/storage";
import { createMcpService } from "../../../packages/core/src/mcp";

/**
 * A host launches this read-only stdio endpoint using a locally exported connection file.
 * It is a reader: it opens the database read-only, never migrates or backs it up, and appends its
 * receipts to a log the app imports on its next start. The connection file carries no database
 * path: the database is the app's `workspace.sqlite`, one folder above the file's `mcp/` folder.
 * (Files exported before this change still name `databasePath`; it is honoured until re-export.)
 */
async function main() {
  const path = process.argv[process.argv.indexOf("--connection") + 1];
  if (!process.argv.includes("--connection") || !path || !isAbsolute(path))
    throw new Error();
  const info = await stat(path);
  if (
    info.size > 16_000 ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new Error();
  const config = z
    .object({
      databasePath: z.string().refine(isAbsolute).optional(),
      clientId: z.string().min(1).max(256),
      token: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(JSON.parse(await readFile(path, "utf8")));
  const database = config.databasePath ?? resolve(dirname(path), "..", "workspace.sqlite");
  const store = createStore(database, { readOnly: true });
  const log = readerReceiptLogPath(database);
  const { server } = createMcpService(store, config.clientId, config.token, undefined, {
    recordReceipt: (receipt) =>
      appendFileSync(log, `${JSON.stringify(receipt)}\n`, { mode: 0o600 }),
  });
  server.server.onclose = () => store.close();
  await server.connect(new StdioServerTransport());
}
void main().catch((error: unknown) => {
  process.stderr.write(
    error instanceof ReaderSchemaError
      ? `My Magic UW MCP: ${error.message}\n`
      : "My Magic UW MCP could not open its local connection. Reconnect from Data & AI.\n",
  );
  process.exitCode = 1;
});
