// owner: claude-chat (decisions.md, 2026-09-27). The in-app chat's persistent Claude Code session,
// driven by a fake CLI that calls the app's loopback read tools exactly as `--mcp-config` names them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "@magic/storage";
import { defaultPrivacy, type PackScope, type ResourceInput, type Store } from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION, maySend } from "@magic/domain";
import { createClaudeChat, CHAT_ALLOWED_TOOLS, parseChatReply, type ChatReply } from "../packages/core/src/chat/index";
import { createChatSession, chatSessionArgs, type CliCommand } from "../packages/runner/src/index";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-claude-chat.mjs")] };
const at = "2099-01-01T12:00:00.000Z";

const material = (id: string, courseId: string, title: string, text: string): ResourceInput => ({
  externalId: id,
  kind: "material",
  courseId,
  courseName: courseId === "math" ? "MATH 240" : "Secret seminar",
  title,
  url: `https://canvas.example.test/courses/${courseId}/pages/${id}`,
  text,
  deadlines: [],
  points: null,
  submitted: false,
  policy: { mode: "unknown", evidence: "" },
});
function ingest(store: Store, courseId: string, resources: ResourceInput[]) {
  store.ingest({
    source: { id: `account/${courseId}/pages`, label: `${courseId} pages`, kind: "canvas", accountScope: "account", courseId, scope: "pages" },
    observedAt: at,
    status: "ok",
    complete: true,
    readId: `read-${courseId}`,
    resources,
  });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "magic-claude-chat-"));
  const store = createStore(join(dir, "workspace.sqlite"));
  ingest(store, "math", [
    material("ind", "math", "Induction notes", "Mathematical induction proves a statement for every natural number: a base case and an inductive step."),
    material("rec", "math", "Recursion and induction", "Recursive definitions pair with induction proofs over the structure."),
  ]);
  ingest(store, "secret", [material("hidden", "secret", "Induction secrets", "Induction content from an excluded course.")]);
  store.setCourseOverride({ accountScope: "account", courseId: "secret", included: false });
  store.setConsent!({ action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION }, at);
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  const packs: { name: string; scope: PackScope }[] = [];
  const chat = createClaudeChat({
    store,
    session: async (endpoint) => createChatSession({ command: fake, workDir: dir, ...endpoint }),
    pack: async (name, scope) => {
      packs.push({ name, scope });
      return { status: "built", message: "Made 8 cards from 2 sources." };
    },
    now: () => new Date(at),
  });
  const ask = async (text: string, chunks: string[] = []) => {
    const r = await chat.ask(text, { signal: new AbortController().signal, onText: (c) => chunks.push(c), timeoutMs: 20_000 });
    assert.equal(r.status, "answer");
    return r as ChatReply;
  };
  const id = (externalId: string) => store.resources().find((r) => r.url.endsWith(`/${externalId}`))!.id;
  return {
    store, chat, packs, ask, id,
    async cleanup() {
      await chat.close();
      store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); // the killed CLI releases its folder a moment later on Windows
    },
  };
}

test("argv: only the app's read tools, built-in tools off, no other MCP server, no prompts, Opus 5.5 by default", () => {
  const args = chatSessionArgs({ prefixPath: "p.md", model: "claude-opus-5-5", mcpConfig: "{}", allowedTools: CHAT_ALLOWED_TOOLS });
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(after("--tools"), "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(after("--permission-mode"), "dontAsk");
  assert.equal(after("--model"), "claude-opus-5-5");
  assert.deepEqual(after("--allowedTools")!.split(","), CHAT_ALLOWED_TOOLS);
  assert.ok(CHAT_ALLOWED_TOOLS.every((t) => t.startsWith("mcp__magic__")));
  assert.ok(!args.includes("--safe-mode") && !args.includes("--dangerously-skip-permissions"));
});

test("one session answers two questions, streams its text, reads through the tools and cites checked sources", async () => {
  const f = fixture();
  try {
    const chunks: string[] = [];
    const first = await f.ask("what course should I take next?", chunks);
    const second = await f.ask("tell me about induction");
    const pid = /pid (\d+)/.exec(first.text)![1];
    assert.match(first.text, /^turn 1 pid \d+/);
    assert.match(second.text, new RegExp(`^turn 2 pid ${pid}`), "the same process kept the conversation");
    assert.ok(chunks.length > 1 && chunks.join("").startsWith("turn 1"), "text streamed in chunks");
    assert.deepEqual(second.tools, ["mcp__magic__search"]);
    assert.ok(second.sources.length >= 1);
    assert.ok(second.sources.every((s) => s.course === "MATH 240"), "only included courses are cited");
    assert.doesNotMatch(second.text, /SOURCES:/, "the code-read line is not shown");
    const receipts = f.store.receipts().filter((r) => r.recipient === "claude" && r.purpose === "MCP search");
    assert.ok(receipts.length >= 2, "a receipt per read");
    assert.ok(receipts.every((r) => !r.resourceIds.includes(f.id("hidden"))));
  } finally {
    await f.cleanup();
  }
});

test("reads are refused for an excluded course, and for the degree audit while its switch is off", async () => {
  const f = fixture();
  try {
    const excluded = await f.ask(`item ${f.id("hidden")}`);
    assert.match(excluded.text, /REFUSED/);
    const included = await f.ask(`item ${f.id("ind")}`);
    assert.match(included.text, /READ Induction notes/);
    assert.equal(maySend(f.store.privacy(), "claude", ["planning", "audit"]).allowed, false, "off by default");
    const off = await f.ask("what does my degree audit need?");
    assert.match(off.text, /REFUSED .*degree plan and audit stay on this device/i);
    assert.ok(!f.store.receipts().some((r) => r.purpose === "Chat degree_plan"), "no receipt: nothing was read");
    f.store.setPrivacy({ ...f.store.privacy(), sharePlanning: true, shareAudit: true });
    const on = await f.ask("what does my degree audit need?");
    assert.match(on.text, /AUDIT 0/);
    assert.ok(f.store.receipts().some((r) => r.purpose === "Chat degree_plan" && r.categories.includes("audit")));
    assert.equal(maySend(f.store.privacy(), "claude", ["holds"]).allowed, false, "holds never leave the device");
  } finally {
    await f.cleanup();
  }
});

test("a flashcard request runs the existing cards pack for the found course and items; Claude writes no cards", async () => {
  const f = fixture();
  try {
    const r = await f.ask("make flashcards on induction");
    assert.equal(f.packs.length, 1);
    assert.equal(f.packs[0]!.name, "cards");
    assert.equal(f.packs[0]!.scope.courseId, "math");
    assert.ok(f.packs[0]!.scope.resourceIds!.includes(f.id("ind")));
    assert.ok(!f.packs[0]!.scope.resourceIds!.includes(f.id("hidden")));
    assert.equal(r.cards?.status, "built");
    assert.doesNotMatch(r.text, /ACTION:/);
  } finally {
    await f.cleanup();
  }
});

test("a flashcard action naming an excluded course is refused by code", async () => {
  assert.deepEqual(parseChatReply("Sure.\nACTION: cards course=secret items=a,b").cards, { courseId: "secret", resourceIds: ["a", "b"] });
  const f = fixture();
  const packs: string[] = [];
  const stub = createClaudeChat({
    store: f.store,
    session: async () => ({
      ask: async () => ({ text: `Sure.\nACTION: cards course=secret items=${f.id("hidden")}`, tools: [], usage: { in: 0, cached: 0, out: 0 }, ms: 1, turn: 1, sessionPid: null }),
      close: () => undefined,
    }),
    pack: async (name) => (packs.push(name), { status: "built", message: "" }),
  });
  try {
    const r = (await stub.ask("make flashcards from the secret seminar", { signal: new AbortController().signal })) as ChatReply;
    assert.equal(r.cards?.status, "refused");
    assert.deepEqual(packs, [], "no pack ran");
  } finally {
    await stub.close();
    await f.cleanup();
  }
});

test("any other tool stops the session and fails the question", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.ask("rogue"), (e: Error & { kind?: string }) => e.kind === "tool_use_blocked");
    const next = await f.ask("tell me about induction");
    assert.match(next.text, /^turn 1 /, "the next question starts a new session");
  } finally {
    await f.cleanup();
  }
});
