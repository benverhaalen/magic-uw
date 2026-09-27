// owner: claude-chat. Live smoke of the in-app chat on the synthetic fixture only: a temporary
// workspace (never the student's), the sample course loaded, sharing on for Claude with a consent
// record, and the real `claude` CLI on Opus 5.5 driving the app's read tools. Headless: no window.
// The cards pack is recorded, not run (the pack path is covered by its own tests).
// Run: pnpm exec tsx scripts/claude-chat-smoke.ts ["question" ...]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { defaultPrivacy, type CaptureBatch, type PackScope } from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import fixture from "../fixtures/course.json";
import { createClaudeChat } from "../packages/core/src/chat/index";
import { createChatSession, resolveCli, CHAT_MODEL } from "../packages/runner/src/index";

const dir = mkdtempSync(join(tmpdir(), "magic-chat-smoke-"));
process.env.MAGIC_USER_DATA = dir;
const store = createStore(join(dir, "workspace.sqlite"));
const core = createCore(store, { fixture: fixture as unknown as CaptureBatch });
await core.execute({ type: "fixture" });
store.setConsent!({ action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION }, new Date().toISOString());
store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true, shareStudentWork: true });
const command = resolveCli("claude");
if (!command) throw new Error("claude is not on PATH");
const packs: { name: string; scope: PackScope }[] = [];
const chat = createClaudeChat({
  store,
  session: async (endpoint) => createChatSession({ command, workDir: dir, model: CHAT_MODEL, ...endpoint }),
  pack: async (name, scope) => (packs.push({ name, scope }), { status: "recorded", message: "Cards request recorded by the smoke (pack not run)." }),
});
const questions = process.argv.slice(2).length ? process.argv.slice(2) : ["what course should I take next?", "make flashcards on induction"];
const warmStart = Date.now();
await chat.warm();
console.log(`warm: ${Date.now() - warmStart} ms (CLI started, 0 tokens)`);
try {
  for (const q of questions) {
    const started = Date.now();
    let first: number | null = null;
    const tools: string[] = [];
    const r = await chat.ask(q, {
      signal: new AbortController().signal,
      timeoutMs: 240_000,
      onText: () => void (first ??= Date.now() - started),
      onTool: (t) => tools.push(t),
    });
    console.log(`\nQ: ${q}`);
    if (r.status !== "answer") {
      console.log(`setup: ${r.reason}`);
      continue;
    }
    console.log(`turn ${r.turn} · first text ${first ?? "-"} ms · total ${Date.now() - started} ms · tools ${JSON.stringify(r.tools)} · tokens in ${r.usage.in} (cached ${r.usage.cached}) out ${r.usage.out}`);
    console.log(`sources: ${JSON.stringify(r.sources.map((s) => s.title))}`);
    console.log(`cards: ${JSON.stringify(r.cards)}`);
    console.log(`A: ${r.text.slice(0, 1200)}`);
  }
  console.log(`\npack calls: ${JSON.stringify(packs)}`);
  console.log(`receipts: ${JSON.stringify(store.receipts().filter((x) => x.recipient === "claude").map((x) => x.purpose))}`);
} finally {
  await chat.close();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
