/**
 * Part B's "ours" condition: a read-only stdio MCP server over a private copy of our database,
 * exposing the shipped course bank (packages/core/src/mcp.ts) and the agent API v1 verbs
 * (packages/agent-api) as tools. `prepareOursMcp` makes the copy and applies, on the copy only, what
 * a student does in the app to connect an AI client: consent for that provider, course-text sharing,
 * and a grant for the included courses. The operator's own app database is never modified.
 *
 * Run: node <tsx cli> mcp-ours.ts --db <copy.sqlite> --grant <grant.json>
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createStore } from "@magic/storage";
import { defaultPrivacy } from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { createMcpService } from "../../../packages/core/src/mcp";
import { createReadApi, inputSchemas } from "../../../packages/agent-api/src/v1";
import { courseInclusion } from "../../../packages/core/src/access";
import { snapshotDb } from "./schema";

export function prepareOursMcp(options: { sourceDb: string; dir: string; recipient: "claude" | "codex" }): { db: string; grant: string } {
  const db = join(options.dir, `ours-mcp-${options.recipient}.sqlite`);
  rmSync(db, { force: true });
  snapshotDb(options.sourceDb, db);
  const store = createStore(db);
  try {
    const now = new Date().toISOString();
    store.setConsent?.({ action: "grant", recipient: options.recipient, disclosureVersion: CONSENT_DISCLOSURE_VERSION }, now);
    store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: options.recipient, shareCourseText: true });
    const sources = new Map(store.sources().map((s) => [s.id, s]));
    const included = courseInclusion(store);
    const courses = store.resources()
      .filter((r) => r.kind === "course" && !r.deleted && sources.get(r.sourceId)?.scope === "course" && included(r))
      .map((r) => ({ accountScope: sources.get(r.sourceId)!.accountScope, courseId: r.courseId }));
    const token = randomBytes(32).toString("hex");
    const clientId = randomUUID();
    store.setMcpGrant({
      id: clientId, label: `bench ${options.recipient}`, recipient: options.recipient, enabled: true, courses, categories: ["course_text"],
      tokenHash: createHash("sha256").update(token).digest("hex"),
    });
    const grant = join(options.dir, `ours-mcp-${options.recipient}.grant.json`);
    writeFileSync(grant, JSON.stringify({ clientId, token }), { mode: 0o600 });
    return { db, grant };
  } finally {
    store.close();
  }
}

async function main() {
  const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  const dbPath = arg("--db"), grantPath = arg("--grant");
  if (!dbPath || !grantPath) throw new Error("usage: mcp-ours.ts --db <copy.sqlite> --grant <grant.json>");
  const { clientId, token } = z.object({ clientId: z.string(), token: z.string() }).parse(JSON.parse(readFileSync(grantPath, "utf8")));
  const store = createStore(dbPath, { readOnly: true });
  const receipts = `${dbPath}.receipts.jsonl`;
  const recordReceipt = (receipt: unknown) => appendFileSync(receipts, `${JSON.stringify(receipt)}\n`);
  const { server } = createMcpService(store, clientId, token, undefined, { recordReceipt });
  const api = createReadApi(store, { clientId, token }, { recordReceipt });
  const verbs: Array<[keyof typeof inputSchemas, string]> = [
    ["courses", "List the permitted courses with open assignments, next due date and source coverage."],
    ["courseGraph", "A course's item counts by kind and link counts."],
    ["resources", "List items (no bodies) with kind, title, url and due date; filter by course and kinds; paginated."],
    ["resource", "Read one item with its text, deadlines and citations."],
    ["searchPassages", "Search the saved course text; returns passages with citations."],
    ["assignments", "List assignments with due dates (optionally only those due within `days`)."],
  ];
  for (const [verb, description] of verbs)
    server.registerTool(
      `api_${verb}`,
      { description, inputSchema: inputSchemas[verb], annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
      async (args: unknown) => {
        try {
          const run = api[verb] as (input: unknown) => unknown;
          return { content: [{ type: "text" as const, text: JSON.stringify(run.call(api, args)) }] };
        } catch (error) {
          return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "read failed" }] };
        }
      },
    );
  server.server.onclose = () => store.close();
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error: unknown) => {
    process.stderr.write(`bench mcp-ours: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exitCode = 1;
  });
