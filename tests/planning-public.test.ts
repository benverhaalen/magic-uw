import test from "node:test";
import assert from "node:assert/strict";
import { parsePublicSubjects, parsePublicTerms, pullPublicTerms, parseGuideSubject, guideSubjectSlug, pullGuideForSubject } from "../packages/connectors/src/planning-public";
import { createCore } from "@magic/core";
import { createStore } from "@magic/storage";
import { captureBatchSchema } from "@magic/contracts";
import type { PublicClient } from "../packages/connectors/src/network";
import fixture from "../fixtures/course.json";

const at = "2026-09-26T12:00:00Z";
// Synthetic markup modeled on the published Registrar/Guide structure, not student captures.
const subjectsHtml = `<table><tr><th>Code</th><th>Short</th><th>Formal</th></tr><tr><td>266</td><td>COMP SCI</td><td>Computer Sciences</td></tr><tr><td>320</td><td>E C E</td><td>Electrical and Computer Engineering</td></tr></table>`;
const subjects = parsePublicSubjects(subjectsHtml, at).records.filter((r) => r.kind === "subject");
const index = '<a href="/courses/comp_sci/">Computer Sciences (COMP SCI)</a>';
const guide = `<div class="courseblock"><p class="courseblocktitle"><span class="courseblockcode">COMP SCI/ E C E 500</span> — Synthetic systems</p><p class="courseblockcredits">1–3 credits.</p><p class="courseblockdesc">Public description.<script>untrusted()</script></p><div class="courseblockextra"><span class="cbextra-label">Requisites:</span><span class="cbextra-data">Consent of instructor</span></div></div>`;
const sessions = (labels: string[]) => `<table><thead><tr><th>Term</th><th>Session</th><th>Begin</th><th>End</th></tr></thead><tbody>${labels.map((label) => `<tr><td>${label}</td><td>ABC</td><td>09/02/2026</td><td>10/02/2026</td></tr>`).join("")}</tbody><tfoot><tr><td>Term</td><td>Session</td><td>Begin</td><td>End</td></tr></tfoot></table>`;
test("Registrar terms use corroborated published codes, collapse sessions and leave past flags unknown", () => {
  const capture = parsePublicTerms(sessions(["1272 : Fall 2026-2027", "1272 : Fall 2026-2027", "1274 : Spring 2026–2027", "1276 : Summer 2027"]), at);
  assert.deepEqual(capture.records.map((record) => record.kind === "term" ? [record.code, record.label, record.past] : null), [
    ["1272", "Fall 2026", null], ["1274", "Spring 2027", null], ["1276", "Summer 2027", null],
  ]);
  assert.equal(capture.accountScope, "public");
  assert.equal(capture.scope.key, "registrar-session-terms");
  assert.equal(capture.status, "partial");
  assert.equal(capture.completeness, "partial");
  assert.deepEqual(capture.diagnostics.map((diagnostic) => diagnostic.code), ["registrar_terms_fallback"]);
  assert.equal(capture.records.some((record) => "startDate" in record || "endDate" in record), false);
});
test("Registrar term label conflicts and unsupported table shapes cannot invent or erase terms", () => {
  const capture = parsePublicTerms(sessions([
    "1272 : Fall 2026-2027", "1272 : Fall 2025-2026", "1274 : Fall 2026-2027",
    "1273 : Spring 2027", "1276 : Summer 2027", "1264 : Spring 2025-2026", "1262 : Fall 2025",
  ]), at);
  assert.deepEqual(capture.records.map((record) => record.id), ["1262", "1264", "1276"]);
  assert.ok(capture.diagnostics.some((diagnostic) => diagnostic.code === "conflicting_term_labels"));
  assert.equal(parsePublicTerms(sessions(["1272 : Fall 2026-2028"]), at).status, "failed");
  assert.equal(parsePublicTerms('<script>1272 : Fall 2026-2027</script><p>1274 : Spring 2026-2027</p>', at).status, "failed");
  assert.equal(parsePublicTerms(sessions(["1272 : Fall 2026-2027"]).replace("<th>Term</th>", "<th>Other</th>"), at).status, "failed");
  const store = createStore(":memory:");
  try {
    store.ingestPlanning(parsePublicTerms(sessions(["1272 : Fall 2026-2027", "1274 : Spring 2026-2027"]), at));
    store.ingestPlanning(parsePublicTerms(sessions(["1272 : Fall 2026-2027"]), "2026-09-26T12:01:00Z"));
    store.ingestPlanning(parsePublicTerms("<h1>Unavailable</h1>", "2026-09-26T12:02:00Z"));
    assert.equal(store.planningRecords().filter((record) => !record.deleted).length, 2);
  } finally { store.close(); }
});
test("public term pull bounds the fixed source and honors cancellation even when transport ignores it", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = { text: async (url: string, options?: Parameters<PublicClient["text"]>[1]) => {
    calls++;
    assert.equal(url, "https://registrar.wisc.edu/sessioncodes/");
    assert.equal(options?.maxBytes, 2_000_000);
    assert.equal(options?.signal, controller.signal);
    assert.equal(await options?.onRedirect?.("https://registrar.wisc.edu/sessioncodes/"), true);
    assert.equal(await options?.onRedirect?.("https://evil.invalid/sessioncodes/"), false);
    return { text: sessions(["1272 : Fall 2026-2027"]) };
  } } as PublicClient;
  assert.equal((await pullPublicTerms(client, at, controller.signal)).records.length, 1);
  controller.abort();
  await assert.rejects(pullPublicTerms(client, at, controller.signal));
  assert.equal(calls, 1);
  const ignored = new AbortController();
  const late = { text: async () => { ignored.abort(); return { text: sessions(["1272 : Fall 2026-2027"]) }; } } as unknown as PublicClient;
  await assert.rejects(pullPublicTerms(late, at, ignored.signal));
  assert.throws(() => parsePublicTerms("x".repeat(2_000_001), at), /parsing limit/);
});
test("Registrar fallback cannot imply subjects-map completeness or deletion", () => {
  const capture = parsePublicSubjects(subjectsHtml, at);
  assert.equal(capture.records.length, 2);
  assert.equal(capture.status, "partial");
  assert.equal(capture.completeness, "partial");
  assert.equal(parsePublicSubjects("<h1>Sign in</h1>", at).status, "failed");
});
test("Guide uses exact official subject index links and explicit crosslisting; prose remains unknown", () => {
  assert.equal(guideSubjectSlug(index, subjects[0]), "comp_sci");
  assert.equal(guideSubjectSlug(index.replace('/courses/comp_sci/', 'https://evil.invalid/courses/comp_sci/'), subjects[0]), null);
  assert.equal(guideSubjectSlug(index + '<a href="/courses/other/">Other (COMP SCI)</a>', subjects[0]), null);
  const result = parseGuideSubject(guide, "comp_sci", subjects, at);
  const course = result.records.find((r) => r.kind === "catalog_course")!;
  assert.equal(course.courseKey, "uw:266:500");
  assert.equal(course.termCode, null);
  assert.equal(course.creditMin, 1);
  assert.equal(course.creditMax, 3);
  assert.equal(course.prerequisite, null);
  assert.equal(course.description, "Public description.");
  assert.equal(result.records.find((r) => r.kind === "crosslist")?.courseKeys.length, 2);
  assert.equal(parseGuideSubject(guide.replace('COMP SCI/ E C E', 'UNKNOWN'), "comp_sci", subjects, at).status, "failed");
});
test("Guide pulling keeps URLs constrained to the published index and marks catalog-only evidence", async () => {
  const calls: string[] = [];
  const client = { text: async (url: string) => { calls.push(url); return { text: calls.length === 1 ? index : guide }; } } as PublicClient;
  const capture = await pullGuideForSubject(client, subjects[0], subjects, at);
  assert.deepEqual(calls, ["https://guide.wisc.edu/courses/", "https://guide.wisc.edu/courses/comp_sci/"]);
  assert.equal(capture.diagnostics[0].code, "guide_catalog_only");
});
test("normal catalog command persists typed rows and purge prevents an in-flight read repopulating data", async () => {
  let resolveRead!: (value: { text: string }) => void;
  let pending = false;
  const client = { text: async (url: string) => pending ? new Promise<{ text: string }>((resolve) => { resolveRead = resolve; }) : { text: url.endsWith("/comp_sci/") ? guide : index } } as PublicClient;
  const store = createStore(":memory:"), core = createCore(store, { fixture: captureBatchSchema.parse(fixture), planningPublicClient: client });
  await core.execute({ type: "planning-import", batch: parsePublicSubjects(subjectsHtml, at) });
  const result = await core.execute({ type: "planning-guide", subjectCode: "266" });
  assert.equal(result.snapshot.planning?.records.filter((r) => r.kind === "catalog_course").length, 1);
  pending = true;
  const work = core.execute({ type: "planning-guide", subjectCode: "266" });
  await core.execute({ type: "purge", confirmation: "DELETE LOCAL DATA" });
  // A transport that ignores cancellation still cannot write after purge.
  pending = false;
  resolveRead({ text: index });
  await assert.rejects(work, /cancelled/);
  assert.equal(core.snapshot().planning?.records.length, 0);
  await core.close();
});
