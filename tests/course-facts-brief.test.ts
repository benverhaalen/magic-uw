// The course brief (syllabus.md): code-rendered, quote-verified, byte-stable; rebuilt only when its
// input changes; the first block of every pack prompt; read-only through the agent API; purged.
// Synthetic course text only.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { captureBatchSchema, defaultPrivacy, type EgressReceipt } from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { createReadApi } from "@magic/agent-api";
import { createModelRunner, type BackendCall } from "../packages/runner/src/index";
import { createPackHandler } from "../packages/core/src/pack-handler";
import { buildPrompt, memoryArtifactStore, packCatalogue } from "../packages/packs/core/src/index";
import { BRIEF_PREAMBLE, briefPath, createCourseBriefs, renderCourseBrief } from "../packages/core/src/course-facts/brief";

const at = "2026-09-26T12:00:00.000Z";
const course = { accountScope: "a", courseId: "c" };
const syllabus = (extra = "") =>
  [
    "PHIL 101 Syllabus",
    "Instructor",
    "Professor Ada Lovelace, office hours Tuesdays 2-4pm in Room 101.",
    "Email ada.lovelace@example.edu or call 608-555-0199.",
    "Course Texts",
    "The Republic, Plato (any translation).",
    "Schedule",
    "Week 1: What is philosophy?",
    "Week 2: Plato's cave.",
    "Grading breakdown",
    "Essays 40%",
    "Final exam 30%",
    "Exams",
    "The midterm is October 20; notes are not allowed.",
    "AI Policy",
    "Generative AI tools may be used for brainstorming only.",
    "Collaboration on essays is not permitted; Jo Park and other students must write alone.",
    ...Array.from({ length: 6 }, (_, i) => `Filler paragraph ${i + 1} about readings and weekly reflections, continued at length.`),
    extra,
  ].join("\n");
let tick = 0;
function ingest(store: ReturnType<typeof createStore>, text: string, observedAt = new Date(Date.parse(at) + tick++ * 1000).toISOString()) {
  store.ingest(
    captureBatchSchema.parse({
      source: { id: "syl", label: "Syllabus", kind: "canvas", scope: "syllabus", ...course },
      observedAt,
      status: "ok",
      complete: true,
      resources: [{ externalId: "syllabus", kind: "material", courseId: "c", courseName: "PHIL 101: Philosophy", title: "Syllabus", url: "https://canvas.example.edu/courses/c/assignments/syllabus", text }],
    }),
  );
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "magic-brief-"));
  const store = createStore(join(dir, "workspace.sqlite"));
  store.setConsent!({ action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION }, at);
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  store.recordAutoIdentity({ accountScope: "a", courseId: "c", authors: ["Jo Park"] });
  ingest(store, syllabus());
  return { dir, store, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("the brief: fixed sections, verified quotes, identifiers replaced, instructor kept", () => {
  const x = setup();
  const brief = renderCourseBrief(x.store, course)!;
  const t = brief.text;
  assert.match(t, /^<!-- course-brief\.v1 · course-intelligence\.v2 · sha256:[a-f0-9]{64} -->\n# PHIL 101: Philosophy\n/);
  const order = ["## Syllabus sources", "## Staff and office hours", "## Schedule", "## Assessments", "## Grading", "## AI and collaboration policy", "## Texts and materials"];
  const at_ = order.map((h) => t.indexOf(h));
  assert.ok(at_.every((i) => i > 0), t);
  assert.deepEqual([...at_].sort((a, b) => a - b), at_, "fixed section order");
  assert.match(t, /- "Essays 40%" \(Syllabus\)/);
  assert.match(t, /- "Week 2: Plato's cave\." \(Syllabus\)/);
  assert.match(t, /- "Generative AI tools may be used for brainstorming only\." \(Syllabus\)/);
  assert.match(t, /Professor Ada Lovelace, office hours/);
  assert.ok(!t.includes("Jo Park") && !t.includes("ada.lovelace@example.edu") && !t.includes("608-555-0199"), t);
  const source = x.store.resources()[0]!.text;
  for (const m of t.matchAll(/^- "(.+)" \(Syllabus\)$/gm)) {
    const shown = m[1]!.replace(/…$/, "");
    if (!/\[[A-Z_]+\d*\]|\[jo park\]/i.test(shown)) assert.ok(source.includes(shown), `verbatim: ${shown}`);
  }
  x.done();
});

test("stable bytes across rebuilds with unchanged input; a syllabus change changes the hash and the file", () => {
  const x = setup();
  const briefs = createCourseBriefs({ store: x.store, directory: x.dir });
  const first = briefs.courseBrief("a:c")!;
  const file = briefPath(x.dir, course);
  assert.equal(readFileSync(file, "utf8"), first.text);
  const mtime = statSync(file).mtimeMs;
  // A fresh process (new memo) and a re-ingest of identical content: same bytes, no rewrite.
  ingest(x.store, syllabus());
  const again = createCourseBriefs({ store: x.store, directory: x.dir }).courseBrief("a:c")!;
  assert.equal(again.text, first.text);
  assert.equal(again.hash, first.hash);
  assert.equal(statSync(file).mtimeMs, mtime, "unchanged bytes are not rewritten");
  assert.equal(renderCourseBrief(x.store, course)!.text, first.text);
  ingest(x.store, syllabus("Week 3: Aristotle."));
  const changed = briefs.courseBrief("a:c")!;
  assert.notEqual(changed.hash, first.hash);
  assert.match(readFileSync(file, "utf8"), /Week 3: Aristotle\./);
  x.done();
});

test("packs send the brief first, byte-identical across packs; purge removes the file", async () => {
  const x = setup();
  const calls: BackendCall[] = [];
  const runner = createModelRunner({
    backend: {
      client: "claude",
      async call(call) {
        calls.push(call);
        return { value: call.pack.id === "quiz" ? { items: [] } : { cards: [] }, usage: { in: 1, cached: 0, out: 1 }, model: "synthetic" };
      },
    },
  });
  const briefs = createCourseBriefs({ store: x.store, directory: x.dir });
  const handler = createPackHandler({ store: x.store as never, artifacts: memoryArtifactStore(), runner: () => runner, brief: briefs.courseBrief });
  await handler.run("cards", { courseId: "c" });
  await handler.run("quiz", { courseId: "c" });
  assert.ok(calls.length >= 2, `calls: ${calls.length}`);
  const brief = briefs.courseBrief("a:c")!;
  for (const call of calls) {
    assert.ok(call.systemPrompt.startsWith(`${BRIEF_PREAMBLE}\n\n<!-- course-brief.v1`));
    assert.ok(call.systemPrompt.includes(brief.text.split("\n")[1]!));
    assert.ok(call.input.startsWith("[ctx") || call.input.includes("## Task"), "the pack's own role text moves to the input");
  }
  assert.equal(new Set(calls.map((c) => c.systemPrompt)).size, 1, "one byte-identical prefix for every pack on the course");
  // The prefix is the brief, then the pack catalogue; the request names its pack.
  const system = calls[0]!.systemPrompt;
  assert.ok(system.indexOf("## Pack catalogue") > system.indexOf("<!-- course-brief.v1"));
  for (const id of ["cards@v1", "quiz@v1", "guide@v1", "intent-ask@v1"]) assert.ok(system.includes(`### ${id}`), id);
  assert.ok(calls.some((c) => c.input.includes("## Task\nPack cards@v1: follow its instructions in the pack catalogue.")));
  assert.ok(calls.some((c) => c.input.includes("## Task\nPack quiz@v1:")));
  assert.ok(existsSync(briefPath(x.dir, course)));
  briefs.purge();
  assert.ok(!existsSync(join(x.dir, "courses")));
  x.done();
});

test("agent API courseBrief: through the grant, scrubbed, with one receipt", () => {
  const x = setup();
  const token = "b".repeat(64);
  x.store.setMcpGrant({ id: "dev", label: "Study tool", recipient: "claude", enabled: true, courses: [course], categories: ["course_text"], tokenHash: createHash("sha256").update(token).digest("hex") });
  const receipts: EgressReceipt[] = [];
  const api = createReadApi(x.store, { clientId: "dev", token }, { recordReceipt: (r) => receipts.push(r) });
  const result = api.courseBrief({ courseId: "c" });
  assert.equal(result.brief.hash, renderCourseBrief(x.store, course)!.hash);
  assert.ok(result.brief.text.includes("Essays 40%"));
  assert.ok(!result.brief.text.includes("Jo Park"));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.purpose, "agent-api v1 courseBrief");
  assert.throws(() => api.courseBrief({ courseId: "other" }), /unavailable/);
  x.done();
});

test("buildPrompt: a listed pack is named, an unlisted one brings its own instructions; no brief keeps the old prompt", () => {
  const listed = { id: "listed", version: "v1", system: "Listed instructions." };
  const other = { id: "other", version: "v1", system: "Other instructions." };
  const pack = (p: typeof listed) => ({ ...p, tier: "pass" as const, template: () => "Go.", schema: null as never, cacheKey: () => null, categories: [] });
  const frame = { courseId: "a:c", course: "C", skeleton: "Course: C", policy: "unknown", brief: `Brief.\n\n${packCatalogue([listed])}` };
  const a = buildPrompt(pack(listed), frame, {}, []);
  assert.equal(a.systemPrompt, frame.brief);
  assert.match(a.input, /^## Task\nPack listed@v1: follow its instructions/);
  const b = buildPrompt(pack(other), frame, {}, []);
  assert.equal(b.systemPrompt, frame.brief);
  assert.match(b.input, /^## Task\nOther instructions\./);
  const { brief: _drop, ...plain } = frame;
  assert.ok(buildPrompt(pack(other), plain, {}, []).systemPrompt.startsWith("Other instructions."));
});
