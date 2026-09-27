import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import {
  captureBatchSchema,
  defaultPrivacy,
  type CaptureBatch,
  type ResourceInput,
  type Store,
} from "@magic/contracts";
import fixture from "../fixtures/course.json";
import { linkExactEvidence, evidenceFor } from "../packages/core/src/evidence";
import {
  suggestEvidenceLinks,
  scoreEvidenceCandidates,
  currentLinkJudgments,
  fuzzyLinkId,
} from "../packages/core/src/fuzzy-links";

// Synthetic multi-course, multi-account data. No network, no model calls.
const NOW = "2099-02-01T00:00:00.000Z";
const at = (day: number) => new Date(Date.UTC(2099, 0, day)).toISOString();
const origin = "https://canvas.example.test";
type Course = { account: string; id: string; name: string };
const bio: Course = { account: "student-1", id: "bio-101", name: "Biology 101" };
const chem: Course = { account: "student-1", id: "chem-110", name: "Chemistry 110" };
const otherStudentBio: Course = { account: "student-2", id: "bio-101", name: "Biology 101" };

function res(
  course: Course,
  externalId: string,
  kind: ResourceInput["kind"],
  title: string,
  text: string,
  extra: Partial<ResourceInput> = {},
): ResourceInput {
  return {
    externalId,
    kind,
    courseId: course.id,
    courseName: course.name,
    title,
    url: `${origin}/courses/${course.id}/${kind}/${externalId}`,
    text,
    deadlines: [],
    points: null,
    submitted: null,
    policy: { mode: "unknown", evidence: "" },
    ...extra,
  };
}
let clock = 0;
function batch(course: Course, scope: string, resources: ResourceInput[]): CaptureBatch {
  // Each read is newer than the last; storage ignores out-of-order or repeated observations.
  const observedAt = new Date(Date.parse(NOW) + ++clock * 1000).toISOString();
  return {
    source: {
      id: `${course.account}:${course.id}:${scope}`,
      label: "Synthetic Canvas",
      kind: "canvas",
      accountScope: course.account,
      courseId: course.id,
      scope,
    },
    observedAt,
    complete: true,
    status: "ok",
    resources,
  };
}

const hw3Text =
  "Homework 3 on membrane transport. Complete the Osmosis lab worksheet and explain diffusion and osmosis across the cell membrane, including active transport pumps.";
const guideText =
  "Guide for membrane transport: diffusion, osmosis, facilitated diffusion, and active transport pumps across the cell membrane.";
function bioAssignments(extra: { hw3Text?: string } = {}) {
  return batch(bio, "assignments", [
    res(bio, "hw3", "assignment", "Homework 3: Membrane transport", extra.hw3Text ?? hw3Text, {
      unlockAt: at(5),
      dueAt: at(12),
      deadlines: [{ kind: "due", value: at(12), quote: "due_at", authority: "structured", scopeConfirmed: true }],
    }),
    res(bio, "hw4", "assignment", "Homework 4: Photosynthesis", "Explain chloroplast light reactions and the Calvin cycle.", {
      unlockAt: at(12),
      dueAt: at(19),
    }),
    res(bio, "essay", "assignment", "Reflection essay", "Write about your personal learning goals for the semester.", {
      unlockAt: at(5),
      dueAt: at(12),
    }),
  ]);
}
function bioPages(guide = guideText) {
  return batch(bio, "pages", [
    res(bio, "p-guide", "material", "Homework 3 membrane transport guide", guide, { createdAt: at(6) }),
    res(bio, "p-worksheet", "material", "Osmosis lab worksheet", "Osmosis lab: measure diffusion of water across a potato cell membrane.", { createdAt: at(6) }),
    res(bio, "p-hw4", "material", "Homework 4 photosynthesis guide", "Chloroplast light reactions, Calvin cycle, and membrane transport of protons.", { createdAt: at(13) }),
    res(bio, "p-syllabus", "material", "Course syllabus", "Grading, office hours, and lab safety rules.", { createdAt: at(1) }),
  ]);
}
function bioAnnouncements() {
  return batch(bio, "announcements", [
    res(bio, "ann-1", "message", "Hint for Homework 3", "For membrane transport, remember osmosis moves water across the membrane.", { createdAt: at(8) }),
  ]);
}
function bioModule() {
  return batch(bio, "module-items:m1", [
    res(bio, "mi-hw3", "material", "Homework 3: Membrane transport", "", {
      moduleItem: { type: "Assignment", title: "Homework 3: Membrane transport", contentId: "hw3" },
    }),
    res(bio, "mi-essay", "material", "Reflection essay", "", {
      moduleItem: { type: "Assignment", title: "Reflection essay", contentId: "essay" },
    }),
    res(bio, "mi-worksheet", "material", "Osmosis lab worksheet", "", {
      moduleItem: { type: "Page", title: "Osmosis lab worksheet", contentId: "p-worksheet" },
    }),
    res(bio, "mi-syllabus", "material", "Course syllabus", "", {
      moduleItem: { type: "Page", title: "Course syllabus", contentId: "p-syllabus" },
    }),
  ]);
}
function seed(store: Store) {
  store.ingest(bioAssignments());
  store.ingest(bioPages());
  store.ingest(bioAnnouncements());
  store.ingest(bioModule());
  // Wrong-course and wrong-account decoys carry a near-identical guide.
  store.ingest(batch(chem, "pages", [res(chem, "c-guide", "material", "Homework 3 membrane transport guide", guideText, { createdAt: at(6) })]));
  store.ingest(batch(chem, "assignments", [res(chem, "c-hw3", "assignment", "Homework 3: Membrane transport", hw3Text)]));
  store.ingest(batch(otherStudentBio, "pages", [res(otherStudentBio, "o-guide", "material", "Homework 3 membrane transport guide", guideText, { createdAt: at(6) })]));
}
const find = (store: Store, courseId: string, account: string, externalId: string) => {
  const sources = new Map(store.sources().map((s) => [s.id, s]));
  const r = store
    .resources()
    .find((x) => x.externalId === externalId && x.courseId === courseId && sources.get(x.sourceId)?.accountScope === account && !x.deleted);
  assert.ok(r, `missing ${externalId}`);
  return r;
};
const bioR = (store: Store, id: string) => find(store, bio.id, bio.account, id);

test("wrong course or account never merges, even for an identical document", () => {
  const store = createStore(":memory:");
  try {
    seed(store);
    const hw3 = bioR(store, "hw3");
    const listing = suggestEvidenceLinks(store, hw3.id, NOW);
    const { scored } = scoreEvidenceCandidates(store, hw3.id);
    const decoys = [find(store, chem.id, chem.account, "c-guide").id, find(store, otherStudentBio.id, otherStudentBio.account, "o-guide").id];
    for (const id of decoys) {
      assert.ok(!scored.some((c) => c.targetId === id), "decoy was scored");
      assert.ok(!listing.candidates.some((c) => c.targetId === id));
    }
    // The same-course copy of that document is the top suggestion, so scope (not score) excluded the decoys.
    assert.equal(listing.candidates[0].targetId, bioR(store, "p-guide").id);
    const bioIds = new Set(store.resources().filter((r) => r.courseId === bio.id).map((r) => r.id));
    for (const link of store.links()) assert.ok(bioIds.has(link.fromId) && bioIds.has(link.toId));
    // The chemistry assignment only ever sees chemistry evidence.
    const chemListing = suggestEvidenceLinks(store, find(store, chem.id, chem.account, "c-hw3").id, NOW);
    assert.deepEqual(chemListing.candidates.map((c) => c.targetId), decoys.slice(0, 1));
    // Storage independently refuses a cross-course link.
    assert.throws(
      () =>
        store.putLink({ id: fuzzyLinkId(decoys[0], hw3.id), fromId: decoys[0], toId: hw3.id, type: "supports", reason: "x", status: "proposed", inputHash: store.resource(decoys[0])!.contentHash }),
      /one account and course/,
    );
  } finally {
    store.close();
  }
});

test("no-match abstains: module and date proximity alone never suggest, nothing is recorded", () => {
  const store = createStore(":memory:");
  try {
    seed(store);
    const essay = bioR(store, "essay");
    const listing = suggestEvidenceLinks(store, essay.id, NOW);
    assert.equal(listing.abstained, true);
    assert.deepEqual(listing.candidates, []);
    assert.ok(listing.considered > 0, "candidates were considered, then abstained");
    // The syllabus shares the module and the worksheet shares dates, but there is no lexical evidence.
    const { scored } = scoreEvidenceCandidates(store, essay.id);
    const syllabus = scored.find((c) => c.targetId === bioR(store, "p-syllabus").id)!;
    assert.equal(syllabus.features.sameModule, 1);
    assert.ok(syllabus.score < listing.minScore);
    assert.ok(!store.links().some((l) => l.toId === essay.id));
    assert.deepEqual(currentLinkJudgments(store, essay.id), []);
  } finally {
    store.close();
  }
});

test("multiple supporting documents survive side by side and number conflicts are penalized", () => {
  const store = createStore(":memory:");
  try {
    seed(store);
    const hw3 = bioR(store, "hw3");
    const listing = suggestEvidenceLinks(store, hw3.id, NOW);
    const ids = listing.candidates.map((c) => c.targetId);
    for (const expected of ["p-guide", "p-worksheet", "ann-1"]) assert.ok(ids.includes(bioR(store, expected).id), expected);
    // Module items that are the assignment itself are identity, not support; a Page item whose page
    // was captured is suggested once, as the page.
    assert.ok(!ids.includes(bioR(store, "mi-hw3").id));
    assert.ok(!ids.includes(bioR(store, "mi-worksheet").id));
    assert.equal(new Set(listing.candidates.map((c) => c.targetTitle)).size, listing.candidates.length);
    const worksheet = listing.candidates.find((c) => c.targetId === bioR(store, "p-worksheet").id)!;
    assert.equal(worksheet.features.sameModule, 1);
    assert.deepEqual(worksheet.features.referenceBy, ["assignment_names_target"]);
    const { scored } = scoreEvidenceCandidates(store, hw3.id);
    const hw4Guide = scored.find((c) => c.targetId === bioR(store, "p-hw4").id)!;
    assert.equal(hw4Guide.features.numberConflict, true);
    assert.ok(hw4Guide.score < listing.candidates.find((c) => c.targetId === bioR(store, "p-guide").id)!.score);

    const guideLink = fuzzyLinkId(bioR(store, "p-guide").id, hw3.id);
    const worksheetLink = fuzzyLinkId(bioR(store, "p-worksheet").id, hw3.id);
    store.decideLink(guideLink, "accepted");
    store.decideLink(worksheetLink, "accepted");
    const again = suggestEvidenceLinks(store, hw3.id, NOW);
    const status = new Map(again.candidates.map((c) => [c.linkId, c.status]));
    assert.equal(status.get(guideLink), "accepted");
    assert.equal(status.get(worksheetLink), "accepted");
    assert.equal(status.get(fuzzyLinkId(bioR(store, "ann-1").id, hw3.id)), "proposed");
    assert.equal(store.links().filter((l) => l.toId === hw3.id && l.status === "accepted").length, 2);
  } finally {
    store.close();
  }
});

test("rejected suggestions are not silently restored by re-runs, re-reads, or changed evidence", () => {
  const store = createStore(":memory:");
  try {
    seed(store);
    const hw3 = bioR(store, "hw3");
    suggestEvidenceLinks(store, hw3.id, NOW);
    const annLink = fuzzyLinkId(bioR(store, "ann-1").id, hw3.id);
    store.decideLink(annLink, "rejected");
    assert.equal(suggestEvidenceLinks(store, hw3.id, NOW).candidates.find((c) => c.linkId === annLink)?.status, "rejected");
    // Same capture read again, plus the exact linker running in between.
    store.ingest(bioAnnouncements());
    linkExactEvidence(store);
    assert.equal(suggestEvidenceLinks(store, hw3.id, NOW).candidates.find((c) => c.linkId === annLink)?.status, "rejected");
    // The announcement is edited: the rejection is re-attached to the new evidence, still rejected.
    store.ingest(
      batch(bio, "announcements", [
        res(bio, "ann-1", "message", "Hint for Homework 3", "Updated: for membrane transport, osmosis moves water across the cell membrane.", { createdAt: at(8) }),
      ]),
    );
    const after = suggestEvidenceLinks(store, hw3.id, NOW);
    assert.equal(after.candidates.find((c) => c.linkId === annLink)?.status, "rejected");
    assert.equal(store.links().find((l) => l.id === annLink)?.status, "rejected");
    // A student can still reverse their own rejection explicitly.
    store.decideLink(annLink, "accepted");
    assert.equal(store.links().find((l) => l.id === annLink)?.status, "accepted");
  } finally {
    store.close();
  }
});

test("changed evidence invalidates obsolete judgments and earlier confirmations", () => {
  const store = createStore(":memory:");
  try {
    seed(store);
    const hw3 = bioR(store, "hw3");
    const first = suggestEvidenceLinks(store, hw3.id, NOW);
    const guide = bioR(store, "p-guide");
    const guideLink = fuzzyLinkId(guide.id, hw3.id);
    const originalScore = first.candidates.find((c) => c.linkId === guideLink)!.score;
    store.decideLink(guideLink, "accepted");
    const before = currentLinkJudgments(store, hw3.id);
    assert.ok(before.some((j) => (j.result as { targetHash: string }).targetHash === guide.contentHash));

    // Target changes to unrelated content: the old link and judgment disappear, and the new score abstains.
    store.ingest(bioPages("Parking permits and campus shuttle schedules for the spring."));
    assert.ok(!store.links().some((l) => l.id === guideLink), "stale confirmation still visible");
    assert.ok(!currentLinkJudgments(store, hw3.id).some((j) => (j.result as { targetId: string }).targetId === guide.id));
    assert.throws(() => store.decideLink(guideLink, "accepted"), /stale/);
    let listing = suggestEvidenceLinks(store, hw3.id, NOW);
    const renewed = listing.candidates.find((c) => c.linkId === guideLink);
    // The title alone still names Homework 3, so it is re-suggested, but never as already accepted.
    assert.equal(renewed?.status, "proposed");
    assert.ok(renewed!.score < originalScore, "score was not recomputed from the new evidence");

    // Target changes back to relevant but different text: re-suggested as proposed, not silently accepted.
    store.ingest(bioPages(`${guideText} Revised with a worked example.`));
    listing = suggestEvidenceLinks(store, hw3.id, NOW);
    assert.equal(listing.candidates.find((c) => c.linkId === guideLink)?.status, "proposed");
    const current = currentLinkJudgments(store, hw3.id);
    const newGuideHash = bioR(store, "p-guide").contentHash;
    assert.ok(current.some((j) => (j.result as { targetHash: string }).targetHash === newGuideHash));
    assert.ok(!current.some((j) => (j.result as { targetHash: string }).targetHash === guide.contentHash));

    // Assignment change: every judgment keyed to the old assignment text is obsolete.
    const oldKeys = currentLinkJudgments(store, hw3.id).map((j) => j.key);
    store.ingest(bioAssignments({ hw3Text: `${hw3Text} Now also cover endocytosis.` }));
    assert.deepEqual(currentLinkJudgments(store, hw3.id), []);
    for (const key of oldKeys) assert.equal(store.judgment(key), undefined);
  } finally {
    store.close();
  }
});

test("uncertain links remain inspectable and never reach hosted context, MCP evidence, or deadlines as exact", async () => {
  const store = createStore(":memory:");
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture), now: () => new Date(NOW) });
  try {
    seed(store);
    // One exact support: the assignment links the syllabus URL directly.
    const syllabus = bioR(store, "p-syllabus");
    store.ingest(
      batch(bio, "assignments", [
        ...bioAssignments().resources.map((r) => (r.externalId === "hw3" ? { ...r, links: [syllabus.url] } : r)),
      ]),
    );
    linkExactEvidence(store);
    const hw3 = bioR(store, "hw3");
    const result = await core.execute({ type: "link-candidates", id: hw3.id });
    const listing = result.linkCandidates!;
    assert.ok(listing.candidates.length >= 3);
    assert.ok(!listing.candidates.some((c) => c.targetId === syllabus.id), "exact support duplicated as a suggestion");
    for (const c of listing.candidates) {
      assert.equal(c.match, "suggested");
      assert.equal(c.status, "proposed");
      assert.match(c.reason, /^Suggested, not verified/);
      assert.ok(c.score > 0 && c.score <= 1);
      assert.equal(typeof c.features.textSimilarity, "number");
    }
    assert.equal(typeof listing.runnerUpMargin, "number");
    // Snapshot links show the suggestions as proposed supports, distinguishable from exact specifies.
    const suggestionLinks = result.snapshot.links.filter((l) => l.id.startsWith("fuzzy:"));
    assert.ok(suggestionLinks.length >= 3);
    assert.ok(suggestionLinks.every((l) => l.type === "supports" && l.status === "proposed"));
    assert.ok(result.snapshot.links.some((l) => l.type === "specifies" && l.fromId === syllabus.id && l.status === "accepted"));
    // Each suggestion keeps a versioned judgment with features and both evidence hashes.
    const judgments = currentLinkJudgments(store, hw3.id);
    assert.equal(judgments.length, listing.candidates.length);
    assert.ok(judgments.every((j) => j.model === "local-lexical" && j.questionVersion === "link.fuzzy.v1"));

    // Accept one via the existing override command; a stricter threshold still lists decided links.
    const accepted = listing.candidates[0];
    await core.execute({ type: "link", id: accepted.linkId, status: "accepted" });
    const strict = (await core.execute({ type: "link-candidates", id: hw3.id, minScore: 0.99 })).linkCandidates!;
    assert.deepEqual(strict.candidates.map((c) => [c.linkId, c.status]), [[accepted.linkId, "accepted"]]);

    // Hosted context and MCP evidence use exact links only, even for the student-accepted suggestion.
    await core.execute({ type: "privacy", value: { ...defaultPrivacy, mode: "selective_cloud", jevEnabled: true, hostedProvider: "claude", shareCourseText: true } });
    const manifest = core.context(hw3.id, "claude");
    assert.deepEqual(manifest.resourceIds, [hw3.id, syllabus.id]);
    assert.ok(!manifest.payload.text.includes("Guide for membrane transport"));
    const evidence = evidenceFor(store);
    assert.deepEqual(evidence.supporting(hw3).map((r) => r.id), [syllabus.id]);
    assert.deepEqual(evidence.deadlines(hw3), hw3.deadlines);
  } finally {
    await core.close();
  }
});

test("the candidate command rejects non-assignments and missing items", async () => {
  const store = createStore(":memory:");
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture), now: () => new Date(NOW) });
  try {
    seed(store);
    await assert.rejects(core.execute({ type: "link-candidates", id: bioR(store, "p-guide").id }), /assignment/);
    await assert.rejects(core.execute({ type: "link-candidates", id: "missing" }), /assignment/);
    await assert.rejects(core.execute({ type: "link-candidates", id: bioR(store, "hw3").id, minScore: 2 }));
  } finally {
    await core.close();
  }
});
