/**
 * T06 spy test: consent comes before any network request, and maySend enforces it.
 *
 * Every network edge is a counting fake. Main's channels (source-fetch, planning-public-read,
 * evaluate) are simulated exactly as main.ts wires them: `consentGateAllows(channel, records)`
 * decides first, and a refusal reaches the worker as an error. Direct worker-side public
 * reads use the worker's own wiring, `createWorkerClients` (apps/desktop/src/worker-clients.ts),
 * over a counting fake in place of `createPublicClient`. Nothing here opens a real socket; the Electron
 * `webRequest` spy belongs to the live trial.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureBatchSchema,
  commandSchema,
  defaultPrivacy,
  type CaptureBatch,
  type ConsentRecord,
  type ContextManifest,
  type PrivacyPreferences,
  type Store,
} from "@magic/contracts";
import {
  CONSENT_DISCLOSURE_VERSION,
  consentRecordsKey,
  maySend,
  withConsents,
} from "@magic/domain";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import {
  consentGateAllows,
  createEgressPolicy,
  egressFor,
  payloadHash,
  type ConsentGatedChannel,
} from "../packages/core/src/egress";
import { createIngestion } from "../apps/desktop/src/ingestion";
import { createWorkerClients } from "../apps/desktop/src/worker-clients";
import { createSyntheticCanvasUniversity } from "../packages/connectors/src/canvas-fixture";
import {
  MaterialReadError,
  type PublicClient,
} from "../packages/connectors/src/network";
import { pullPublicSubjects } from "../packages/connectors/src/planning-public";
import fixture from "../fixtures/course.json";

const origin = "https://canvas.wisc.edu";
const at = "2026-09-26T12:00:00.000Z";
const sample = captureBatchSchema.parse(fixture);
const hosted = ["jev", "chatgpt", "codex", "claude", "gemini", "openrouter"] as const;
const channels: ConsentGatedChannel[] = [
  "magic:signin",
  "magic:sync",
  "magic:planning-sync",
  "source-fetch",
  "planning-public-read",
  "planning-refresh",
  "evaluate",
];
const record = (
  recipient: ConsentRecord["recipient"],
  disclosureVersion = CONSENT_DISCLOSURE_VERSION,
): ConsentRecord => ({ recipient, disclosureVersion, grantedAt: at });
const grant = (recipient: ConsentRecord["recipient"]) => ({
  type: "consent" as const,
  value: {
    action: "grant" as const,
    recipient,
    disclosureVersion: CONSENT_DISCLOSURE_VERSION,
  },
});
const everything: PrivacyPreferences = {
  ...defaultPrivacy,
  mode: "selective_cloud",
  jevEnabled: true,
  hostedProvider: "claude",
  shareCourseText: true,
  shareStudentWork: true,
  shareGrades: true,
  shareComments: true,
  shareCommunications: true,
  sharePlanning: true,
  shareHolds: true,
  shareAudit: true,
};

/** A Canvas capture as "Import capture" would load it: a course with an external link. */
function canvasCapture(): CaptureBatch {
  return captureBatchSchema.parse({
    source: {
      id: "canvas:course:101",
      label: "Imported capture",
      kind: "canvas",
      accountScope: "synthetic-account",
      courseId: "101",
      scope: "course",
    },
    observedAt: "2026-09-26T10:00:00Z",
    complete: true,
    status: "ok",
    resources: [
      {
        externalId: "course-101",
        kind: "course",
        courseId: "101",
        courseName: "SYNTH 101",
        title: "SYNTH 101",
        url: `${origin}/courses/101`,
        text: "Course site: https://courses.synthetic.test/101/",
        links: ["https://courses.synthetic.test/101/"],
        deadlines: [],
        points: null,
        submitted: null,
        policy: { mode: "unknown", evidence: "" },
        course: { courseCode: "SYNTH 101" },
      },
    ],
  });
}

/**
 * The network as the worker sees it through main, plus the direct public client. Every
 * request that would leave the machine is pushed onto `requests`.
 */
function network(store: Store) {
  const requests: string[] = [];
  const university = createSyntheticCanvasUniversity({ origin, rateLimit: false });
  const records = () => store.consents!();
  const refused = (channel: ConsentGatedChannel) => !consentGateAllows(channel, records());
  const direct: PublicClient = {
    isCanvas: (url) => new URL(url).origin === origin,
    async get(url) {
      requests.push(`direct ${url}`);
      throw new MaterialReadError("not_found");
    },
    async text(url) {
      requests.push(`direct ${url}`);
      throw new MaterialReadError("not_found");
    },
    async feed(url) {
      requests.push(`direct ${url}`);
      throw new MaterialReadError("not_found");
    },
    async signedDownload(url) {
      requests.push(`direct ${url}`);
      throw new MaterialReadError("not_found");
    },
  };
  return {
    requests,
    // main.ts `source-fetch`: gate first; a refusal reaches the worker as an error.
    async canvasFetch(url: string, init?: RequestInit) {
      if (refused("source-fetch")) throw new Error("Source read unavailable");
      requests.push(`canvas ${url}`);
      return university.fetch(url, init);
    },
    // main.ts `planning-public-read`.
    planningHttp: {
      async read(request: unknown) {
        if (refused("planning-public-read")) throw new Error("Source read unavailable");
        requests.push(`planning ${JSON.stringify(request)}`);
        return { status: "failed" as const, code: "synthetic" };
      },
    },
    // main.ts `evaluate` in front of a counting Jev gateway.
    gateway: {
      calls: 0,
      async evaluate(payload: unknown) {
        if (refused("evaluate")) throw new Error("Judgment unavailable");
        this.calls++;
        requests.push(`jev ${JSON.stringify(payload).length}`);
        return {
          kind: "essay" as const,
          probabilities: {
            essay: 0.97, problem_set: 0.005, quiz: 0.005, exam: 0.005,
            discussion: 0.005, project: 0.005, reading: 0.005, other: 0,
          },
          model: "synthetic-model",
          questionVersion: "assignment.kind.v1" as const,
        };
      },
    },
    // What `createPublicClient` would return in the worker: every call is counted.
    direct: () => direct,
  };
}

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "magic-egress-"));
  const store = createStore(join(directory, "workspace.sqlite"));
  store.setIngestionSettings({
    ...store.ingestionSettings(),
    jitterRatio: 0,
    quietHours: { enabled: false, start: 1, end: 6 },
  });
  const net = network(store);
  // Wired exactly as worker.ts wires them.
  const clients = createWorkerClients(store, net.direct);
  const core = createCore(store, {
    fixture: sample,
    gateway: net.gateway,
    planningHttp: net.planningHttp as never,
    planningPublicClient: clients.core,
  });
  const ingestion = createIngestion(store, {
    directory,
    client: clients.ingestion,
    canvasFetch: (url, init) => net.canvasFetch(url, init),
    secrets: async () => ({}),
  });
  return {
    store,
    core,
    ingestion,
    net,
    clients,
    async close() {
      await ingestion.stop();
      await core.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("main's gate refuses every channel until the setup record, and Jev until its own", () => {
  for (const channel of channels) {
    assert.equal(consentGateAllows(channel, undefined), false, channel);
    assert.equal(consentGateAllows(channel, []), false, channel);
    // An agreement to an earlier disclosure is not current.
    assert.equal(consentGateAllows(channel, [record("uw", "setup-2025-01-01"), record("jev", "setup-2025-01-01")]), false, channel);
  }
  for (const channel of channels.filter((c) => c !== "evaluate"))
    assert.equal(consentGateAllows(channel, [record("uw")]), true, channel);
  assert.equal(consentGateAllows("evaluate", [record("uw")]), false);
  assert.equal(consentGateAllows("evaluate", [record("jev")]), true);
});

test("before the setup record, 0 requests leave: refresh, ingestion, planning reads and the Jev drain", async () => {
  const w = workspace();
  try {
    // Hosted settings fully on, but no agreement recorded.
    w.store.setPrivacy(everything);
    await w.core.execute({ type: "fixture" });
    await w.core.settled();
    // A Canvas source makes the background coordinator run instead of skipping.
    w.store.ingest(canvasCapture());
    const background = await w.ingestion.tick("background");
    const manual = await w.ingestion.tick("manual");
    assert.ok(background && manual, "the coordinator ran both ticks");
    await assert.rejects(
      w.core.execute({ type: "planning-search", subjectCode: "266", termCode: "1272", page: 1 }),
    );
    await assert.rejects(pullPublicSubjects(w.clients.planning, at));
    const assignment = w.store.resources().find((r) => r.kind === "assignment")!;
    const enrich = await w.core.execute({ type: "enrich", id: assignment.id });
    assert.equal(enrich.manifest?.allowed, false);
    await w.core.settled();
    assert.equal(w.net.requests.length, 0, w.net.requests.join(" | "));
    assert.equal(w.net.gateway.calls, 0);
    assert.ok(w.store.receipts().every((r) => r.status !== "sent"));
    assert.equal(w.store.receipts().filter((r) => r.status === "blocked").length, 1);
  } finally {
    await w.close();
  }
});

test("after the setup checkbox, reads proceed; Jev still waits for its own agreement", async () => {
  const w = workspace();
  try {
    await w.core.execute(grant("uw"));
    const run = await w.ingestion.tick("manual");
    assert.equal(run?.action, "refreshed");
    assert.equal(run?.needsSignIn, false);
    assert.ok(w.net.requests.some((r) => r.startsWith("canvas ")));
    assert.ok(w.store.resources().some((r) => r.kind === "assignment"));
    w.store.setPrivacy(everything);
    w.core.wake();
    await w.core.settled();
    assert.equal(w.net.gateway.calls, 0, "no Jev send without the jev record");
    await w.core.execute(grant("jev"));
    await w.core.settled();
    assert.ok(w.net.gateway.calls > 0, "Jev sends once agreed");
  } finally {
    await w.close();
  }
});

test("a Canvas capture imported before the checkbox triggers no network read", async () => {
  const w = workspace();
  try {
    await w.core.execute({ type: "import", batch: canvasCapture() });
    await w.ingestion.tick("background");
    await w.ingestion.tick("manual");
    await w.core.settled();
    assert.equal(w.net.requests.length, 0, w.net.requests.join(" | "));
    // The same capture after agreement does reach its public course site (the control).
    await w.core.execute(grant("uw"));
    await w.ingestion.tick("manual");
    assert.ok(w.net.requests.some((r) => r.startsWith("direct https://courses.synthetic.test/")));
  } finally {
    await w.close();
  }
});

test("local mode makes 0 Jev or provider requests across a full synthetic sync", async () => {
  const w = workspace();
  try {
    for (const recipient of ["uw", ...hosted] as const) await w.core.execute(grant(recipient));
    w.store.setPrivacy({ ...everything, mode: "local_only" });
    const run = await w.ingestion.tick("manual");
    assert.equal(run?.action, "refreshed");
    w.core.wake();
    await w.core.settled();
    for (const r of w.store.resources().filter((r) => r.kind === "assignment"))
      await w.core.execute({ type: "enrich", id: r.id });
    await w.core.settled();
    assert.equal(w.net.gateway.calls, 0);
    assert.ok(!w.net.requests.some((r) => r.startsWith("jev ")));
    const privacy = w.store.privacy();
    for (const recipient of hosted)
      assert.equal(maySend(privacy, recipient, ["course_text"]).allowed, false, recipient);
    assert.ok(w.store.receipts().every((r) => r.status !== "sent"));
  } finally {
    await w.close();
  }
});

test("maySend refuses a hosted recipient without its own current consent record", () => {
  for (const recipient of hosted) {
    const p = { ...everything, hostedProvider: recipient === "jev" ? "claude" : recipient } as PrivacyPreferences;
    assert.match(maySend(p, recipient, ["course_text"]).reason, /not agreed/);
    const others = hosted.filter((r) => r !== recipient).map((r) => record(r));
    assert.equal(maySend(withConsents(p, [record("uw"), ...others]), recipient, ["course_text"]).allowed, false);
    assert.equal(maySend(withConsents(p, [record(recipient, "setup-2025-01-01")]), recipient, ["course_text"]).allowed, false);
    assert.equal(maySend(withConsents(p, [record(recipient)]), recipient, ["course_text"]).allowed, true);
  }
  assert.equal(maySend(defaultPrivacy, "local", ["course_text"]).allowed, true);
});

test("maySend refuses planning, holds and audit for every non-local recipient, whatever the flags", () => {
  const all = (["uw", ...hosted] as const).map((r) => record(r));
  for (const recipient of hosted)
    for (const category of ["planning", "holds", "audit"]) {
      const p = withConsents(
        { ...everything, hostedProvider: recipient === "jev" ? "claude" : recipient },
        all,
      );
      assert.equal(maySend(p, recipient, ["course_text"]).allowed, true, "the control");
      const result = maySend(p, recipient, [category, "course_text"]);
      assert.equal(result.allowed, false, `${recipient} ${category}`);
      assert.match(result.reason, /never leave this device/);
    }
  for (const category of ["planning", "holds", "audit"])
    assert.equal(maySend(everything, "local", [category]).allowed, true);
});

test("consent is written only by the consent command; the privacy command cannot write it", async () => {
  const w = workspace();
  try {
    assert.throws(() =>
      commandSchema.parse({ type: "privacy", value: { ...everything, consents: [record("claude")] } }),
    );
    await assert.rejects(
      w.core.execute({ type: "privacy", value: { ...everything, consents: [record("claude")] } }),
    );
    // What storage attaches for maySend never crosses spread, JSON or IPC cloning.
    await w.core.execute(grant("claude"));
    const privacy = w.store.privacy();
    assert.equal(maySend(privacy, "claude", ["course_text"]).allowed, false, "settings still off");
    assert.equal(Object.keys({ ...privacy }).includes("consents"), false);
    assert.equal(JSON.stringify(privacy).includes("claude\",\"disclosure"), false);
    assert.equal((structuredClone(privacy) as never as Record<symbol, unknown>)[consentRecordsKey], undefined);
    await w.core.execute({ type: "privacy", value: { ...privacy, ...everything } });
    assert.equal(maySend(w.store.privacy(), "claude", ["course_text"]).allowed, true);
    const snapshot = w.core.snapshot();
    assert.deepEqual(snapshot.consents?.map((r) => r.recipient), ["claude"]);
    assert.equal(snapshot.consents?.[0]?.disclosureVersion, CONSENT_DISCLOSURE_VERSION);
    // A stale disclosure is refused; a revoke takes effect on the next check.
    await assert.rejects(
      w.core.execute({ type: "consent", value: { action: "grant", recipient: "jev", disclosureVersion: "setup-2025-01-01" } }),
      /out of date/,
    );
    await w.core.execute({ type: "consent", value: { action: "revoke", recipient: "claude" } });
    assert.equal(maySend(w.store.privacy(), "claude", ["course_text"]).allowed, false);
    assert.deepEqual(w.core.snapshot().consents, []);
  } finally {
    await w.close();
  }
});

function sensitiveWorkspace() {
  const store = createStore(":memory:");
  const core = createCore(store, { fixture: sample });
  return { store, core };
}
async function manifestFor(
  store: Store,
  core: ReturnType<typeof createCore>,
  categories: string[],
  text: string,
): Promise<ContextManifest> {
  if (!store.resources().length) await core.execute({ type: "fixture" });
  const resourceIds = [store.resources()[0]!.id];
  const payload = { course: "Writing 101", title: "Draft", text, policy: "" };
  const permission = maySend(store.privacy(), "claude", categories);
  return {
    recipient: "claude",
    purpose: "Study help",
    categories,
    resourceIds,
    characters: JSON.stringify(payload).length,
    ...permission,
    payload,
  };
}

test("the first send of each sensitive category is held for a preview; a matching ack allows exactly that payload", async () => {
  const { store, core } = sensitiveWorkspace();
  try {
    await core.execute(grant("claude"));
    store.setPrivacy(everything);
    const policy = egressFor(store);
    for (const category of ["student_work", "grades", "comments", "communications"]) {
      const manifest = await manifestFor(store, core, [category], `${category} body`);
      assert.equal(manifest.allowed, true);
      const held = policy.check(manifest, { at });
      assert.equal(held.status, "preview_required", category);
      if (held.status !== "preview_required") continue;
      assert.equal(held.payloadHash, payloadHash(manifest.payload));
      assert.deepEqual(held.payload, manifest.payload);
      assert.equal(store.receipts().find((r) => r.id === held.previewId)?.status, "preview_required");
      // Asking again for the same payload reuses the preview and writes no second receipt.
      const receipts = store.receipts().length;
      assert.equal(policy.check(manifest, { at }).status, "preview_required");
      assert.equal(store.receipts().length, receipts);
      // A wrong hash is refused and changes nothing.
      await assert.rejects(
        core.execute({ type: "preview.ack", value: { id: held.previewId, payloadHash: "0".repeat(64), decision: "send" } }),
        /no longer matches/,
      );
      await core.execute({ type: "preview.ack", value: { id: held.previewId, payloadHash: held.payloadHash, decision: "send" } });
      // A different payload in the same category is not covered by that approval.
      const other = await manifestFor(store, core, [category], `${category} changed`);
      assert.equal(policy.check(other, { at }).status, "preview_required");
      // Exactly the approved payload passes, once.
      assert.deepEqual(policy.check(manifest, { at }), { status: "allowed", payloadHash: held.payloadHash });
      policy.record(manifest, "sent", at);
      // After that first send, the category no longer needs a preview for this recipient.
      assert.equal(policy.check(other, { at }).status, "allowed");
    }
    // Course text alone never needs a preview.
    const plain = await manifestFor(store, core, ["course_text"], "course text");
    assert.equal(policy.check(plain, { at }).status, "allowed");
  } finally {
    await core.close();
  }
});

test("declining a preview sends nothing and writes blocked; a background caller waits without prompting", async () => {
  const { store, core } = sensitiveWorkspace();
  try {
    await core.execute(grant("claude"));
    store.setPrivacy(everything);
    const policy = createEgressPolicy(store);
    const manifest = await manifestFor(store, core, ["grades"], "grade details");
    const held = policy.check(manifest, { at, background: true });
    assert.equal(held.status, "preview_required");
    if (held.status !== "preview_required") return;
    assert.equal(held.prompt, false);
    assert.equal(policy.acknowledge({ id: held.previewId, payloadHash: held.payloadHash, decision: "decline" }, at), "Nothing was sent.");
    const blocked = () => store.receipts().filter((r) => r.status === "blocked").length;
    assert.equal(blocked(), 1);
    assert.equal(policy.check(manifest, { at }).status, "preview_required");
    assert.ok(store.receipts().every((r) => r.status !== "sent"));
    // A refused send writes a blocked receipt.
    store.setPrivacy({ ...everything, shareGrades: false });
    const refused = await manifestFor(store, core, ["grades"], "grade details");
    assert.equal(policy.check(refused, { at }).status, "blocked");
    assert.equal(blocked(), 2);
  } finally {
    await core.close();
  }
});

test("always preview requires a preview every time, even after a category was sent", async () => {
  const { store, core } = sensitiveWorkspace();
  try {
    await core.execute(grant("claude"));
    store.setPrivacy({ ...everything, alwaysPreview: true });
    const policy = createEgressPolicy(store);
    const manifest = await manifestFor(store, core, ["course_text"], "course text");
    for (let round = 0; round < 3; round++) {
      const held = policy.check(manifest, { at });
      assert.equal(held.status, "preview_required", `round ${round}`);
      if (held.status !== "preview_required") return;
      policy.acknowledge({ id: held.previewId, payloadHash: held.payloadHash, decision: "send" }, at);
      assert.equal(policy.check(manifest, { at }).status, "allowed");
      policy.record(manifest, "sent", at);
    }
    assert.equal(store.receipts().filter((r) => r.status === "sent").length, 3);
  } finally {
    await core.close();
  }
});

test("the worker's own public clients read nothing before the checkbox, then read after it", async () => {
  const w = workspace();
  try {
    await w.core.execute({ type: "import", batch: canvasCapture() });
    await w.ingestion.tick("background");
    await assert.rejects(pullPublicSubjects(w.clients.planning, at), /consent_required/);
    for (const client of [w.clients.ingestion, w.clients.planning, w.clients.core])
      await assert.rejects(client.get("https://courses.synthetic.test/101/"), /consent_required/);
    assert.equal(w.clients.consented(), false);
    assert.equal(w.net.requests.length, 0, w.net.requests.join(" | "));
    await w.core.execute(grant("uw"));
    assert.equal(w.clients.consented(), true);
    await assert.rejects(pullPublicSubjects(w.clients.planning, at));
    assert.ok(w.net.requests.includes("direct https://registrar.wisc.edu/subjectareas/"));
    // Withdrawing closes them again.
    await w.core.execute({ type: "consent", value: { action: "revoke", recipient: "uw" } });
    const before = w.net.requests.length;
    await assert.rejects(w.clients.core.get("https://courses.synthetic.test/101/"), /consent_required/);
    assert.equal(w.net.requests.length, before);
  } finally {
    await w.close();
  }
});

test("a Jev send the drain refuses writes a blocked receipt", async () => {
  const w = workspace();
  try {
    for (const recipient of ["uw", "jev"] as const) await w.core.execute(grant(recipient));
    w.store.setPrivacy(everything);
    // Course text may go to Jev, but this course is excluded, so the drain's manifest is refused.
    await w.core.execute({
      type: "course-override",
      value: { accountScope: sample.source.accountScope, courseId: sample.source.courseId, included: false },
    });
    await w.core.execute({ type: "fixture" });
    await w.core.settled();
    assert.equal(w.net.gateway.calls, 0);
    const receipts = w.store.receipts();
    assert.equal(receipts.filter((r) => r.status === "blocked" && r.recipient === "jev").length, 1);
    assert.ok(receipts.every((r) => r.status !== "sent"));
  } finally {
    await w.close();
  }
});
