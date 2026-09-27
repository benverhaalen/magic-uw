// Conversation launcher state: opening and dismissing never submit, drafts keep the context they were
// written in, and one submit gesture produces one entry until the owner settles it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  SUBMIT_FAILED, beginSubmit, collapse, edit, expand, initialLauncher, rebase, settleSubmit,
  type LauncherState,
} from "../apps/desktop/src/renderer/conversation-launcher/model";

type Origin = { label: string; courseKey: string | null };
const at = (label: string, courseKey: string | null = null) => () => ({ origin: { label, courseKey }, originKey: label });
let n = 0;
const key = () => `k${++n}`;

test("empty open and dismiss captures once, sends nothing, and releases the context", () => {
  let captures = 0;
  const capture = () => { captures++; return at("Home")(); };
  let s: LauncherState<Origin> = expand(initialLauncher<Origin>(), capture);
  assert.equal(s.open, true);
  assert.equal(captures, 1);
  assert.equal(beginSubmit(s, key), null);
  s = edit(s, "   \n ");
  assert.equal(beginSubmit(s, key), null, "whitespace is empty");
  s = collapse(s);
  assert.deepEqual(s, initialLauncher<Origin>());
  s = expand(s, at("COMPSCI 220", "cs220"));
  assert.equal(s.draft?.origin.label, "COMPSCI 220", "next open takes fresh context");
});

test("a draft survives collapse with its original context until explicitly rebased", () => {
  let s = edit(expand(initialLauncher<Origin>(), at("P1 (MySQL)", "cs220")), "what do I need to finish this?");
  s = collapse(s);
  assert.equal(s.open, false);
  assert.equal(s.draft?.text, "what do I need to finish this?");
  let recaptured = false;
  s = expand(s, () => { recaptured = true; return at("Calendar")(); });
  assert.equal(recaptured, false, "reopening elsewhere must not replace the draft's origin");
  assert.equal(s.draft?.origin.courseKey, "cs220");
  s = rebase(s, at("Calendar"));
  assert.equal(s.draft?.origin.label, "Calendar");
  assert.equal(s.draft?.text, "what do I need to finish this?", "rebase keeps the student's words");
});

test("one gesture yields one entry; duplicates are refused until the owner settles", () => {
  let s = edit(expand(initialLauncher<Origin>(), at("Home")), "  due this week?\n");
  const first = beginSubmit(s, key);
  assert.ok(first);
  assert.equal(first.entry.prompt, "  due this week?\n", "only the emptiness test trims");
  s = first.state;
  assert.equal(beginSubmit(s, key), null, "second press while sending");
  assert.equal(edit(s, "changed").draft?.text, "  due this week?\n", "text is fixed while sending");
  assert.equal(settleSubmit(s, "stale", { accepted: true }), s, "a stale settlement is ignored");
  s = settleSubmit(s, first.entry.idempotencyKey, { accepted: true });
  assert.deepEqual(s, initialLauncher<Origin>());
});

test("failure keeps text, origin and key for an unchanged retry; editing starts a new gesture", () => {
  let s = edit(expand(initialLauncher<Origin>(), at("COMPSCI 220", "cs220")), "explain the rubric");
  const first = beginSubmit(s, key)!;
  s = settleSubmit(first.state, first.entry.idempotencyKey, { accepted: false });
  assert.equal(s.error, SUBMIT_FAILED);
  assert.equal(s.draft?.text, "explain the rubric");
  assert.equal(s.draft?.origin.courseKey, "cs220");
  s = collapse(s);
  assert.equal(s.draft?.text, "explain the rubric", "failed draft survives collapse");
  const retry = beginSubmit(expand(s, at("Home")), key)!;
  assert.equal(retry.entry.idempotencyKey, first.entry.idempotencyKey, "same text retries under the same key");
  s = settleSubmit(retry.state, retry.entry.idempotencyKey, { accepted: false, message: "Chat is busy." });
  assert.equal(s.error, "Chat is busy.");
  s = edit(s, "explain the rubric for P2");
  assert.equal(s.error, null);
  assert.notEqual(beginSubmit(s, key)!.entry.idempotencyKey, first.entry.idempotencyKey);
});

test("collapsing while a submit is in flight keeps it and lets it settle", () => {
  const begun = beginSubmit(edit(expand(initialLauncher<Origin>(), at("Home")), "hi"), key)!;
  let s = collapse(begun.state);
  assert.equal(s.sending, begun.entry.idempotencyKey);
  assert.equal(rebase(s, at("Calendar")), s, "no rebase mid-send");
  s = settleSubmit(s, begun.entry.idempotencyKey, { accepted: true });
  assert.equal(s.draft, null);
});
