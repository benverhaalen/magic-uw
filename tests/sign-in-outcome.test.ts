// owner: client-health (FDB-002). The `magic:signin` contract returns how the window ended,
// and the renderer reads Canvas only after a confirmed sign-in.
import test from "node:test";
import assert from "node:assert/strict";
import type { SignInOutcome } from "../packages/contracts/src/index.ts";
import { HEADLESS_SIGN_IN, handleSignInRequest } from "../apps/desktop/src/sign-in-outcome.ts";
import { signInAndSync, signInMessage } from "../apps/desktop/src/renderer/sign-in.ts";

const refused = "Agree to the setup first.";
const deps = (open: (s: unknown) => Promise<boolean>, consented = true) => {
  const opened: unknown[] = [];
  return {
    opened,
    consented: async () => consented,
    refused,
    open: (service: unknown) => {
      opened.push(service);
      return open(service);
    },
  };
};

test("IPC: a confirmed window is confirmed, a closed one is cancelled, a failure says why", async () => {
  assert.deepEqual(await handleSignInRequest(undefined, deps(async () => true)), { status: "confirmed", service: "canvas" });
  assert.deepEqual(await handleSignInRequest("gitlab", deps(async () => false)), { status: "cancelled", service: "gitlab" });
  assert.deepEqual(await handleSignInRequest("myuw", deps(async () => { throw new Error(HEADLESS_SIGN_IN); })), {
    status: "failed",
    service: "myuw",
    reason: HEADLESS_SIGN_IN,
  });
  // An unexpected error's text never crosses (it could carry a URL or an account detail).
  const other = await handleSignInRequest("enroll", deps(async () => { throw new Error("ERR at https://login.wisc.edu/?user=someone"); }));
  assert.deepEqual(other, { status: "failed", service: "enroll", reason: "The UW sign-in window couldn't open." });
});

test("IPC: an unknown service and a refused consent still reject, and no window opens", async () => {
  const bad = deps(async () => true);
  await assert.rejects(handleSignInRequest("evil", bad), /Unsupported sign-in source/);
  const noConsent = deps(async () => true, false);
  await assert.rejects(handleSignInRequest("canvas", noConsent), new RegExp(refused));
  assert.deepEqual([...bad.opened, ...noConsent.opened], []);
});

function bridge(outcome: SignInOutcome | undefined) {
  let syncs = 0;
  return {
    get syncs() {
      return syncs;
    },
    signInUW: async () => outcome as SignInOutcome,
    syncCanvas: async () => {
      syncs++;
      return {} as never;
    },
  };
}

test("renderer: cancellation claims no success and starts no sync; only confirmed reads Canvas", async () => {
  const cancelled = bridge({ status: "cancelled", service: "canvas" });
  const r1 = await signInAndSync(cancelled);
  assert.deepEqual([r1.outcome.status, r1.synced, cancelled.syncs], ["cancelled", false, 0]);
  assert.doesNotMatch(signInMessage(r1.outcome), /signed in\./i);
  assert.match(signInMessage(r1.outcome), /Nothing was read/);

  const failed = bridge({ status: "failed", service: "canvas", reason: HEADLESS_SIGN_IN });
  const r2 = await signInAndSync(failed);
  assert.deepEqual([r2.outcome.status, r2.synced, failed.syncs], ["failed", false, 0]);
  assert.equal(signInMessage(r2.outcome), HEADLESS_SIGN_IN);

  // An older main that answers without an outcome is not taken as a sign-in either.
  const silent = bridge(undefined);
  const r3 = await signInAndSync(silent);
  assert.deepEqual([r3.outcome.status, r3.synced, silent.syncs], ["failed", false, 0]);

  const confirmed = bridge({ status: "confirmed", service: "canvas" });
  const r4 = await signInAndSync(confirmed);
  assert.deepEqual([r4.outcome.status, r4.synced, confirmed.syncs], ["confirmed", true, 1]);
  assert.match(signInMessage(r4.outcome), /Signed in/);

  assert.deepEqual((await signInAndSync({})).synced, false);
});
