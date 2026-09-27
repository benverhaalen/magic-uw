/**
 * Tier 1: session notes on a fresh system.
 * (1) After the schedule is read, every lecture and discussion in the rolling window has a
 *     code-built scaffold; each one's title and first block are read back.
 * (2) The student edits one; the schedule changes; after the next refresh the edited note keeps
 *     the student's text and an untouched one is rebuilt from the new schedule.
 *
 * Not covered here, and why (2026-09-27): no branch has a notes UI (every "notes" in the renderer
 * is the Today rail's change notes or onboarding's Connections row), so these read and write through
 * the renderer's bridge (`window.magic.execute({type:"notes"})`) rather than the DOM. Word/Google
 * sync, "Open in Word/Docs" and the sync conflict need fake Microsoft and Google remotes, and the app
 * has no seam to point them at one: Google needs MAGIC_GOOGLE_CLIENT_ID plus main's OAuth and
 * Drive calls (notes-google.ts), Microsoft needs an MSAL grant of Files.ReadWrite.AppFolder and
 * main's Graph proxy. See tests/e2e/README.md.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { launchFreshSystem } from "./harness/fresh-system";
import { SCENARIOS } from "./harness/scenarios";
import { createSteps } from "./harness/steps";
import { execute } from "./harness/onboarding";
import { DEFAULT_SESSIONS, NOTES_COURSE, scheduleBatch } from "./harness/schedule";

/** The worker refreshes the rolling window on a 30 s tick; allow one tick plus a busy machine. */
const TICK_WAIT_MS = 75_000;

async function notes(page: Page, request: unknown): Promise<any> {
  const result = await execute(page, { type: "notes", request });
  assert.equal(result.notes?.status, "ok", JSON.stringify(result.notes).slice(0, 300));
  return result.notes;
}
async function treeSessions(page: Page) {
  const tree = (await notes(page, { op: "notes.tree", courseId: NOTES_COURSE.courseId })).tree;
  return tree.modules.flatMap((m: any) => m.sessions) as { session: { id: string; title: string; type: string; date: string }; note: any }[];
}
async function waitFor<T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = TICK_WAIT_MS): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 1000));
  } while (Date.now() < until);
  assert.fail(`${what}: not within ${timeoutMs} ms; last ${JSON.stringify(last!).slice(0, 400)}`);
}
const firstBlock = (note: any) => ({ heading: note.blocks[0]?.heading as string, items: (note.blocks[0]?.items ?? []).map((i: any) => i.text as string) });
const allText = (note: any) => note.blocks.flatMap((b: any) => b.items.map((i: any) => i.text)).join("\n");

test("Tier 1 notes: scaffolds for the window; an edit survives a schedule change", { timeout: 200_000 }, async () => {
  const sys = await launchFreshSystem({ name: "notes", scenario: SCENARIOS.signedIn });
  const { page } = sys;
  const steps = createSteps("notes", { onFail: async () => JSON.stringify(await treeSessions(page).catch(() => null), null, 1) });
  const STUDENT_TEXT = "My own point: a claim needs a warrant (typed by the student).";
  try {
    await page.getByLabel(/I agree: My Magic UW may read UW/).waitFor({ timeout: 30_000 });

    await steps.step("read the schedule (a synthetic capture, no network)", async () => {
      const result = await execute(page, { type: "import", batch: scheduleBatch() });
      assert.ok(result.snapshot.resources.some((r: any) => r.courseId === NOTES_COURSE.courseId && r.kind === "course"));
    });

    const titles = DEFAULT_SESSIONS.map((s) => `Notes 201 · ${s.title}`);
    await steps.step("(1) a scaffold for every session in the window; titles and first blocks", async () => {
      const sessions = await waitFor("scaffolds", () => treeSessions(page), (s) => s.length >= 3 && s.every((x) => x.note));
      assert.deepEqual(sessions.map((s) => s.session.title), titles, "the sessions in the window, in order");
      assert.deepEqual(sessions.map((s) => s.session.type), ["lecture", "lecture", "discussion"]);
      for (const s of sessions) {
        assert.equal(s.note.state, "untouched");
        const note = (await notes(page, { op: "notes.open", noteId: s.note.id })).note;
        const block = firstBlock(note);
        assert.ok(block.heading, `${s.session.title}: the first block has a heading`);
        assert.ok(allText(note).includes(s.session.title), `${s.session.title}: the scaffold names its session`);
        console.log(`  ${s.session.date} ${s.session.title} → first block "${block.heading}": ${JSON.stringify(block.items.slice(0, 2))}`);
      }
    });

    let edited = "";
    let untouched = { id: "", revision: 0 };
    await steps.step("(2a) the student writes in Lecture 1's note", async () => {
      const sessions = await treeSessions(page);
      edited = sessions[0].note.id;
      untouched = { id: sessions[1].note.id, revision: sessions[1].note.revision };
      const note = (await notes(page, { op: "notes.append", noteId: edited, text: STUDENT_TEXT })).note;
      assert.equal(note.state, "edited");
      assert.ok(allText(note).includes(STUDENT_TEXT));
    });

    await steps.step("(2b) the schedule changes; after the refresh the edit is kept and the untouched note is rebuilt", async () => {
      const changed = DEFAULT_SESSIONS.map((s) => (s.key === "lec-1" ? { ...s, title: "Lecture 1: Claims and counterclaims" } : s.key === "lec-2" ? { ...s, title: "Lecture 2: Evidence and sources" } : s));
      await execute(page, { type: "import", batch: scheduleBatch(changed) });
      const rebuilt = await waitFor(
        "the untouched note rebuilt",
        async () => (await notes(page, { op: "notes.open", noteId: untouched.id })).note,
        (n) => allText(n).includes("Lecture 2: Evidence and sources"),
      );
      assert.equal(rebuilt.state, "untouched");
      assert.ok(rebuilt.revision > untouched.revision, "a new version of the scaffold");
      assert.ok(!allText(rebuilt).includes("Lecture 2: Evidence\n"), "the old title is gone");
      const kept = (await notes(page, { op: "notes.open", noteId: edited })).note;
      assert.equal(kept.state, "edited");
      assert.ok(allText(kept).includes(STUDENT_TEXT), "the student's text is kept");
      assert.ok(!allText(kept).includes("Lecture 1: Claims and counterclaims"), "an edited note isn't rebuilt from the schedule");
    });
  } finally {
    await sys.close();
    await steps.report(sys.artifacts);
  }
});
