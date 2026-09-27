import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeAuth, parseCodexLogin } from "../apps/desktop/src/clients/auth-parse.ts";

test("auth parsing keeps only the sign-in state, method and plan", () => {
  const parsed = parseClaudeAuth(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "student@example.edu", orgName: "Org" }));
  assert.deepEqual(parsed, { signedIn: true, method: "subscription", plan: "max" });
  assert.ok(!JSON.stringify(parsed).includes("example.edu"));
  assert.deepEqual(parseClaudeAuth('{"loggedIn":false}'), { signedIn: false, method: null, plan: null });
  assert.deepEqual(parseClaudeAuth("garbage"), { signedIn: null, method: null, plan: null });
  assert.deepEqual(parseCodexLogin("Logged in using ChatGPT", 0), { signedIn: true, method: "chatgpt", plan: null });
  assert.deepEqual(parseCodexLogin("Logged in using an API key - sk-proj-***", 0), { signedIn: true, method: "api_key", plan: null });
  assert.deepEqual(parseCodexLogin("Not logged in", 1), { signedIn: false, method: null, plan: null });
});
