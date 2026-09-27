#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json` with `--mcp-config` (the in-app chat session).
// Makes no network calls except to the loopback MCP server named in `--mcp-config`; reads no
// credentials. Each user message picks a script from its text:
//   "flashcards"  search {query: induction}, then ask for the cards pack with the found items
//   "item <id>"   get_item {id}, and reply with what the tool returned
//   "degree"      degree_plan {}, and reply with what the tool returned
//   "rogue"       emit a Bash tool_use (the stream check must stop the session)
//   otherwise     search {query: the text}, and cite the hits
// Every reply starts with "turn <n> pid <pid>", so a test can tell the session was kept.
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const config = JSON.parse(flag("--mcp-config") ?? "{}");
const [serverName, server] = Object.entries(config.mcpServers ?? {})[0] ?? [];
const allowed = (flag("--allowedTools") ?? "").split(",").filter(Boolean);
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
let rpc = 0;
async function call(method, params) {
  const res = await fetch(server.url, {
    method: "POST",
    headers: { ...server.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method, params }),
  });
  return (await res.json()).result;
}
await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } });
const listed = (await call("tools/list", {})).tools.map((t) => `mcp__${serverName}__${t.name}`);
out({ type: "system", subtype: "init", tools: listed.filter((t) => allowed.includes(t)), mcp_servers: [{ name: serverName, status: "connected" }] });

let turn = 0;
async function tool(name, input) {
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${rpc}`, name: `mcp__${serverName}__${name}`, input }] } });
  const result = await call("tools/call", { name, arguments: input });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${rpc}` }] } });
  const text = result.content?.[0]?.text ?? "";
  return { isError: !!result.isError, text, value: result.isError ? null : JSON.parse(text) };
}
function reply(text) {
  for (const piece of text.match(/[\s\S]{1,12}/g) ?? [])
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: piece } } });
  out({ type: "assistant", message: { content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", result: text, usage: { input_tokens: 100, output_tokens: 20 } });
}
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  const text = JSON.parse(line).message.content[0].text;
  const question = text.split("\n").slice(1).join("\n");
  turn++;
  const head = `turn ${turn} pid ${process.pid}`;
  if (/rogue/.test(question)) {
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "echo hi" } }] } });
    await new Promise((r) => setTimeout(r, 5000));
    reply(`${head} should never be seen`);
  } else if (/flashcards/.test(question)) {
    const found = await tool("search", { query: "induction" });
    const items = (Array.isArray(found.value) ? found.value : []).slice(0, 3);
    reply(`${head} Cards on induction from ${items.length} items.\nACTION: cards course=${items[0]?.courseId ?? "none"} items=${items.map((i) => i.id).join(",")}`);
  } else if (/item (\S+)/.test(question)) {
    const got = await tool("get_item", { id: /item (\S+)/.exec(question)[1] });
    reply(`${head} ${got.isError ? `REFUSED ${got.text}` : `READ ${got.value.title}`}`);
  } else if (/degree/.test(question)) {
    const got = await tool("degree_plan", {});
    reply(`${head} ${got.isError ? `REFUSED ${got.text}` : `AUDIT ${got.value.audits.length}`}`);
  } else {
    const found = await tool("search", { query: question.slice(0, 100) });
    const hits = Array.isArray(found.value) ? found.value : [];
    reply(`${head} Found ${hits.length}.\nSOURCES: ${hits.map((h) => h.id).join(", ")}`);
  }
}
