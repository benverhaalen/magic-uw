import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createStore } from "@magic/storage";
import {
  defaultPrivacy,
  type McpGrant,
  type ResourceInput,
  type Store,
} from "@magic/contracts";
import { createMcpService } from "../packages/core/src/mcp";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { restrictToCurrentUser } from "../apps/desktop/src/mcp-connection-acl";

const at = (minute: number) =>
  new Date(Date.UTC(2099, 0, 1, 12, minute)).toISOString();
const body =
  "The microscopy report must compare the experimental result with the control.";
const rawMarker = "RAW_HTML_NOT_FOR_MCP";
const gradeMarker = "PRIVATE_GRADE";
const commentMarker = "PRIVATE_INSTRUCTOR_COMMENT";
const localMarker = "LOCAL_DOWNLOAD_PATH_NOT_FOR_MCP";
const rubricMarker = "UNSELECTED_RUBRIC_METADATA";
const item = (
  id = "lab",
  extra: Partial<ResourceInput> = {},
): ResourceInput => ({
  externalId: id,
  kind: "assignment",
  courseId: "course",
  courseName: "Biology 101",
  title: "Microscopy report",
  url: `https://canvas.example.test/courses/1/assignments/${id}`,
  text: body,
  rawHtml: `<p>${rawMarker}</p>`,
  deadlines: [
    {
      value: at(60),
      kind: "due",
      quote: "Report due at 1 p.m.",
      authority: "structured",
      scopeConfirmed: true,
    },
  ],
  points: 10,
  submitted: true,
  policy: { mode: "unknown", evidence: "" },
  parts: [
    {
      page: 2,
      section: "Report instructions",
      start: 0,
      end: body.length,
      text: body,
    },
  ],
  document: {
    localPath: `/private/${localMarker}.pdf`,
    pages: [{ page: 2, text: body, anchor: "page-2" }],
  },
  rubric: [{ description: rubricMarker, points: 10 }],
  submission: {
    workflowState: "graded",
    score: 7.125,
    grade: gradeMarker,
    comments: [{ text: commentMarker, createdAt: at(0) }],
  },
  ...extra,
});
function ingest(
  store: Store,
  minute: number,
  resources: ResourceInput[],
  accountScope = "account",
  courseId = "course",
  scope = "assignments",
) {
  return store.ingest({
    source: {
      id: `${accountScope}/${courseId}/${scope}`,
      label: `${courseId} ${scope}`,
      kind: "canvas",
      accountScope,
      courseId,
      scope,
    },
    observedAt: at(minute),
    status: "ok",
    complete: true,
    readId: `read-${minute}-${scope}`,
    resources,
  });
}
function fixture(
  recipient: McpGrant["recipient"] = "local",
  categories: McpGrant["categories"] = ["course_text"],
) {
  const dir = mkdtempSync(join(tmpdir(), "magic-mcp-test-"));
  const databasePath = join(dir, "local.sqlite");
  const store = createStore(databasePath);
  const token = randomBytes(32).toString("hex");
  const grant: McpGrant = {
    id: "client",
    label: "Test client",
    recipient,
    enabled: true,
    courses: [{ accountScope: "account", courseId: "course" }],
    categories,
    tokenHash: createHash("sha256").update(token).digest("hex"),
  };
  store.setMcpGrant(grant);
  ingest(store, 0, [item()]);
  const service = createMcpService(
    store,
    grant.id,
    token,
    () => new Date(at(0)),
  );
  return {
    dir,
    databasePath,
    store,
    token,
    grant,
    service,
    async cleanup() {
      await service.server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Projection = {
  id: string;
  title: string;
  text: string;
  grade?: unknown;
  comments?: unknown;
  parts?: { page?: number; text: string }[];
  citation: {
    url: string;
    observedAt: string;
    version: number;
    [key: string]: unknown;
  };
};
const json = (value: unknown) => JSON.stringify(value);

test("MCP projects only selected evidence and citations; local comment access still requires a category grant", async () => {
  const f = fixture();
  try {
    const resource = f.store.resources()[0];
    const result = f.service.call("get_item", {
      id: resource.id,
    }) as Projection;
    assert.equal(result.text, body);
    assert.equal(result.citation.url, resource.url);
    assert.equal(result.citation.version, resource.version);
    assert.equal(result.citation.observedAt, at(0));
    assert.equal(result.parts![0].page, 2);
    assert.equal(result.parts![0].text, body);
    for (const marker of [
      rawMarker,
      gradeMarker,
      commentMarker,
      localMarker,
      rubricMarker,
      "rawHtml",
      "localPath",
      "accountScope",
      "tokenHash",
    ])
      assert.equal(json(result).includes(marker), false, marker);
    assert.equal(f.store.privacy().shareComments, false);
    f.store.setMcpGrant({
      ...f.grant,
      categories: ["course_text", "comments"],
    });
    const comments = f.service.call("get_item", {
      id: resource.id,
    }) as Projection;
    assert.ok(json(comments.comments).includes(commentMarker));
    assert.equal(comments.grade, undefined);
    assert.equal(f.store.resources()[0].contentHash, resource.contentHash);
    assert.equal(f.store.resources()[0].completed, false);
  } finally {
    await f.cleanup();
  }
});

test("hosted comments and grades need independent global opt-ins and provider selection", async () => {
  const f = fixture("claude", ["course_text", "comments", "grades"]);
  try {
    const id = f.store.resources()[0].id;
    assert.throws(
      () => f.service.call("get_item", { id }),
      /Sharing is disabled/,
    );
    // T06: a hosted recipient needs its own consent record as well as the settings.
    f.store.setConsent!(
      { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION },
      at(0),
    );
    f.store.setPrivacy({
      ...defaultPrivacy,
      mode: "selective_cloud",
      hostedProvider: "claude",
      shareCourseText: true,
    });
    const courseOnly = f.service.call("get_item", { id }) as Projection;
    assert.equal(courseOnly.comments, undefined);
    assert.equal(courseOnly.grade, undefined);
    f.store.setPrivacy({ ...f.store.privacy(), shareComments: true });
    const comments = f.service.call("get_item", { id }) as Projection;
    assert.ok(json(comments.comments).includes(commentMarker));
    assert.equal(comments.grade, undefined);
    f.store.setPrivacy({ ...f.store.privacy(), shareGrades: true });
    assert.ok(
      json((f.service.call("get_item", { id }) as Projection).grade).includes(
        gradeMarker,
      ),
    );
    f.store.setPrivacy({ ...f.store.privacy(), hostedProvider: "gemini" });
    assert.throws(() => f.service.call("search", {}), /Sharing is disabled/);
    f.store.setPrivacy({
      ...f.store.privacy(),
      mode: "local_only",
      hostedProvider: "claude",
    });
    assert.throws(() => f.service.call("search", {}), /Sharing is disabled/);
  } finally {
    await f.cleanup();
  }
});

test("token, account, course, category, and revocation are checked again on every read", async () => {
  const f = fixture();
  try {
    ingest(f.store, 0, [item("foreign-account")], "other-account");
    ingest(
      f.store,
      0,
      [item("foreign-course", { courseId: "other-course" })],
      "account",
      "other-course",
    );
    ingest(
      f.store,
      0,
      [item("message", { kind: "message", text: "PRIVATE_ANNOUNCEMENT" })],
      "account",
      "course",
      "messages",
    );
    ingest(
      f.store,
      0,
      [
        item("commit", {
          gitlab: {
            projectId: "project",
            evidenceKind: "commit",
            submissionEvidence: true,
          },
          text: "PRIVATE_STUDENT_COMMIT",
        }),
      ],
      "account",
      "course",
      "gitlab",
    );
    const search = f.service.call("search", {}) as Projection[];
    assert.equal(search.length, 1);
    assert.equal(search[0].text, body);
    for (const resource of f.store
      .resources()
      .filter((r) => r.id !== search[0].id))
      assert.throws(
        () => f.service.call("get_item", { id: resource.id }),
        /permissions/,
      );
    const wrong = createMcpService(f.store, f.grant.id, "incorrect-token");
    try {
      assert.throws(() => wrong.call("search", {}), /revoked/);
    } finally {
      await wrong.server.close();
    }
    f.store.setMcpGrant({ ...f.grant, courses: [] });
    assert.deepEqual(f.service.call("search", {}), []);
    f.store.setMcpGrant({ ...f.grant, enabled: false });
    assert.throws(() => f.service.call("search", {}), /revoked/);
    f.store.setMcpGrant({
      ...f.grant,
      tokenHash: createHash("sha256").update("new-token").digest("hex"),
    });
    assert.throws(() => f.service.call("search", {}), /revoked/);
    f.store.setMcpGrant(f.grant);
    f.store.setCourseOverride({
      accountScope: "account",
      courseId: "course",
      included: false,
    });
    assert.deepEqual(f.service.call("search", {}), []);
    f.store.setCourseOverride({
      accountScope: "account",
      courseId: "course",
      included: true,
    });
    assert.equal((f.service.call("search", {}) as Projection[]).length, 1);
  } finally {
    await f.cleanup();
  }
});

test("recent changes expose dates without leaking old/new grades, comments or requirement text", async () => {
  const f = fixture();
  try {
    ingest(f.store, 1, [
      item("lab", {
        dueAt: at(120),
        text: "PRIVATE_CHANGED_REQUIREMENTS",
        submission: {
          workflowState: "graded",
          score: 99.625,
          grade: "PRIVATE_NEW_GRADE",
          comments: [{ text: "PRIVATE_NEW_COMMENT" }],
        },
      }),
    ]);
    const result = f.service.call("recent_changes", {}) as {
      type: string;
      oldValues?: unknown;
      newValues?: unknown;
    }[];
    assert.ok(result.some((e) => e.type === "graded"));
    assert.ok(result.some((e) => e.type === "requirements_changed"));
    assert.ok(result.some((e) => e.type === "date_changed"));
    for (const marker of [
      "99.625",
      "7.125",
      gradeMarker,
      commentMarker,
      "PRIVATE_NEW_GRADE",
      "PRIVATE_NEW_COMMENT",
      "PRIVATE_CHANGED_REQUIREMENTS",
      rawMarker,
    ])
      assert.equal(json(result).includes(marker), false, marker);
    for (const event of result.filter((e) => e.type !== "date_changed")) {
      assert.equal(event.oldValues, undefined);
      assert.equal(event.newValues, undefined);
    }
  } finally {
    await f.cleanup();
  }
});

test("recent changes retain removed events for a permitted course and exclude foreign removals", async () => {
  const f = fixture();
  try {
    ingest(f.store, 0, [item("foreign")], "other-account");
    const own = f.store.resources().find((r) => r.externalId === "lab")!;
    const foreign = f.store
      .resources()
      .find((r) => r.externalId === "foreign")!;
    ingest(f.store, 1, []);
    ingest(f.store, 1, [], "other-account");
    const events = f.service.call("recent_changes", {}) as {
      type: string;
      resourceId: string;
    }[];
    assert.ok(
      events.some((e) => e.type === "removed" && e.resourceId === own.id),
    );
    assert.equal(
      events.some((e) => e.resourceId === foreign.id),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("answers return source passages containing the match and exact source citations even late in a document", async () => {
  const f = fixture();
  try {
    const passage =
      "Use the zebrafishcontrol protocol for the microscopy result.";
    const longText = "Background context. ".repeat(600) + passage;
    ingest(f.store, 1, [
      item("lab", { text: longText, parts: [{ page: 12, text: passage }] }),
    ]);
    const result = f.service.call("answer_course_question", {
      query: "What zebrafishcontrol protocol is required?",
    }) as { mode: string; evidence: Projection[] };
    assert.equal(result.mode, "source_passages");
    assert.equal(result.evidence.length, 1);
    const evidence = result.evidence[0];
    assert.ok(evidence.text.includes("zebrafishcontrol"));
    assert.ok(longText.includes(evidence.text));
    assert.equal(evidence.citation.observedAt, at(1));
    assert.equal(evidence.citation.version, 2);
    assert.equal(evidence.citation.url, f.store.resources()[0].url);
    const empty = f.service.call("answer_course_question", {
      query: "unrelatedastronomyxyz",
    }) as { evidence: unknown[] };
    assert.deepEqual(empty.evidence, []);
    const due = f.service.call("due_soon", { days: 1 }) as Projection[];
    assert.equal(due.length, 1);
  } finally {
    await f.cleanup();
  }
});

function parseToolResult(result: unknown): unknown {
  const envelope = result as {
    isError?: boolean;
    content?: { type: string; text?: string }[];
  };
  assert.notEqual(envelope.isError, true);
  const first = envelope.content?.find((c) => c.type === "text");
  assert.ok(first?.text);
  return JSON.parse(first.text);
}

test(
  "official SDK v2 connects over real child stdio, lists only read tools, calls evidence tools and applies live revocation",
  { timeout: 15000 },
  async () => {
    const f = fixture();
    const configPath = join(f.dir, "connection.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        databasePath: f.databasePath,
        clientId: f.grant.id,
        token: f.token,
      }),
      { mode: 0o600 },
    );
    await restrictToCurrentUser(configPath);
    const client = new Client({
      name: "Synthetic MCP integration client",
      version: "1.0.0",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        resolve("apps/desktop/src/mcp-server.ts"),
        "--connection",
        configPath,
      ],
      cwd: resolve("."),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    try {
      await client.connect(transport, { timeout: 5000 });
      const tools = await client.listTools();
      assert.deepEqual(
        new Set(tools.tools.map((t) => t.name)),
        new Set([
          "search",
          "due_soon",
          "recent_changes",
          "course_overview",
          "get_item",
          "answer_course_question",
        ]),
      );
      for (const tool of tools.tools) {
        assert.equal(tool.annotations?.readOnlyHint, true);
        assert.equal(tool.annotations?.destructiveHint, false);
      }
      const search = parseToolResult(
        await client.callTool({
          name: "search",
          arguments: { query: "microscopy" },
        }),
      ) as Projection[];
      assert.equal(search.length, 1);
      const result = parseToolResult(
        await client.callTool({
          name: "get_item",
          arguments: { id: search[0].id },
        }),
      ) as Projection;
      assert.equal(result.text, body);
      assert.equal(result.citation.version, 1);
      for (const marker of [
        f.token,
        rawMarker,
        localMarker,
        gradeMarker,
        commentMarker,
      ])
        assert.equal(json(result).includes(marker), false);
      const answer = parseToolResult(
        await client.callTool({
          name: "answer_course_question",
          arguments: { query: "microscopy control" },
        }),
      ) as { mode: string; evidence: Projection[] };
      assert.equal(answer.mode, "source_passages");
      assert.equal(answer.evidence[0].citation.url, item().url);
      f.store.setMcpGrant({ ...f.grant, enabled: false });
      const blocked = await client.callTool({
        name: "get_item",
        arguments: { id: search[0].id },
      });
      assert.equal(blocked.isError, true);
      assert.equal(json(blocked).includes(body), false);
      assert.equal(stderr.includes(f.token), false);
      assert.equal(f.store.resources()[0].completed, false);
      assert.equal(f.store.resources()[0].version, 1);
    } finally {
      await client.close();
      await transport.close();
      await f.cleanup();
    }
  },
);

test("course overview includes failed empty scopes so missing captures cannot imply full coverage", async () => {
  const f = fixture();
  try {
    f.store.ingest({
      source: {
        id: "account/course/pages",
        label: "Course pages",
        kind: "canvas",
        accountScope: "account",
        courseId: "course",
        scope: "pages",
      },
      observedAt: at(1),
      complete: false,
      status: "needs_sign_in",
      resources: [],
    });
    const overview = f.service.call("course_overview", {
      courseId: "course",
    }) as {
      coverage: {
        source: string;
        status: string;
        complete: boolean;
        lastSuccessAt: string | null;
      }[];
    };
    const missing = overview.coverage.find((s) => s.source === "Course pages");
    assert.ok(missing);
    assert.equal(missing.status, "needs_sign_in");
    assert.equal(missing.complete, false);
    assert.equal(missing.lastSuccessAt, null);
  } finally {
    await f.cleanup();
  }
});

test(
  "stdio endpoint rejects a broadly readable connection file without exposing its token",
  { timeout: 10000 },
  async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    const path = join(f.dir, "unsafe-connection.json");
    writeFileSync(
      path,
      JSON.stringify({
        databasePath: f.databasePath,
        clientId: f.grant.id,
        token: f.token,
      }),
      { mode: 0o644 },
    );
    chmodSync(path, 0o644);
    const client = new Client({ name: "Unsafe config test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        resolve("apps/desktop/src/mcp-server.ts"),
        "--connection",
        path,
      ],
      cwd: resolve("."),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    try {
      await assert.rejects(client.connect(transport, { timeout: 3000 }));
      assert.equal(stderr.includes(f.token), false);
      assert.equal(stderr.includes(f.databasePath), false);
      assert.match(stderr, /could not open its local connection/);
    } finally {
      await client.close();
      await transport.close();
      await f.cleanup();
    }
  },
);
