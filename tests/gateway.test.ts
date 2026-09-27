import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  createGateway,
  type GatewayHandle,
  type GatewayOptions,
} from "../apps/gateway/src/gateway";
import {
  createTypeSafeEvaluate,
  type AssignmentKindResult,
  type Evaluate,
} from "../apps/gateway/src/typesafe";

const VALID_STATE = {
  course: "CS 300",
  title: "Problem Set 4: Recursion",
  text: "Implement and analyze three recursive algorithms covering base cases and recurrence relations.",
  policy: "AI tools are not permitted on graded problem sets.",
};

const FAKE_RESULT: AssignmentKindResult = {
  kind: "problem_set",
  probabilities: {
    essay: 0.01,
    problem_set: 0.9,
    quiz: 0.02,
    exam: 0.02,
    discussion: 0.01,
    project: 0.02,
    reading: 0.01,
    other: 0.01,
  },
  model: "jev-1.13.0",
  questionVersion: "assignment.kind.v1",
};

function fakeEvaluate(result: AssignmentKindResult = FAKE_RESULT): {
  fn: Evaluate;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const fn: Evaluate = async (state) => {
    calls.push(state);
    return result;
  };
  return { fn, calls };
}

async function withGateway(
  options: GatewayOptions,
  run: (ctx: { gateway: GatewayHandle; baseUrl: string }) => Promise<void>,
): Promise<void> {
  const gateway = createGateway({
    dbPath: ":memory:",
    log: () => {},
    // These tests exercise the assignment route; triage has its own suite.
    triage: async () => {
      throw new Error("triage is not exercised in this suite");
    },
    ...options,
  });
  try {
    await gateway.listening;
    const address = gateway.server.address();
    if (!address || typeof address !== "object")
      throw new Error("gateway did not bind a port");
    await run({ gateway, baseUrl: `http://127.0.0.1:${address.port}` });
  } finally {
    await gateway.close();
  }
}

async function enroll(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/devices`, { method: "POST" });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { token: string };
  assert.equal(typeof body.token, "string");
  assert.ok(body.token.length > 20);
  return body.token;
}

function judgmentRequest(
  baseUrl: string,
  token: string | undefined,
  state: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}/v1/judgments/assignment.kind.v1`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ state }),
  });
}

test("GET /health responds without authentication", async () => {
  await withGateway({ evaluate: fakeEvaluate().fn }, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });
});

test("POST /v1/devices issues a bearer token for an empty body", async () => {
  await withGateway({ evaluate: fakeEvaluate().fn }, async ({ baseUrl }) => {
    await enroll(baseUrl);
  });
});

test("POST /v1/devices rejects a non-empty body", async () => {
  await withGateway({ evaluate: fakeEvaluate().fn }, async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/v1/devices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hint: "not allowed" }),
    });
    assert.equal(res.status, 422);
  });
});

test("happy path: returns the injected fake evaluator result unmodified", async () => {
  const { fn, calls } = fakeEvaluate();
  await withGateway({ evaluate: fn }, async ({ baseUrl }) => {
    const token = await enroll(baseUrl);
    const res = await judgmentRequest(baseUrl, token, VALID_STATE);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      kind: FAKE_RESULT.kind,
      probabilities: FAKE_RESULT.probabilities,
      model: FAKE_RESULT.model,
      questionVersion: FAKE_RESULT.questionVersion,
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], VALID_STATE);
  });
});

test("rejects requests with no Authorization header and never calls the evaluator", async () => {
  const { fn, calls } = fakeEvaluate();
  await withGateway({ evaluate: fn }, async ({ baseUrl }) => {
    const res = await judgmentRequest(baseUrl, undefined, VALID_STATE);
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });
});

test("rejects an unknown/invalid bearer token and never calls the evaluator", async () => {
  const { fn, calls } = fakeEvaluate();
  await withGateway({ evaluate: fn }, async ({ baseUrl }) => {
    const res = await judgmentRequest(baseUrl, "not-a-real-token", VALID_STATE);
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });
});

test("enforces the assignment state schema strictly", async () => {
  const { fn, calls } = fakeEvaluate();
  await withGateway({ evaluate: fn }, async ({ baseUrl }) => {
    const token = await enroll(baseUrl);

    const missingField = await judgmentRequest(baseUrl, token, {
      course: "CS 300",
      title: "t",
      text: "x",
    });
    assert.equal(missingField.status, 422);

    const unknownKey = await judgmentRequest(baseUrl, token, {
      ...VALID_STATE,
      tool: "search the web",
    });
    assert.equal(unknownKey.status, 422);

    const tooLongTitle = await judgmentRequest(baseUrl, token, {
      ...VALID_STATE,
      title: "x".repeat(501),
    });
    assert.equal(tooLongTitle.status, 422);

    assert.equal(calls.length, 0);
  });
});

test("rejects oversized bodies even when Content-Length is missing (chunked)", async () => {
  const { fn, calls } = fakeEvaluate();
  await withGateway(
    { evaluate: fn, limits: { maxBodyBytes: 256 } },
    async ({ baseUrl, gateway }) => {
      const token = await enroll(baseUrl);
      const address = gateway.server.address();
      if (!address || typeof address !== "object")
        throw new Error("no address");

      const status = await new Promise<number>((resolve, reject) => {
        const socket = connect(address.port, "127.0.0.1", () => {
          const headers =
            `POST /v1/judgments/assignment.kind.v1 HTTP/1.1\r\n` +
            `Host: 127.0.0.1\r\n` +
            `Authorization: Bearer ${token}\r\n` +
            `Content-Type: application/json\r\n` +
            `Transfer-Encoding: chunked\r\n` +
            `Connection: close\r\n\r\n`;
          socket.write(headers);
          const bigChunk = JSON.stringify({
            state: { ...VALID_STATE, text: "y".repeat(5000) },
          });
          socket.write(
            `${bigChunk.length.toString(16)}\r\n${bigChunk}\r\n0\r\n\r\n`,
          );
        });
        let raw = "";
        socket.on("data", (chunk) => {
          raw += chunk.toString("utf8");
        });
        socket.on("end", () => {
          const statusLine = raw.split("\r\n")[0] ?? "";
          const match = /HTTP\/1\.1 (\d+)/.exec(statusLine);
          resolve(match ? Number(match[1]) : 0);
        });
        socket.on("error", reject);
      });

      assert.equal(status, 413);
      assert.equal(calls.length, 0);
    },
  );
});

test("rejects oversized bodies even when Content-Length lies about the size", async () => {
  const { fn, calls } = fakeEvaluate();
  await withGateway(
    { evaluate: fn, limits: { maxBodyBytes: 256 } },
    async ({ baseUrl, gateway }) => {
      const token = await enroll(baseUrl);
      const address = gateway.server.address();
      if (!address || typeof address !== "object")
        throw new Error("no address");

      const payload = JSON.stringify({
        state: { ...VALID_STATE, text: "z".repeat(5000) },
      });
      const status = await new Promise<number>((resolve, reject) => {
        const socket = connect(address.port, "127.0.0.1", () => {
          const headers =
            `POST /v1/judgments/assignment.kind.v1 HTTP/1.1\r\n` +
            `Host: 127.0.0.1\r\n` +
            `Authorization: Bearer ${token}\r\n` +
            `Content-Type: application/json\r\n` +
            // Lies: claims a tiny body while actually sending a large one.
            `Content-Length: 5\r\n` +
            `Connection: close\r\n\r\n`;
          socket.write(headers + payload);
        });
        let raw = "";
        socket.on("data", (chunk) => {
          raw += chunk.toString("utf8");
        });
        socket.on("end", () => {
          const statusLine = raw.split("\r\n")[0] ?? "";
          const match = /HTTP\/1\.1 (\d+)/.exec(statusLine);
          resolve(match ? Number(match[1]) : 0);
        });
        socket.on("error", () => resolve(0));
        socket.setTimeout(2000, () => socket.destroy());
      });

      // Node's own HTTP parser treats the declared Content-Length as the
      // message boundary, so it either rejects the malformed framing outright
      // or the gateway's own byte-counted limit rejects the body; either way
      // the oversized payload must never reach the schema/evaluator as 200.
      assert.notEqual(status, 200);
      assert.equal(calls.length, 0);
    },
  );
});

test("blocks a request over the per-device hourly limit without calling the evaluator", async () => {
  const { fn, calls } = fakeEvaluate();
  await withGateway(
    {
      evaluate: fn,
      limits: {
        deviceHourlyLimit: 1,
        deviceDailyLimit: 10,
        globalDailyRequestLimit: 10,
      },
    },
    async ({ baseUrl }) => {
      const token = await enroll(baseUrl);

      const first = await judgmentRequest(baseUrl, token, VALID_STATE);
      assert.equal(first.status, 200);
      assert.equal(calls.length, 1);

      const second = await judgmentRequest(baseUrl, token, VALID_STATE);
      assert.equal(second.status, 429);
      const body = (await second.json()) as {
        error: string;
        retryAfterSeconds: number;
      };
      assert.equal(body.error, "device_hourly_limit");
      assert.equal(typeof body.retryAfterSeconds, "number");
      assert.equal(
        second.headers.get("retry-after"),
        String(body.retryAfterSeconds),
      );
      // Blocked request must not have reached the evaluator.
      assert.equal(calls.length, 1);
    },
  );
});

test("sanitizes upstream evaluator failures instead of reflecting raw errors", async () => {
  const calls: unknown[] = [];
  const failing: Evaluate = async (state) => {
    calls.push(state);
    throw new Error(
      'upstream said: secret-debug-header=abc123 body={"leak":true}',
    );
  };
  await withGateway({ evaluate: failing }, async ({ baseUrl }) => {
    const token = await enroll(baseUrl);
    const res = await judgmentRequest(baseUrl, token, VALID_STATE);
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, "upstream_error");
    assert.ok(!body.message.includes("secret-debug-header"));
    assert.ok(!body.message.includes("leak"));
    // The attempt still counted against budget even though it failed.
    assert.equal(calls.length, 1);
  });
});

test("the global daily budget is enforced atomically and durably across a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-test-"));
  const dbPath = join(dir, "gateway.sqlite");
  try {
    const first = fakeEvaluate();
    let token = "";
    await withGateway(
      {
        dbPath,
        evaluate: first.fn,
        limits: {
          globalDailyRequestLimit: 1,
          deviceDailyLimit: 10,
          deviceHourlyLimit: 10,
        },
      },
      async ({ baseUrl }) => {
        token = await enroll(baseUrl);
        const res = await judgmentRequest(baseUrl, token, VALID_STATE);
        assert.equal(res.status, 200);
        assert.equal(first.calls.length, 1);
      },
    );

    const second = fakeEvaluate();
    await withGateway(
      {
        dbPath,
        evaluate: second.fn,
        limits: {
          globalDailyRequestLimit: 1,
          deviceDailyLimit: 10,
          deviceHourlyLimit: 10,
        },
      },
      async ({ baseUrl }) => {
        const res = await judgmentRequest(baseUrl, token, VALID_STATE);
        assert.equal(res.status, 429);
        const body = (await res.json()) as { error: string };
        assert.equal(body.error, "global_daily_limit");
        // The budget survived the restart; the new process's evaluator was
        // never invoked for the blocked request.
        assert.equal(second.calls.length, 0);
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createGateway fails closed when no API key or evaluate override is given", () => {
  assert.throws(() => createGateway({ dbPath: ":memory:" }));
  // Each judgment needs a real credential or an explicit test override; one override
  // never makes the other route start without a key.
  assert.throws(
    () => createGateway({ dbPath: ":memory:", evaluate: fakeEvaluate().fn }),
    /triage/,
  );
  assert.throws(
    () =>
      createGateway({
        dbPath: ":memory:",
        triage: async () => {
          throw new Error("unused");
        },
      }),
    /evaluate/,
  );
});

test("client enrollment with {} and empty assignment description are accepted", async () => {
  const { fn, calls } = fakeEvaluate();
  await withGateway({ evaluate: fn }, async ({ baseUrl }) => {
    const enrolled = await fetch(`${baseUrl}/v1/devices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(enrolled.status, 201);
    assert.equal(enrolled.headers.get("cache-control"), "no-store");
    const { token } = (await enrolled.json()) as { token: string };
    assert.equal(
      (await judgmentRequest(baseUrl, token, { ...VALID_STATE, text: "" }))
        .status,
      200,
    );
    assert.equal(calls.length, 1);
  });
});

test("invalid distributions or mismatched winning choices never leave the gateway", async () => {
  for (const result of [
    {
      ...FAKE_RESULT,
      probabilities: { ...FAKE_RESULT.probabilities, essay: -0.01 },
    },
    {
      ...FAKE_RESULT,
      probabilities: { ...FAKE_RESULT.probabilities, essay: 0.5 },
    },
    { ...FAKE_RESULT, kind: "essay" as const },
    { ...FAKE_RESULT, model: "untrusted response content" },
  ]) {
    await withGateway(
      { evaluate: fakeEvaluate(result).fn },
      async ({ baseUrl }) => {
        const token = await enroll(baseUrl);
        const response = await judgmentRequest(baseUrl, token, VALID_STATE);
        assert.equal(response.status, 502);
        assert.deepEqual(await response.json(), {
          error: "upstream_error",
          message: "The judgment service is temporarily unavailable.",
        });
      },
    );
  }
});

test("enrollment caps use the real connection address despite changing forwarded headers", async () => {
  await withGateway(
    { evaluate: fakeEvaluate().fn, limits: { enrollHourlyLimitPerIp: 1 } },
    async ({ baseUrl }) => {
      await enroll(baseUrl);
      const response = await fetch(`${baseUrl}/v1/devices`, {
        method: "POST",
        headers: {
          "x-forwarded-for": "203.0.113.8",
          "x-real-ip": "198.51.100.9",
        },
      });
      assert.equal(response.status, 429);
      assert.equal(
        ((await response.json()) as { error: string }).error,
        "enrollment_hourly_limit",
      );
    },
  );
});

test("a failed upstream attempt consumes the global request budget", async () => {
  let calls = 0;
  await withGateway(
    {
      evaluate: async () => {
        calls++;
        throw Error("failure");
      },
      limits: { globalDailyRequestLimit: 1 },
    },
    async ({ baseUrl }) => {
      const token = await enroll(baseUrl);
      assert.equal(
        (await judgmentRequest(baseUrl, token, VALID_STATE)).status,
        502,
      );
      assert.equal(
        (await judgmentRequest(baseUrl, token, VALID_STATE)).status,
        429,
      );
      assert.equal(calls, 1);
    },
  );
});

test("a cancelled client retains its concurrency slot until evaluation actually settles", async () => {
  let release!: (value: AssignmentKindResult) => void;
  let started!: () => void;
  let aborted!: () => void;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  const didAbort = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const evaluate: Evaluate = async (_state, signal) => {
    signal!.addEventListener("abort", aborted, { once: true });
    started();
    return await new Promise<AssignmentKindResult>((resolve) => {
      release = resolve;
    });
  };
  await withGateway({ evaluate }, async ({ baseUrl }) => {
    const token = await enroll(baseUrl);
    const controller = new AbortController();
    const first = fetch(`${baseUrl}/v1/judgments/assignment.kind.v1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ state: VALID_STATE }),
      signal: controller.signal,
    });
    const rejection = assert.rejects(first);
    await didStart;
    controller.abort();
    await rejection;
    await didAbort;
    try {
      const blocked = await judgmentRequest(baseUrl, token, VALID_STATE);
      assert.equal(blocked.status, 429);
      assert.equal(
        ((await blocked.json()) as { error: string }).error,
        "device_concurrency_limit",
      );
    } finally {
      release(FAKE_RESULT);
    }
  });
});

test("operator revocation persists; raw device bearer tokens are not stored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-revoke-"));
  const dbPath = join(dir, "gateway.sqlite");
  try {
    let token = "";
    await withGateway(
      { dbPath, evaluate: fakeEvaluate().fn },
      async ({ baseUrl, gateway }) => {
        token = await enroll(baseUrl);
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const row = db.prepare("SELECT id, token_hash FROM devices").get() as {
          id: string;
          token_hash: string;
        };
        db.close();
        assert.notEqual(row.token_hash, token);
        assert.match(row.token_hash, /^[a-f0-9]{64}$/);
        assert.equal(gateway.revokeDevice(row.id), true);
        assert.equal(
          (await judgmentRequest(baseUrl, token, VALID_STATE)).status,
          401,
        );
      },
    );
    await withGateway(
      { dbPath, evaluate: fakeEvaluate().fn },
      async ({ baseUrl }) => {
        assert.equal(
          (await judgmentRequest(baseUrl, token, VALID_STATE)).status,
          401,
        );
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logs never include arbitrary URL paths or student state", async () => {
  const events: unknown[] = [];
  await withGateway(
    { evaluate: fakeEvaluate().fn, log: (event) => events.push(event) },
    async ({ baseUrl }) => {
      await fetch(`${baseUrl}/private-path-token?email=private-email`);
      const token = await enroll(baseUrl);
      await judgmentRequest(baseUrl, token, VALID_STATE);
      const serialized = JSON.stringify(events);
      for (const privateValue of [
        token,
        "private-path-token",
        "private-email",
        VALID_STATE.text,
        VALID_STATE.title,
      ]) {
        assert.ok(!serialized.includes(privateValue));
      }
      assert.ok(serialized.includes("/unrecognized"));
    },
  );
});

function wireResult() {
  return {
    model: FAKE_RESULT.model,
    answers: {
      kind: {
        type: "choice",
        choice: FAKE_RESULT.kind,
        confidence: 0.9,
        probabilities: FAKE_RESULT.probabilities,
      },
    },
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

test("TypeSafe request pins the model and question, disables redirects, and parses the documented response", async () => {
  let calls = 0;
  const evaluate = createTypeSafeEvaluate(
    "synthetic-key",
    1000,
    async (input, init) => {
      calls++;
      assert.equal(input, "https://api.typesafe.ai/v1/systemone");
      assert.equal(init!.redirect, "error");
      const body = JSON.parse(init!.body as string);
      assert.equal(body.model, "jev-1.13.0");
      assert.deepEqual(body.state, VALID_STATE);
      assert.deepEqual(
        Object.keys(body.questions.kind.criteria),
        Object.keys(FAKE_RESULT.probabilities),
      );
      return Response.json(wireResult());
    },
  );
  assert.deepEqual(await evaluate(VALID_STATE), FAKE_RESULT);
  assert.equal(calls, 1);
});

test("TypeSafe response size is bounded even without Content-Length", async () => {
  const evaluate = createTypeSafeEvaluate(
    "synthetic-key",
    1000,
    async () => new Response(" ".repeat(65537)),
  );
  await assert.rejects(
    evaluate(VALID_STATE),
    /Judgment upstream request failed/,
  );
});

test("TypeSafe timeout includes a body that stalls after successful headers", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
    // Deliberately never finish. Native fetch must abort the body reader.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const evaluate = createTypeSafeEvaluate(
      "synthetic-key",
      50,
      async (_input, init) => fetch(`http://127.0.0.1:${address.port}`, init),
    );
    await assert.rejects(
      evaluate(VALID_STATE),
      /Judgment upstream request failed/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("simultaneous devices share one atomic global reservation", async () => {
  const { fn, calls } = fakeEvaluate();
  await withGateway(
    { evaluate: fn, limits: { globalDailyRequestLimit: 1 } },
    async ({ baseUrl }) => {
      const tokens = await Promise.all([enroll(baseUrl), enroll(baseUrl)]);
      const responses = await Promise.all(
        tokens.map((token) => judgmentRequest(baseUrl, token, VALID_STATE)),
      );
      assert.deepEqual(
        responses.map((response) => response.status).sort(),
        [200, 429],
      );
      assert.equal(calls.length, 1);
    },
  );
});
