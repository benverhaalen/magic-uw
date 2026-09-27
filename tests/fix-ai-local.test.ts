// Fix 7 (AI-path audit): local tutoring verifies the model once per session. The llmfit
// recommendation and the weight verification are cached; each later question keeps only the
// cloud-disabled and digest checks, and the model stays loaded for 10 minutes.
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalAi, OLLAMA_LOCAL_ORIGIN, type LocalCommandRunner } from "../packages/ai/src/local.ts";

const recommendation = {
  name: "Example/Learner-3B", ollama_name: "learner:3b", score: 85, fit_level: "Good", runtime: "llama.cpp", best_quant: "Q4_K_M",
  usable_context: 8192, effective_context_length: 4096, memory_required_gb: 3, memory_available_gb: 8, license: "apache-2.0",
  estimated_tps: 30, estimate_confidence: "estimated",
};
const installed = { name: "learner:3b", model: "learner:3b", digest: "a".repeat(64), size: 2_000_000_000, details: { format: "gguf", quantization_level: "Q4_K_M" } };
const input = {
  question: "Explain the evidence requirement.",
  policyMode: "unknown" as const,
  context: { course: "Synthetic writing", title: "Practice", text: "Support a claim with evidence.", policy: "" },
};

function fakes() {
  let commands = 0;
  let digest = installed.digest;
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const run: LocalCommandRunner = async (_file, args) => {
    commands++;
    return args[0] === "--version" ? "llmfit 1.1.16" : JSON.stringify({ system: { total_ram_gb: 16 }, models: [recommendation] });
  };
  const fetcher: typeof fetch = async (url, init = {}) => {
    const path = String(url).slice(`${OLLAMA_LOCAL_ORIGIN}/api`.length);
    calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
    if (path === "/status") return Response.json({ cloud: { disabled: true } });
    if (path === "/tags") return Response.json({ models: [{ ...installed, digest }] });
    if (path === "/show") return Response.json({ model_info: { "general.architecture": "synthetic" }, details: installed.details, capabilities: ["completion"] });
    if (path === "/chat") return Response.json({ model: installed.name, done: true, message: { role: "assistant", content: "What supports your claim?" } });
    throw new Error("Unexpected endpoint.");
  };
  return { run, fetcher, calls, commands: () => commands, swap: () => (digest = "b".repeat(64)) };
}

test("fix-ai-local: the second question skips llmfit and weight verification; only the cloud and digest checks remain", async () => {
  const f = fakes();
  const ai = createLocalAi({ fetcher: f.fetcher, run: f.run });
  await ai.generate(input);
  const firstCommands = f.commands();
  assert.ok(firstCommands > 0, "the first question runs llmfit");
  const before = f.calls.length;
  await ai.generate(input);
  assert.equal(f.commands(), firstCommands, "llmfit is not run again this session");
  assert.deepEqual(f.calls.slice(before).map((c) => c.path), ["/status", "/tags", "/chat"]);
  assert.equal(f.calls.find((c) => c.path === "/chat")!.body!.keep_alive, "10m");
});

test("fix-ai-local: a changed digest between questions is refused, and the next question verifies again", async () => {
  const f = fakes();
  const ai = createLocalAi({ fetcher: f.fetcher, run: f.run });
  await ai.generate(input);
  f.swap();
  const before = f.calls.length;
  await assert.rejects(ai.generate(input), /model changed/);
  assert.ok(!f.calls.slice(before).some((c) => c.path === "/chat"), "nothing was sent to the changed model");
  // The cache was dropped: the next question re-runs the full status check on the new weights.
  const again = f.calls.length;
  await ai.generate(input);
  assert.ok(f.calls.slice(again).some((c) => c.path === "/show"), "the new weights are verified before use");
});
