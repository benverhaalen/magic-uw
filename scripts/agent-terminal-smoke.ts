// owner: claude-chat. Headless live check of the voice agent's harness: the same generated
// --mcp-config, --settings, brief and plugin the terminal launch uses, driven by `claude -p` with the
// text a student would say (voice itself can't run headless). Synthetic fixture in a temp workspace;
// the app-control port records what main would do instead of opening windows or a browser.
// Run: pnpm exec tsx scripts/agent-terminal-smoke.ts ["request" ...]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { defaultPrivacy, type CaptureBatch } from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import fixture from "../fixtures/course.json";
import { createClaudeChat, prepareAgentTerminal } from "../packages/core/src/chat/index";
import { resolveCli, cliEnvironment } from "../packages/runner/src/index";

const dir = mkdtempSync(join(tmpdir(), "magic-agent-smoke-"));
const store = createStore(join(dir, "workspace.sqlite"));
await createCore(store, { fixture: fixture as unknown as CaptureBatch }).execute({ type: "fixture" });
store.setConsent!({ action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION }, new Date().toISOString());
store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true, shareStudentWork: true });
const actions: string[] = [];
const chat = createClaudeChat({
  store,
  session: async () => null,
  pack: async () => ({ status: "unused", message: "" }),
  control: {
    navigate: async (t) => (actions.push(`navigate ${JSON.stringify(t)}`), true),
    openExternal: async (url) => void actions.push(`openExternal ${url}`),
    pack: async (name, scope) => (actions.push(`pack ${name} ${JSON.stringify(scope)}`), { status: "ready", message: "Recorded by the smoke.", cached: true }),
  },
});
const command = resolveCli("claude");
if (!command) throw new Error("claude is not on PATH");
const endpoint = await chat.agentEndpoint();
if (endpoint.status !== "ready") throw new Error(endpoint.reason);
const folder = join(dir, "agent", "smoke");
const prepared = await prepareAgentTerminal({ folder, mcpConfig: endpoint.mcpConfig, context: endpoint.context, command });
const requests = process.argv.slice(2).length ? process.argv.slice(2) : ["open my next assignment in canvas", "take me to prep for the midterm"];
try {
  for (const text of requests) {
    actions.length = 0;
    const started = Date.now();
    const tools: string[] = [];
    let skills: string[] = [];
    let result = "";
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.file, [...command.prefixArgs, "-p", "--output-format", "stream-json", "--verbose", ...prepared.args], {
        cwd: folder,
        env: cliEnvironment(),
        shell: false,
        windowsHide: true,
      });
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          let e: { type?: string; subtype?: string; tools?: string[]; skills?: string[]; message?: { content?: { type?: string; name?: string; input?: unknown }[] }; result?: string };
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          if (e.type === "system" && e.subtype === "init") {
            skills = (e.skills ?? []).filter((s) => s.includes("magic-uw"));
            console.log(`init tools: ${JSON.stringify(e.tools)}`);
          }
          if (e.type === "assistant")
            for (const b of e.message?.content ?? []) if (b.type === "tool_use") tools.push(`${b.name} ${JSON.stringify(b.input)} @${Date.now() - started}ms`);
          if (e.type === "result") result = String(e.result ?? "");
        }
      });
      child.stderr.on("data", () => undefined);
      child.on("error", reject);
      child.on("exit", () => resolve());
      child.stdin.end(text);
    });
    console.log(`\nSAID: ${text}\nplugin skills: ${JSON.stringify(skills)}\ntotal ${Date.now() - started} ms`);
    for (const t of tools) console.log(`  tool ${t}`);
    for (const a of actions) console.log(`  app  ${a}`);
    console.log(`  reply: ${result.slice(0, 400)}`);
  }
  console.log(`\nreceipts: ${JSON.stringify(store.receipts().filter((r) => r.recipient === "claude").map((r) => r.purpose))}`);
} finally {
  await chat.close();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
