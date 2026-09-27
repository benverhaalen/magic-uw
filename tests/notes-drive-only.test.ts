// Notes connections: Google Drive is the only one offered; Microsoft 365 shows as a disabled
// "possibly coming soon" row. Checks the Connect button's path (renderer command -> notes service ->
// the Google remote's connect -> main's OAuth) without a live sign-in. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStore } from "@magic/storage";
import type { NotesResult, Snapshot } from "@magic/contracts";
import { createNotesService, type NotesRemote } from "../packages/notes/src/index";
import { ConnectedAccounts } from "../apps/desktop/src/renderer/data-ai/sections";
import { createGoogleNotesAuth } from "../apps/desktop/src/notes-google";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const NOW = new Date("2026-09-28T15:00:00Z");

test("Connected accounts offers Google Drive and shows Microsoft 365 only as possibly coming soon", () => {
  const g = globalThis as { window?: unknown };
  const had = "window" in g;
  g.window ??= { magic: {} }; // RememberSignIn reads window.magic; an empty bridge here
  let html: string;
  try {
    html = renderToStaticMarkup(
      React.createElement(ConnectedAccounts, { snapshot: { sources: [], mcpGrants: [] } as unknown as Snapshot, busy: false, run: async () => undefined, onSignIn: () => {}, mcp: null }),
    );
  } finally {
    if (!had) delete g.window;
  }
  assert.match(html, /Google Drive/);
  assert.match(html, /Microsoft 365: possibly coming soon/);
  assert.doesNotMatch(html, /Microsoft 365<\//, "no connectable Microsoft 365 row");
});

test("onboarding and the notes page offer no Microsoft notes connection", () => {
  const onboarding = read("apps/desktop/src/renderer/onboarding/Onboarding.tsx");
  assert.match(onboarding, /row\("Google Drive", google, \(\) => void connectGoogle\(\)\)/);
  assert.match(onboarding, /Microsoft 365: possibly coming soon/);
  assert.doesNotMatch(onboarding, /connectMicrosoft|outlookConnect/);
  const preview = read("apps/desktop/src/renderer/backend/NotesPreview.tsx");
  assert.match(preview, /providers\.filter\(\(p\) => p\.provider === "google"\)/);
  assert.match(preview, /Microsoft 365: possibly coming soon/);
  const worker = read("apps/desktop/src/worker.ts");
  assert.match(worker, /const OFFER_MICROSOFT_NOTES = false;/);
  assert.match(worker, /if \(OFFER_MICROSOFT_NOTES\)\s+notesRemotes\.microsoft =/);
});

test("the Connect button's command runs the Google sign-in and turns sync on", async () => {
  const store = createStore(":memory:", { now: () => NOW });
  let connects = 0;
  const google = { connected: async () => false, connect: async () => (++connects, true) } as unknown as NotesRemote & { connect(): Promise<boolean> };
  const notes = createNotesService({ store, now: () => NOW, remotes: { google } });
  // The exact command Onboarding and Connected accounts send.
  const result = (await notes.handle({ op: "notes.sync.enable", provider: "google" })) as Extract<NotesResult, { sync: unknown }>;
  assert.equal(connects, 1);
  assert.equal(result.status, "ok");
  const g = result.sync.providers.find((p) => p.provider === "google")!;
  assert.equal(g.enabled, true);
  // Microsoft isn't registered, so nothing can turn it on.
  assert.equal((await notes.handle({ op: "notes.sync.enable", provider: "microsoft" })).status, "not_connected");
});

test("without a client ID the button says plainly that Google sign-in isn't configured", async () => {
  const store = createStore(":memory:", { now: () => NOW });
  const notes = createNotesService({ store, now: () => NOW, remotes: {} });
  const result = await notes.handle({ op: "notes.sync.enable", provider: "google" });
  assert.equal(result.status, "not_connected");
  assert.match("message" in result ? String(result.message) : "", /isn't configured/);
  // Both surfaces map that message to a visible "needs setup" line, not a silent no-op.
  assert.match(read("apps/desktop/src/renderer/onboarding/Onboarding.tsx"), /isn't configured/);
  assert.match(read("apps/desktop/src/renderer/data-ai/sections.tsx"), /Google sign-in isn't configured in this build/);
  const auth = createGoogleNotesAuth({ clientId: undefined, vault: { get: async () => undefined, set: async () => {}, deletePrefix: async () => {} }, openExternal: async () => {} });
  assert.equal(auth.configured(), false);
  assert.deepEqual(await auth.connect(), { connected: false });
});

test("worker and main carry the Google sign-in end to end; the client ID and secret come from env", () => {
  const worker = read("apps/desktop/src/worker.ts");
  assert.match(worker, /connect: async \(\) => Boolean\(\(await notesHostCall\(\{ op: "connect" \}/);
  assert.match(worker, /port\.postMessage\(\{ kind: "notes-google", id, payload \}\)/);
  const main = read("apps/desktop/src/main.ts");
  assert.match(main, /clientId: process\.env\.MAGIC_GOOGLE_CLIENT_ID \|\| undefined/);
  assert.match(main, /clientSecret: process\.env\.MAGIC_GOOGLE_CLIENT_SECRET \|\| undefined/);
  assert.match(main, /op === "connect" \? await notesGoogle\.connect\(\)/);
});

test("a configured client secret is sent on the token refresh", async () => {
  const bodies: string[] = [];
  const saved = JSON.stringify({ refresh: "r1", access: "", expiresAt: 0 });
  const auth = createGoogleNotesAuth({
    clientId: "id.apps.googleusercontent.com",
    clientSecret: "test-secret",
    vault: { get: async () => saved, set: async () => {}, deletePrefix: async () => {} },
    openExternal: async () => {},
    now: () => NOW.getTime(),
    fetch: (async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ access_token: "a1", expires_in: 3600 }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  await auth.request({ method: "GET", url: "https://www.googleapis.com/drive/v3/files" });
  assert.equal(bodies.length, 1);
  assert.match(bodies[0]!, /client_secret=test-secret/);
});
