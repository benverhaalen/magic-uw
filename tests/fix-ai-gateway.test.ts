// Fix 5 (AI-path audit): an upstream 429 passes through as a 429 with Retry-After, and the
// reservation is refunded, so a rate-limited attempt does not spend the device's budget.
import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../apps/gateway/src/gateway";
import { createTypeSafeEvaluate, TYPESAFE_MODEL } from "../apps/gateway/src/typesafe";

const STATE = { course: "SYN 100", title: "Problem Set 1", text: "Solve five synthetic problems.", policy: "" };
const OK_BODY = {
  model: TYPESAFE_MODEL,
  answers: {
    kind: {
      type: "choice",
      choice: "problem_set",
      confidence: 0.93,
      probabilities: { essay: 0.01, problem_set: 0.93, quiz: 0.01, exam: 0.01, discussion: 0.01, project: 0.01, reading: 0.01, other: 0.01 },
    },
  },
};

test("fix-ai-gateway: an upstream 429 becomes a 429 with Retry-After and refunds the reservation", async () => {
  let upstream: () => Response = () => new Response("slow down", { status: 429, headers: { "retry-after": "120" } });
  const fetcher = (async () => upstream()) as unknown as typeof fetch;
  const gateway = createGateway({
    dbPath: ":memory:",
    log: () => {},
    evaluate: createTypeSafeEvaluate("synthetic-key", 5000, fetcher),
    limits: { deviceHourlyLimit: 1, deviceDailyLimit: 1 },
  });
  try {
    await gateway.listening;
    const address = gateway.server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const { token } = (await (await fetch(`${base}/v1/devices`, { method: "POST" })).json()) as { token: string };
    const ask = () =>
      fetch(`${base}/v1/judgments/assignment.kind.v1`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ state: STATE }),
      });
    const limited = await ask();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "120");
    assert.equal(((await limited.json()) as { error: string }).error, "upstream_rate_limited");
    // The budget is 1 per hour: the refunded attempt leaves it unspent.
    upstream = () => new Response(JSON.stringify(OK_BODY), { status: 200, headers: { "content-type": "application/json" } });
    const ok = await ask();
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(((await ok.json()) as { kind: string }).kind, "problem_set");
    assert.equal((await ask()).status, 429, "the successful call did spend the budget");
  } finally {
    await gateway.close();
  }
});
