import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createMcpService } from "../packages/core/src/mcp";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema, personalPlanningAt, type PersonalDeadlineChange, type Store } from "@magic/contracts";
import { resourceViews } from "../packages/core/src/queries";
import { currentPersonalDeadlineSource, personalDeadlineSource } from "../packages/core/src/personal-deadlines";
import { resolveDeadline } from "@magic/domain";
import fixture from "../fixtures/course.json";

const stamp = "2026-09-27T12:00:00.000Z";
function setup(path = ":memory:") {
  const store = createStore(path, { now: () => new Date(stamp) });
  const batch = captureBatchSchema.parse(fixture);
  const assignment = batch.resources.find(row => row.externalId === "essay-1")!;
  assignment.deadlines = [
    { value: "2026-09-29T04:59:00Z", kind: "due", quote: "Canvas due date", authority: "structured", scopeConfirmed: true },
    { value: "2026-09-30T04:59:00Z", kind: "due", quote: "Other captured date", authority: "document", scopeConfirmed: true },
  ];
  store.ingest(batch);
  const resourceId = store.resources().find(row => row.externalId === "essay-1")!.id;
  return { store, batch, resourceId };
}
function view(store: Store, id: string) { return resourceViews(store, [store.resource(id)!])[0]!; }
function change(store: Store, id: string, extra: Partial<PersonalDeadlineChange> = {}): PersonalDeadlineChange {
  const current = view(store, id).personalDeadline!;
  return { operationId: "save", resourceId: id, sourceVersion: current.sourceVersion, optionId: current.options[1]!.id, expectedRevision: current.revision, ...extra };
}
function save(store: Store, input: PersonalDeadlineChange) { return store.setPersonalDeadlineChoice(input, () => currentPersonalDeadlineSource(store, input.resourceId)); }

test("SQLite restart retains chosen personal planning date, exact raw claims, change, Undo and delayed retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-personal-date-"));
  const path = join(dir, "test.sqlite");
  let { store, resourceId } = setup(path);
  try {
    const raw = store.resource(resourceId)!;
    const originalDeadline = view(store, resourceId).deadline;
    const input = change(store, resourceId);
    const receipt = save(store, input);
    store.close(); store = createStore(path);
    assert.equal(personalPlanningAt(view(store, resourceId)), receipt.selected!.value);
    assert.deepEqual(view(store, resourceId).deadline, originalDeadline);
    assert.deepEqual(store.resource(resourceId), raw);
    const changed = change(store, resourceId, { operationId: "change", optionId: view(store, resourceId).personalDeadline!.options[0]!.id });
    save(store, changed);
    assert.equal(view(store, resourceId).personalDeadline!.selected!.optionId, changed.optionId);
    save(store, change(store, resourceId, { operationId: "undo", optionId: null }));
    assert.deepEqual(save(store, input), receipt);
    assert.equal(view(store, resourceId).personalDeadline!.selected, null);
    assert.equal(view(store, resourceId).personalDeadline!.revision, 3);
    assert.equal(personalPlanningAt(view(store, resourceId)), originalDeadline.planningAt);
    store.close(); store = createStore(path);
    assert.equal(view(store, resourceId).personalDeadline!.selected, null);
  } finally { store.close(); rmSync(dir, {recursive: true, force: true}); }
});

test("CAS across connections; invalid option, changed operation and stale evidence fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-personal-date-cas-"));
  const path = join(dir, "test.sqlite");
  const { store, resourceId, batch } = setup(path), other = createStore(path);
  try {
    const input = change(store, resourceId);
    const stale = change(other, resourceId, {operationId: "other-view"});
    assert.throws(() => save(store, {...input, optionId: "fabricated"}), /current sourced dates/);
    save(store, input);
    assert.throws(() => save(other, stale), /another view/);
    assert.throws(() => save(store, {...input, optionId: null}), /operation ID/);
    batch.observedAt = "2026-09-28T12:00:00Z";
    batch.resources.find(r => r.externalId === "essay-1")!.text += " Updated instructions.";
    store.ingest(batch);
    assert.equal(view(store, resourceId).personalDeadline!.needsReview, true);
    assert.equal(view(store, resourceId).personalDeadline!.selected, null);
    assert.throws(() => save(store, {...input, operationId: "stale", expectedRevision: 1}), /source changed/);
    save(store, change(store, resourceId, {operationId: "review-again"}));
    assert.equal(view(store, resourceId).personalDeadline!.needsReview, false);
  } finally { store.close(); other.close(); rmSync(dir, {recursive: true, force: true}); }
});

test("new independent claim invalidates selection even when assignment is unchanged; disappearance remains recoverable", () => {
  const {store, batch, resourceId} = setup();
  try {
    save(store, change(store, resourceId));
    const hash = store.resource(resourceId)!.contentHash;
    const assignment = batch.resources.find(r => r.externalId === "essay-1")!;
    const prose = captureBatchSchema.parse({...batch, source: {...batch.source, id: "notice", scope: "announcements"}, resources: [{ externalId: "notice", kind: "message", courseId: assignment.courseId, courseName: assignment.courseName, title: assignment.title, url: assignment.url + "/notice", text: `${assignment.title} is due October 1, 2026 at 11:59pm.`, createdAt: stamp }]});
    store.ingest(prose);
    assert.equal(store.resource(resourceId)!.contentHash, hash);
    assert.equal(view(store, resourceId).personalDeadline!.needsReview, true);
    assert.equal(view(store, resourceId).personalDeadline!.options.length, 3);
    save(store, change(store, resourceId, {operationId: "new-evidence"}));
    store.removeSource("notice");
    const latest = view(store, resourceId).personalDeadline!;
    assert.equal(latest.needsReview, true);
    assert.equal(latest.revision, 2);
    save(store, change(store, resourceId, {operationId: "removed-evidence"}));
    assert.equal(view(store, resourceId).personalDeadline!.revision, 3);
  } finally {store.close();}
});

test("equivalent instants collapse while day precision remains unknown time; title and unconfirmed claims excluded", () => {
  const {store, resourceId} = setup();
  try {
    const base = {kind: "due" as const, authority: "structured" as const, scopeConfirmed: true, quote: "source"};
    const claims = [
      {...base, value: "2026-09-29T04:59:00Z"}, {...base, value: "2026-09-28T23:59:00-05:00"},
      {...base, value: "2026-09-30T05:00:00Z", precision: "day" as const},
      {...base, value: "2026-09-28T04:59:00Z", authority: "title" as const},
      {...base, value: "2026-09-27T04:59:00Z", scopeConfirmed: false},
    ];
    const source = personalDeadlineSource(store.resource(resourceId)!, "account", resolveDeadline(claims), [{resourceId, contentHash: "hash"}]);
    assert.equal(source.options.length, 2);
    assert.equal(source.options.find(option => option.precision === "minute")!.claims.length, 2);
    assert.equal(source.options.find(option => option.precision === "day")!.value, "2026-09-30T05:00:00.000Z");
    assert.equal(personalDeadlineSource(store.resource(resourceId)!, "account", resolveDeadline([...claims].reverse()), [{resourceId, contentHash: "hash"}]).sourceVersion, source.sourceVersion);
  } finally {store.close();}
});

test("account binding, exclusion, typed core latest snapshots and local purge", async () => {
  const {store, batch, resourceId} = setup();
  const core = createCore(store, {fixture: batch});
  try {
    const input = change(store, resourceId);
    const result = await core.execute({type: "personal-deadline", value: input});
    assert.equal(result.snapshot.resources.find(r => r.id === resourceId)!.personalDeadline!.revision, 1);
    assert.equal(JSON.stringify(core.context(resourceId, "local")).includes("personalDeadline"), false);
    store.setMcpGrant({id: "test", label: "Test", recipient: "local", enabled: true,
      courses: [{accountScope: batch.source.accountScope, courseId: batch.source.courseId}], categories: ["course_text"],
      tokenHash: createHash("sha256").update("local-test-token").digest("hex")});
    assert.equal(JSON.stringify(createMcpService(store, "test", "local-test-token").call("get_item", {id: resourceId})).includes("personalDeadline"), false);
    await core.execute({type: "personal-deadline", value: change(store, resourceId, {operationId: "undo", optionId: null})});
    const replay = await core.execute({type: "personal-deadline", value: input});
    assert.equal(replay.snapshot.resources.find(r => r.id === resourceId)!.personalDeadline!.selected, null);
    store.setCourseOverride({accountScope: batch.source.accountScope, courseId: batch.source.courseId, included: false});
    assert.equal(view(store, resourceId).personalDeadline, undefined);
    assert.throws(() => save(store, {...input, operationId: "excluded"}), /no longer available/);
    store.setCourseOverride({accountScope: batch.source.accountScope, courseId: batch.source.courseId, included: true});
    store.removeSource(batch.source.id);
    store.ingest({...batch, observedAt: "2026-09-28T12:00:00Z", source: {...batch.source, accountScope: "different-account"}});
    const newId = store.resources().find(r => r.externalId === "essay-1")!.id;
    assert.equal(view(store, newId).personalDeadline!.revision, 0);
    assert.throws(() => save(store, {...input, resourceId: newId}), /operation ID/);
    save(store, change(store, newId, {operationId: "other-account"}));
    await core.execute({type: "purge", confirmation: "DELETE LOCAL DATA"});
    assert.deepEqual(store.personalDeadlineChoices(), []);
  } finally {await core.close();}
});
