// "Re-run setup" (ported from feat/floating-chat 615c6f2): the AI client setup is cleared (client
// config, modes, separate profiles, health answers, the chosen AI, onboarding progress) and onboarding
// opens at step 1. Courses, notes, sign-ins and agreements stay.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPrivacy, type Command, type PrivacyPreferences, type Snapshot } from "@magic/contracts";
import { hasCurrentConsent, CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { resetForReconfigure } from "../apps/desktop/src/renderer/reconfigure/reset";
import { emptyProgress, firstIncompleteStep, needsOnboarding, steps } from "../apps/desktop/src/renderer/onboarding/model";
import { resetClientSetup } from "../apps/desktop/src/clients/profiles";

function fakes(privacy: PrivacyPreferences = { ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "codex" }) {
  const calls: string[] = [];
  const commands: Command[] = [];
  return {
    calls, commands,
    deps: {
      clients: { reset: async () => { calls.push("clients.reset"); } } as { reset?: () => Promise<void> } | undefined,
      privacy,
      run: async (command: Command) => { calls.push("run"); commands.push(command); return {}; },
      clearHealth: () => calls.push("health"),
      clearLocalChoice: () => calls.push("local"),
      restartProgress: () => calls.push("progress"),
    },
  };
}

test("confirming clears main's client setup first, then the health answers, the chosen AI and setup progress", async () => {
  const f = fakes();
  await resetForReconfigure(f.deps);
  assert.deepEqual(f.calls, ["clients.reset", "health", "local", "run", "progress"]);
  assert.deepEqual(f.commands, [{ type: "privacy", value: { ...f.deps.privacy, hostedProvider: "none" } }], "only the chosen AI changes");
  const none = fakes(defaultPrivacy);
  await resetForReconfigure(none.deps);
  assert.deepEqual(none.commands, [], "no chosen AI, no privacy write");
});

test("when main's reset fails, nothing else is cleared", async () => {
  const f = fakes();
  f.deps.clients = { reset: async () => { throw new Error("disk busy"); } };
  await assert.rejects(resetForReconfigure(f.deps), /disk busy/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(resetForReconfigure({ ...f.deps, clients: undefined }), /desktop app/);
});

test("main removes only the app's client setup: settings, modes, separate profiles; everything else stays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reconfigure-"));
  try {
    writeFileSync(join(dir, "client-settings.json"), '{"chosen":"claude"}');
    writeFileSync(join(dir, "client-modes.json"), '{"claude":"isolated"}');
    mkdirSync(join(dir, "clients", "claude"), { recursive: true });
    writeFileSync(join(dir, "clients", "claude", ".credentials.json"), "{}");
    mkdirSync(join(dir, "clients", "instant", "codex"), { recursive: true });
    writeFileSync(join(dir, "workspace.sqlite"), "courses");
    writeFileSync(join(dir, "secrets.json"), "sign-ins");
    await resetClientSetup(dir);
    for (const gone of ["client-settings.json", "client-modes.json", "clients"]) assert.equal(existsSync(join(dir, gone)), false, gone);
    for (const kept of ["workspace.sqlite", "secrets.json"]) assert.equal(existsSync(join(dir, kept)), true, kept);
    await resetClientSetup(dir); // a second reset is harmless
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restarted progress shows onboarding although courses are saved, and the app opens it at step 1", () => {
  const snapshot = {
    resources: [{ deleted: false }], sources: [{}], consents: [{ recipient: "uw", disclosureVersion: CONSENT_DISCLOSURE_VERSION, grantedAt: "2026-09-27T12:00:00.000Z" }],
  } as unknown as Snapshot;
  assert.equal(needsOnboarding(snapshot, emptyProgress, hasCurrentConsent), false, "a fresh progress record alone would not show setup");
  assert.equal(needsOnboarding(snapshot, { ...emptyProgress, started: true }, hasCurrentConsent), true);
  assert.notEqual(firstIncompleteStep(snapshot, { ...emptyProgress, started: true }, hasCurrentConsent), "consent", "so the app passes startAt");
  assert.equal(steps[0]!.id, "consent");
  const app = readFileSync(new URL("../apps/desktop/src/renderer/App.tsx", import.meta.url), "utf8");
  assert.match(app, /if \(snapshot && \(setupAt \|\| needsFirstRunSetup\(snapshot\)\)\)/);
  assert.match(app, /startAt=\{setupAt \?\? undefined/);
  assert.match(app, /await resetForReconfigure\(\{ clients: window\.magic\.clients, privacy: snapshot\.privacy, run \}\);\n\s+setSetupAt\("consent"\);/);
  const onboarding = readFileSync(new URL("../apps/desktop/src/renderer/onboarding/Onboarding.tsx", import.meta.url), "utf8");
  assert.match(onboarding, /useState<StepId>\(\(\) => props\.startAt \?\? firstIncompleteStep/);
});
