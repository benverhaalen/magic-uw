import test from "node:test";
import assert from "node:assert/strict";
import { createLocalCourseExtractor } from "../packages/ai/src/course-extraction.ts";
import type { LocalCommandRunner } from "../packages/ai/src/local.ts";

const digest = "a".repeat(64);
const run: LocalCommandRunner = async (_, args) => args[0] === "--version" ? "llmfit 1.1.16" : JSON.stringify({ models: [{
  name: "Example/Learner", ollama_name: "learner:3b", score: 90, fit_level: "good", runtime: "llama.cpp",
  best_quant: "Q4_K_M", usable_context: 4096, effective_context_length: 4096,
  memory_required_gb: 3, memory_available_gb: 8, license: "apache-2.0", estimated_tps: 30, estimate_confidence: "estimated",
}] });
const source = { id: "source-1", contentHash: "b".repeat(64), text: "Topics include trees and graphs. AI may be used only for brainstorming.", kind: "material" as const, externalId: "syllabus" };
const input = { inputHash: "c".repeat(64), resources: [source] };
const quote = "Topics include trees and graphs.";
const candidate = { kind: "topic", resourceId: source.id, contentHash: source.contentHash, start: 0, end: quote.length, quote, value: quote, label: "Topics" };
function fake(output: unknown, opts: { cloud?: boolean; changed?: boolean; remote?: boolean; model?: string; doneReason?: string; raw?: string } = {}) {
  const calls: { path: string; body: any }[] = [];
  let tags = 0;
  const fetcher: typeof fetch = async (url, init = {}) => {
    assert.ok(String(url).startsWith("http://127.0.0.1:11434/api/"));
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    const path = new URL(String(url)).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path === "/api/status") return Response.json({ cloud: { disabled: !opts.cloud } });
    if (path === "/api/tags") return Response.json({ models: [{ name: "learner:3b", model: "learner:3b", digest: opts.changed && ++tags > 1 ? "d".repeat(64) : digest, size: 100, details: { format: "gguf", quantization_level: "Q4_K_M" } }] });
    if (path === "/api/show") return Response.json({ details: { format: "gguf", quantization_level: "Q4_K_M" }, model_info: { "general.architecture": "test" }, capabilities: ["completion"] });
    if (path === "/api/chat") return Response.json({ model: opts.model ?? "learner:3b", done: true, done_reason: opts.doneReason ?? "stop", ...(opts.remote ? { remote_host: "https://example.org" } : {}), message: { role: "assistant", content: opts.raw ?? JSON.stringify(output) } });
    throw new Error("Unexpected call");
  };
  return { fetcher, calls };
}

test("local course extraction performs verified structured call, exact anchoring and version binding", async () => {
  const runtime = fake({ candidates: [candidate] });
  const extractor = createLocalCourseExtractor({ fetcher: runtime.fetcher, run });
  assert.equal(runtime.calls.length, 0);
  const result = await extractor.extract(input);
  assert.deepEqual(result?.candidates, [candidate]);
  assert.equal(result?.inputHash, input.inputHash);
  assert.ok(result?.extractorVersion.includes(digest));
  const body = runtime.calls.find(c => c.path === "/api/chat")!.body;
  assert.equal(body.format.type, "object");
  assert.equal(body.options.temperature, 0);
  assert.equal(body.truncate, false);
  assert.equal(body.tools, undefined);
  assert.match(body.messages[0].content, /untrusted reference data/);
  assert.ok(!body.messages[0].content.includes(source.text));
});

test("rejects invented quotes, hashes, scalar interpretations and policy grants; preserves valid rows as partial", async () => {
  const runtime = fake({ candidates: [candidate,
    { ...candidate, quote: "Invented", value: "Invented" },
    { ...candidate, contentHash: "wrong" },
    { ...candidate, value: "Final exam is 80%" },
    { ...candidate, policyMode: "allowed" },
  ] });
  const result = await createLocalCourseExtractor({ fetcher: runtime.fetcher, run }).extract(input);
  assert.equal(result?.candidates.length, 1);
  assert.equal(result?.coverage?.rejectedCandidates, 4);
  assert.equal(result?.coverage?.status, "partial");
});

test("recovers unique source positions in code; ambiguous repeated quotes abstain", async () => {
  const wrongPosition = { ...candidate, start: 1, end: 2 };
  const runtime = fake({ candidates: [wrongPosition] });
  const client = createLocalCourseExtractor({ fetcher: runtime.fetcher, run });
  assert.deepEqual((await client.extract(input))?.candidates, [candidate]);
  const repeated = await client.extract({ ...input, resources: [{ ...source, text: `${quote} ${quote}` }] });
  assert.equal(repeated?.candidates.length, 0);
});

test("bounded excerpt never silently claims whole-source coverage and no student submissions are forwarded", async () => {
  const runtime = fake({ candidates: [] });
  const result = await createLocalCourseExtractor({ fetcher: runtime.fetcher, run }).extract({ ...input, resources: [
    { ...source, text: "x".repeat(7000) },
    { ...source, id: "student-data", externalId: "submission", text: "PRIVATE-STUDENT-TEXT" },
  ] });
  assert.equal(result?.coverage?.status, "partial");
  assert.deepEqual(result?.coverage?.omittedResourceIds, [source.id]);
  assert.ok(!JSON.stringify(runtime.calls).includes("PRIVATE-STUDENT-TEXT"));
  const sent = JSON.parse(runtime.calls.find(c => c.path === "/api/chat")!.body.messages[1].content);
  assert.equal(sent.sources[0].text.length, 6000);
});

test("unavailable, changed, remote, unexpected and invalid or truncated model responses yield no batch", async () => {
  for (const opts of [{ cloud: true }, { changed: true }, { remote: true }, { model: "other" }, { doneReason: "length" }, { raw: "not json" }, { raw: "x".repeat(33000) }]) {
    const runtime = fake({ candidates: [candidate] }, opts);
    assert.equal(await createLocalCourseExtractor({ fetcher: runtime.fetcher, run }).extract(input), null);
    if (opts.cloud || opts.changed) assert.ok(runtime.calls.every(c => c.path !== "/api/chat"));
  }
});

test("pre-aborted extraction makes no calls and cancellation propagates after response", async () => {
  const runtime = fake({ candidates: [candidate] });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createLocalCourseExtractor({ fetcher: runtime.fetcher, run }).extract(input, controller.signal));
  assert.equal(runtime.calls.length, 0);
  const during = new AbortController();
  const fetcher: typeof fetch = async (...args) => {
    const result = await runtime.fetcher(...args);
    if (String(args[0]).endsWith("/chat")) during.abort();
    return result;
  };
  await assert.rejects(createLocalCourseExtractor({ fetcher, run }).extract(input, during.signal));
});
