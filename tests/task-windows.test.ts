import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskWindowPage, TaskWindowRef, WorkSet } from "@magic/contracts";
import { allowedTaskUrls, createTaskWindows, helperRunner, sideFor, taskContextFrom, type TaskWindowHost } from "../apps/desktop/src/task-windows/controller";

// MHR 322 shape: Canvas instructions plus the project site the assignment links directly.
const MHR_ID = "3410f029-eb0c-43bf-908f-682ab1550ceb";
const PROJECT = "https://sites.google.com/undergroundshirts.com/mhr-322-ugp-t-shirt-project/home";
const CANVAS = "https://canvas.wisc.edu/courses/322/assignments/9";
const set: WorkSet = {
  previewHash: "b".repeat(64), assignmentId: MHR_ID, assignmentTitle: "UGP", contentHash: "m1", held: [], notes: [],
  items: [
    { resourceId: `${MHR_ID}:link:x`, title: "Project site", role: "material", provenance: "assignment_link", reason: "", target: { kind: "web", url: PROJECT } },
    { resourceId: MHR_ID, title: "UGP", role: "instructions", reason: "", target: { kind: "web", url: CANVAS } },
  ],
};
const pages: TaskWindowPage[] = [
  { key: "instructions", role: "instructions", url: CANVAS, title: "UGP", origin: "work_set" },
  { key: `item:${MHR_ID}:link:x`, role: "work", url: PROJECT, title: "Project site", origin: "work_set" },
];

/** A fake native helper: a browser process with windows; records every request. */
function fakeHelper(options: { accessibility?: boolean; newWindow?: boolean } = {}) {
  const calls: Record<string, unknown>[] = [];
  const present = new Set<number>([1, 2]); // the student's unrelated windows
  let next = 100;
  const run = async (request: Record<string, unknown>) => {
    calls.push(request);
    switch (request.action) {
      case "status": return { event: "status", name: "Firefox.app", bundleId: "org.mozilla.firefox", family: "firefox", newWindow: options.newWindow ?? true, accessibility: options.accessibility ?? true };
      case "open": {
        const n = next++; present.add(n);
        const side = request.side as string;
        return { event: "opened", pid: 42, windowNumber: n, bundleId: "org.mozilla.firefox", placed: side !== "none" && (options.accessibility ?? true), placeReason: options.accessibility === false ? "accessibility_required" : undefined, area: side === "none" ? undefined : { x: 0, y: 25, w: 1440, h: 875 } };
      }
      case "list": return { event: "listed", windows: (request.windows as number[]).map(n => ({ windowNumber: n, present: present.has(n) })) };
      case "focus": return { event: "focused", windows: (request.windows as number[]).map(n => ({ windowNumber: n, state: present.has(n) ? "focused" : "missing" })) };
      case "close": return { event: "closed", windows: (request.windows as number[]).map(n => { const had = present.delete(n); return { windowNumber: n, state: had ? "closed" : "missing" }; }) };
      default: return { event: "error", code: "unsupported_action" };
    }
  };
  return { calls, present, run };
}
function host(helper: ReturnType<typeof fakeHelper>, patch: Partial<TaskWindowHost> = {}): TaskWindowHost {
  return {
    run: helper.run, headless: false, beforeOpen: async () => {},
    context: async (accountScope, resourceId) => {
      if (accountScope !== "uw" || resourceId !== MHR_ID) throw new Error("This task isn't available for this account.");
      return { workSet: set, gitlabUrls: [] };
    },
    now: () => new Date("2026-09-27T10:00:00Z"), ...patch,
  };
}

test("open: instructions LEFT, project RIGHT on the same screen area, each a new observed window", async () => {
  const helper = fakeHelper();
  const tw = createTaskWindows(host(helper));
  const result = await tw.handle({ action: "open", accountScope: "uw", resourceId: MHR_ID, pages });
  const opens = helper.calls.filter(c => c.action === "open");
  assert.deepEqual(opens.map(c => [c.url, c.side]), [[CANVAS, "left"], [PROJECT, "right"]]);
  assert.equal(opens[0]!.area, undefined);
  assert.deepEqual(opens[1]!.area, { x: 0, y: 25, w: 1440, h: 875 }, "the right half uses the left window's screen");
  assert.deepEqual(result.windows.map(w => [w.key, w.windowNumber, w.placed]), [["instructions", 100, true], [pages[1]!.key, 101, true]]);
  assert.deepEqual(result.outcomes.map(o => o.state), ["new_window", "new_window"]);
  assert.ok(!helper.calls.some(c => (c.windows as number[] | undefined)?.some(n => n === 1 || n === 2)), "unrelated windows are never named");
});

test("open refuses pages outside the saved task, other accounts, and http; GitLab is allowed only from course links", async () => {
  const helper = fakeHelper();
  const tw = createTaskWindows(host(helper));
  const result = await tw.handle({ action: "open", accountScope: "uw", resourceId: MHR_ID, pages: [
    { key: "evil", role: "work", url: "https://evil.example/", title: "x", origin: "work_set" },
    { key: "gl", role: "work", url: "https://git.doit.wisc.edu/guess/project", title: "x", origin: "gitlab" },
    { key: "http", role: "support", url: "http://sites.google.com/x", title: "x", origin: "student" },
    { key: "left", role: "instructions", url: PROJECT, title: "x", origin: "work_set" },
    { key: "mine", role: "support", url: "https://docs.example/notes", title: "My notes", origin: "student" },
  ] });
  assert.deepEqual(result.outcomes.map(o => [o.key, o.state]), [["evil", "not_sent"], ["gl", "not_sent"], ["http", "not_sent"], ["left", "not_sent"], ["mine", "new_window"]]);
  assert.deepEqual(helper.calls.filter(c => c.action === "open").map(c => [c.url, c.side]), [["https://docs.example/notes", "none"]], "a support page is never placed");
  await assert.rejects(tw.handle({ action: "open", accountScope: "someone-else", resourceId: MHR_ID, pages }), /isn't available for this account/);
  await assert.rejects(tw.handle({ action: "open", accountScope: "uw", resourceId: MHR_ID, pages: [{ ...pages[0]!, extra: 1 }] }));
  assert.deepEqual([...allowedTaskUrls(set, ["https://git.doit.wisc.edu/cs/p"]).values()], ["work_set", "work_set", "gitlab"]);
  assert.equal(sideFor("instructions", [{ role: "instructions" }]), "none", "one page alone is not split");
  const tool = await createTaskWindows(host(fakeHelper())).handle({ action: "open", accountScope: "uw", resourceId: MHR_ID, pages: [pages[0]!, { key: "tool", role: "work", url: "https://piazza.com/class/x", title: "Piazza", origin: "student" }] });
  assert.deepEqual(tool.outcomes.map(o => o.state), ["new_window", "new_window"], "a page the student chose can be the right window");
});

test("Continue brings back existing windows without duplicates and reopens only a closed one", async () => {
  const helper = fakeHelper();
  const tw = createTaskWindows(host(helper));
  const opened = await tw.handle({ action: "open", accountScope: "uw", resourceId: MHR_ID, pages });
  helper.present.delete(opened.windows[1]!.windowNumber); // the student closed the project window
  helper.calls.length = 0;
  const result = await tw.handle({ action: "continue", accountScope: "uw", resourceId: MHR_ID, pages, windows: opened.windows });
  assert.deepEqual(helper.calls.map(c => c.action), ["status", "list", "focus", "open"]);
  assert.deepEqual(helper.calls.find(c => c.action === "open")!.url, PROJECT);
  assert.deepEqual(result.outcomes.map(o => [o.key, o.state]), [["instructions", "focused"], [pages[1]!.key, "new_window"]]);
  assert.equal(result.windows.length, 2);
  helper.calls.length = 0;
  const again = await tw.handle({ action: "continue", accountScope: "uw", resourceId: MHR_ID, pages, windows: result.windows });
  assert.ok(!helper.calls.some(c => c.action === "open"), "nothing is reopened while both windows exist");
  assert.deepEqual(again.outcomes.map(o => o.state), ["focused", "focused"]);
});

test("close affects only this task's windows; another task can't claim them", async () => {
  const helper = fakeHelper();
  const tw = createTaskWindows(host(helper, { context: async () => ({ workSet: set, gitlabUrls: [] }) }));
  const opened = await tw.handle({ action: "open", accountScope: "uw", resourceId: MHR_ID, pages });
  const stolen = await tw.handle({ action: "close", accountScope: "uw", resourceId: "another-task", windows: opened.windows });
  assert.ok(stolen.outcomes.every(o => o.state === "not_sent"));
  assert.ok(!helper.calls.some(c => c.action === "close"));
  const closed = await tw.handle({ action: "close", accountScope: "uw", resourceId: MHR_ID, windows: opened.windows });
  assert.deepEqual(closed.outcomes.map(o => o.state), ["closed", "closed"]);
  assert.deepEqual(closed.windows, []);
  assert.deepEqual([...helper.present].sort(), [1, 2], "unrelated windows stay open");
});

test("without Accessibility: windows still open and are identified, but nothing is placed, raised or closed", async () => {
  const helper = fakeHelper({ accessibility: false });
  const tw = createTaskWindows(host(helper));
  const opened = await tw.handle({ action: "open", accountScope: "uw", resourceId: MHR_ID, pages });
  assert.deepEqual(opened.outcomes.map(o => o.state), ["new_window_unplaced", "new_window_unplaced"]);
  assert.match(opened.outcomes[0]!.detail!, /Allow window arrangement/);
  const cont = await tw.handle({ action: "continue", accountScope: "uw", resourceId: MHR_ID, pages, windows: opened.windows });
  assert.deepEqual(cont.outcomes.map(o => o.state), ["present", "present"]);
  const close = await tw.handle({ action: "close", accountScope: "uw", resourceId: MHR_ID, windows: opened.windows });
  assert.deepEqual(close.outcomes.map(o => o.state), ["present", "present"]);
  assert.ok(!helper.calls.some(c => c.action === "focus" || c.action === "close"));
});

test("unsupported browser, headless and refused consent never send anything", async () => {
  const safari = fakeHelper({ newWindow: false });
  const r1 = await createTaskWindows(host(safari)).handle({ action: "open", accountScope: "uw", resourceId: MHR_ID, pages });
  assert.ok(r1.outcomes.every(o => o.state === "not_sent" && /new window/.test(o.detail!)));
  const quiet = fakeHelper();
  const r2 = await createTaskWindows(host(quiet, { headless: true })).handle({ action: "open", accountScope: "uw", resourceId: MHR_ID, pages });
  assert.equal(r2.mode, "test_only");
  assert.ok(r2.outcomes.every(o => o.state === "test_only"));
  assert.equal(quiet.calls.length, 0);
  const refused = fakeHelper();
  const r3 = await createTaskWindows(host(refused, { beforeOpen: async () => { throw new Error("Finish the setup step first."); } })).handle({ action: "open", accountScope: "uw", resourceId: MHR_ID, pages });
  assert.ok(r3.outcomes.every(o => o.state === "not_sent"));
  assert.ok(!refused.calls.some(c => c.action === "open"));
});

test("account guard: the assignment's own source must be this account's", () => {
  const result = { workSet: set, snapshot: { resources: [{ id: MHR_ID, sourceId: "s1", courseId: "322" }], sources: [{ id: "s1", accountScope: "uw" }], gitlabLinks: [{ accountScope: "uw", courseId: "322", projectPath: "a/b" }, { accountScope: "other", courseId: "322", projectPath: "c/d" }] } };
  assert.deepEqual(taskContextFrom(result, "uw", MHR_ID, "https://git.doit.wisc.edu").gitlabUrls, ["https://git.doit.wisc.edu/a/b"]);
  assert.throws(() => taskContextFrom(result, "other", MHR_ID, "https://git.doit.wisc.edu"), /isn't available/);
});

test("helper runner: one JSON line each way; a missing or silent helper is reported, not waited on", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-window-helper-"));
  const echo = join(dir, "echo");
  await writeFile(echo, `#!${process.execPath}\nlet s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify({event:"status",got:r.action}))});\n`);
  await chmod(echo, 0o755);
  assert.deepEqual(await helperRunner(echo)({ action: "status" }, 5000), { event: "status", got: "status" });
  await assert.rejects(helperRunner(join(dir, "missing"))({ action: "status" }, 5000), /helper_missing/);
  const silent = join(dir, "silent");
  await writeFile(silent, `#!${process.execPath}\nsetTimeout(()=>{}, 60000);\n`);
  await chmod(silent, 0o755);
  await assert.rejects(helperRunner(silent)({ action: "status" }, 300), /helper_failed/);
});

test("unknown or edited renderer references never claim unrelated windows or silently reopen them", async () => {
  const helper = fakeHelper();
  const tw = createTaskWindows(host(helper));
  const opened = await tw.handle({ action: "open", accountScope: "uw", resourceId: MHR_ID, pages });
  const forged = { ...opened.windows[0]!, windowNumber: 1 };
  for (const action of ["close", "continue"] as const) {
    helper.calls.length = 0;
    const result = await tw.handle({ action, accountScope: "uw", resourceId: MHR_ID, windows: [forged], ...(action === "continue" ? { pages: [pages[0]!] } : {}) });
    assert.equal(result.outcomes[0]?.state, "not_sent");
    assert.deepEqual(helper.calls.map(c => c.action), ["status"]);
    assert.ok(helper.present.has(1));
  }
  helper.calls.length = 0;
  const changed = await tw.handle({ action: "close", accountScope: "uw", resourceId: MHR_ID, windows: [{ ...opened.windows[0]!, bundleId: "another.browser" }] });
  assert.equal(changed.outcomes[0]?.state, "not_sent");
  assert.deepEqual(helper.calls.map(c => c.action), ["status"]);
  const restarted = createTaskWindows(host(helper));
  helper.calls.length = 0;
  const resumed = await restarted.handle({ action: "continue", accountScope: "uw", resourceId: MHR_ID, pages, windows: opened.windows });
  assert.ok(resumed.outcomes.every(o => o.state === "not_sent"));
  assert.deepEqual(helper.calls.map(c => c.action), ["status"], "restart cannot claim old windows or create duplicates implicitly");
});

test("source admission is rechecked after consent before each browser effect", async () => {
  const helper = fakeHelper();
  let revoked = false;
  const tw = createTaskWindows(host(helper, {
    beforeOpen: async () => { revoked = true; },
    context: async () => {
      if (revoked) throw new Error("Account access changed.");
      return { workSet: set, gitlabUrls: [] };
    },
  }));
  const result = await tw.handle({ action: "open", accountScope: "uw", resourceId: MHR_ID, pages });
  assert.ok(result.outcomes.every(o => o.state === "not_sent" && o.detail === "Account access changed."));
  assert.ok(!helper.calls.some(c => c.action === "open"));
});

test("headless capability and permission requests do not consult the real browser", async () => {
  const helper = fakeHelper();
  const tw = createTaskWindows(host(helper, { headless: true }));
  for (const action of ["status", "request-access"] as const) {
    assert.equal((await tw.handle({ action })).mode, "test_only");
  }
  assert.equal(helper.calls.length, 0);
});

test("failed window observation never implies closed or silently reopens pages", async () => {
  const helper = fakeHelper();
  let unavailable = false;
  const tw = createTaskWindows(host(helper, { run: async (request) => {
    if (unavailable && request.action === "list") throw new Error("temporarily unavailable");
    return helper.run(request);
  } }));
  const opened = await tw.handle({ action: "open", accountScope: "uw", resourceId: MHR_ID, pages });
  unavailable = true; helper.calls.length = 0;
  const resumed = await tw.handle({ action: "continue", accountScope: "uw", resourceId: MHR_ID, pages, windows: opened.windows });
  assert.ok(resumed.outcomes.every(o => o.state === "not_sent"));
  assert.deepEqual(resumed.windows, opened.windows);
  assert.ok(!helper.calls.some(c => ["open", "focus", "close"].includes(String(c.action))));
});
