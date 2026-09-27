import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createStore } from "@magic/storage";
import { createMcpService } from "../../../packages/core/src/mcp";
import { verifyRestrictedToCurrentUser } from "./mcp-connection-acl";

/** A host launches this read-only stdio endpoint using a locally exported connection file. */
async function main() {
  const path = process.argv[process.argv.indexOf("--connection") + 1];
  if (!process.argv.includes("--connection") || !path || !isAbsolute(path))
    throw new Error();
  const info = await stat(path);
  if (
    info.size > 16_000 ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0) ||
    (process.platform === "win32" && !(await verifyRestrictedToCurrentUser(path)))
  )
    throw new Error();
  const config = z
    .object({
      databasePath: z.string().refine(isAbsolute),
      clientId: z.string().min(1).max(256),
      token: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(JSON.parse(await readFile(path, "utf8")));
  const store = createStore(config.databasePath);
  const { server } = createMcpService(store, config.clientId, config.token);
  server.server.onclose = () => store.close();
  await server.connect(new StdioServerTransport());
}
void main().catch(() => {
  process.stderr.write(
    "My Magic UW MCP could not open its local connection. Reconnect from Data & AI.\n",
  );
  process.exitCode = 1;
});
