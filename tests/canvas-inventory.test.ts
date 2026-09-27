import test from "node:test";
import assert from "node:assert/strict";
import { CanvasHttp, checkedCanvasUrl } from "../packages/connectors/src/canvas-http";
import {
  accessSummary,
  buildInventory,
  checkSpaceAccess,
  readCanvasInventory,
  type AccessResponse,
  type CourseSpace,
  type InventoryParts,
} from "../packages/connectors/src/canvas-inventory";
import {
  checkedSpaceProbeUrl,
  classifyHost,
  hostTable,
  isLaunchUrl,
} from "../packages/connectors/src/space-hosts";

// Entirely synthetic: canvas.wisc.edu is only the origin string; no request leaves the test.
const origin = "https://canvas.wisc.edu";
const courseId = "4242";
const tabs = [
  { id: "home", html_url: `/courses/${courseId}`, label: "Home", type: "internal", position: 1 },
  { id: "modules", html_url: `/courses/${courseId}/modules`, label: "Modules", type: "internal", position: 2 },
  { id: "files", html_url: `/courses/${courseId}/files`, label: "Files", type: "internal", position: 3 },
  { id: "grades", html_url: `/courses/${courseId}/grades`, label: "Grades", type: "internal", position: 4 },
  {
    id: "context_external_tool_77",
    html_url: `/courses/${courseId}/external_tools/77`,
    label: "Top Hat",
    type: "external",
    position: 5,
    url: `${origin}/api/v1/courses/${courseId}/external_tools/sessionless_launch?id=77&launch_type=course_navigation`,
  },
  {
    id: "context_external_tool_78",
    html_url: `/courses/${courseId}/external_tools/78`,
    label: "Honorlock",
    type: "external",
    position: 6,
    url: `${origin}/api/v1/courses/${courseId}/external_tools/sessionless_launch?id=78`,
  },
];
const tools = [
  { id: 77, name: "Top Hat", domain: "app.tophat.com", url: "https://app.tophat.com/lti/launch" },
  { id: 78, name: "Honorlock", url: "https://app.honorlock.com/lti" },
  { id: 79, name: "Gradescope", url: "https://www.gradescope.com/auth/lti13/launch" },
];
const modules = [
  {
    id: 1,
    name: "Week 1",
    items: [
      { id: 11, module_id: 1, title: "Week 1", type: "SubHeader" },
      { id: 12, module_id: 1, title: "Lecture notes", type: "Page", page_url: "lecture-1" },
      { id: 13, module_id: 1, title: "Slides", type: "File", content_id: 900 },
      {
        id: 14,
        module_id: 1,
        title: "Lecture recording",
        type: "ExternalUrl",
        external_url: "https://mediaspace.wisc.edu/media/Lecture+1/1_abc?st=SYNTHETIC_TOKEN",
      },
      {
        id: 15,
        module_id: 1,
        title: "Homework 1",
        type: "ExternalTool",
        external_url: "https://www.gradescope.com/auth/lti13/launch",
        content_details: { due_at: "2026-10-02T04:59:00Z", points_possible: 20 },
      },
      {
        id: 16,
        module_id: 1,
        title: "Course site",
        type: "ExternalUrl",
        external_url: "https://pages.cs.wisc.edu/~synthetic/course/",
      },
    ],
  },
];
const resources: InventoryParts["resources"] = [
  {
    externalId: "syllabus",
    kind: "material",
    url: `${origin}/courses/${courseId}/assignments/syllabus`,
    title: "Syllabus",
    text: "Synthetic syllabus.",
    deleted: false,
    links: [
      { url: "https://uwmadison.box.com/s/synthetic" },
      { url: "https://example-synthetic.test/notes" },
      { url: `${origin}/courses/${courseId}/pages/lecture-1` },
      { url: `${origin}/courses/${courseId}/external_tools/80` },
      { url: "https://git.doit.wisc.edu/synthetic/course-code" },
    ],
  },
  {
    externalId: "12",
    kind: "material",
    url: `${origin}/courses/${courseId}/pages/lecture-1`,
    title: "Lecture notes",
    text: "Stored page text.",
    deleted: false,
    links: [{ url: "https://piazza.com/class/synthetic" }],
  },
];
const parts: InventoryParts = {
  origin,
  courseId,
  tabs: tabs as InventoryParts["tabs"],
  tools: tools.map((t) => ({ ...t, id: String(t.id) })),
  modules: modules.map((m) => ({
    ...m,
    id: String(m.id),
    items: m.items.map((i) => ({ ...i, id: String(i.id), module_id: String(i.module_id), ...("content_id" in i ? { content_id: String(i.content_id) } : {}) })),
  })) as InventoryParts["modules"],
  resources,
};
const byUrl = (spaces: CourseSpace[], url: string) => {
  const space = spaces.find((s) => s.url === url);
  assert.ok(space, `missing space ${url}`);
  return space;
};

test("the host table maps each known host to a kind and to store or link; unknown hosts go to Jev", () => {
  const store = hostTable.filter((r) => r.treatment === "store").map((r) => r.name);
  const link = hostTable.filter((r) => r.treatment === "link").map((r) => r.name);
  assert.deepEqual(store.sort(), ["Canvas", "GitHub", "UW GitLab", "UW site"].sort());
  for (const name of ["Kaltura MediaSpace", "Top Hat", "Piazza", "Gradescope", "Honorlock", "Box"])
    assert.ok(link.includes(name), name);
  assert.equal(classifyHost("app.tophat.com").rule.name, "Top Hat");
  assert.equal(classifyHost("pages.cs.wisc.edu").rule.kind, "course_site");
  assert.equal(classifyHost("mediaspace.wisc.edu").rule.kind, "video");
  assert.equal(classifyHost("example-synthetic.test").jev, true);
  assert.equal(classifyHost("example-synthetic.test").rule.kind, "unknown");
});

test("the inventory records every space with kind, host, url, where it was found, route, label and read state", () => {
  const spaces = buildInventory(parts);
  for (const space of spaces) {
    assert.ok(space.id && space.courseId === courseId && space.host && space.label);
    assert.equal(new URL(space.url).search, "", space.url);
    assert.ok(!space.url.includes("SYNTHETIC_TOKEN"));
  }
  // Tabs: content tabs and LTI tabs; Grades isn't a content space.
  assert.equal(spaces.some((s) => s.url.endsWith("/grades")), false);
  const tophat = byUrl(spaces, `${origin}/courses/${courseId}/external_tools/77`);
  assert.deepEqual(
    [tophat.kind, tophat.foundIn, tophat.route, tophat.treatment, tophat.platform, tophat.readState],
    ["polling", "tab", "lti_launch", "link", "Top Hat", "linked"],
  );
  assert.match(tophat.launchEffect ?? "", /enrols/);
  // An installed tool with no tab is still inventoried (as an LTI link card).
  const gradescopeTool = byUrl(spaces, `${origin}/courses/${courseId}/external_tools/79`);
  assert.equal(gradescopeTool.foundIn, "external_tool");
  // Module items by type.
  const page = byUrl(spaces, `${origin}/courses/${courseId}/pages/lecture-1`);
  assert.deepEqual([page.kind, page.foundIn, page.treatment, page.readState], ["canvas_page", "module_item", "store", "read"]);
  const file = byUrl(spaces, `${origin}/courses/${courseId}/files/900`);
  assert.deepEqual([file.kind, file.readState], ["canvas_file", "unread"]);
  const video = byUrl(spaces, "https://mediaspace.wisc.edu/media/Lecture+1/1_abc");
  assert.deepEqual([video.kind, video.route, video.treatment], ["video", "uw_session", "link"]);
  const homework = byUrl(spaces, `${origin}/courses/${courseId}/modules/items/15`);
  assert.deepEqual([homework.kind, homework.route, homework.dueAt, homework.points], ["homework", "lti_launch", "2026-10-02T04:59:00Z", 20]);
  const site = byUrl(spaces, "https://pages.cs.wisc.edu/~synthetic/course/");
  assert.deepEqual([site.kind, site.treatment, site.route], ["course_site", "store", "public"]);
  // Syllabus and body links.
  const box = byUrl(spaces, "https://uwmadison.box.com/s/synthetic");
  assert.deepEqual([box.foundIn, box.route, box.treatment], ["syllabus", "own_login", "link"]);
  const unknown = byUrl(spaces, "https://example-synthetic.test/notes");
  assert.deepEqual([unknown.jev, unknown.kind, unknown.treatment], [true, "unknown", "link"]);
  const bodyTool = byUrl(spaces, `${origin}/courses/${courseId}/external_tools/80`);
  assert.deepEqual([bodyTool.kind, bodyTool.route], ["lti_tool", "lti_launch"]);
  const piazza = byUrl(spaces, "https://piazza.com/class/synthetic");
  assert.equal(piazza.foundIn, "body");
  // A URL found twice is one space, kept from its first place (the module item, not the syllabus).
  assert.equal(spaces.filter((s) => s.url.endsWith("/pages/lecture-1")).length, 1);
});

/** A synthetic Canvas that records every URL it's asked for. */
function syntheticCanvas(extra: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {
    [`/api/v1/courses/${courseId}/tabs`]: tabs,
    [`/api/v1/courses/${courseId}/external_tools`]: tools,
    [`/api/v1/courses/${courseId}/modules`]: modules,
    ...extra,
  };
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push(url);
    assert.equal(init?.method, "GET");
    const body = bodies[new URL(url).pathname];
    return new Response(JSON.stringify(body ?? { errors: [] }), {
      status: body ? 200 : 404,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, http: new CanvasHttp({ fetch, origin, sleep: async () => {} }) };
}

test("the reader lists tabs, tools and modules with items in 3 GETs and never requests a launch", async () => {
  const { calls, http } = syntheticCanvas();
  const read = await readCanvasInventory(http, { id: courseId }, resources);
  assert.equal(read.status, "ok");
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((u) => new URL(u).pathname).sort(),
    [
      `/api/v1/courses/${courseId}/external_tools`,
      `/api/v1/courses/${courseId}/modules`,
      `/api/v1/courses/${courseId}/tabs`,
    ],
  );
  assert.ok(new URL(calls.find((u) => u.includes("/modules"))!).searchParams.getAll("include[]").includes("items"));
  for (const url of calls) {
    assert.ok(!/sessionless_launch|\/external_tools\/\d|\/modules\/items\//.test(url), url);
  }
  assert.ok(read.moduleHash && read.spaces.length > 8);
});

test("a failed list is partial; the others still produce spaces", async () => {
  const { http } = syntheticCanvas({ [`/api/v1/courses/${courseId}/tabs`]: undefined });
  const read = await readCanvasInventory(http, { id: courseId }, resources);
  assert.equal(read.status, "partial");
  assert.match(read.failures.tabs ?? "", /inaccessible/);
  assert.ok(read.spaces.some((s) => s.foundIn === "module_item"));
});

test("the LTI guard: the Canvas allowlist refuses launches; the space check refuses them and unknown hosts", () => {
  for (const path of [
    `/api/v1/courses/${courseId}/external_tools/sessionless_launch?id=77`,
    `/api/v1/courses/${courseId}/external_tools/77`,
    `/api/v1/courses/${courseId}/assignments/5/sessionless_launch`,
    `/api/v1/courses/${courseId}/files?per_page=1`,
  ])
    assert.throws(() => checkedCanvasUrl(`${origin}${path}`, origin), path);
  for (const path of [
    `/api/v1/courses/${courseId}/tabs`,
    `/api/v1/courses/${courseId}/external_tools?per_page=100`,
    `/api/v1/courses/${courseId}/files?sort=updated_at&order=desc&per_page=1`,
    `/api/v1/courses/${courseId}/pages?sort=updated_at&order=desc&per_page=1`,
    `/api/v1/courses/${courseId}/activity_stream/summary`,
  ])
    assert.doesNotThrow(() => checkedCanvasUrl(`${origin}${path}`, origin), path);
  assert.equal(checkedSpaceProbeUrl("https://mediaspace.wisc.edu/media/x/1_abc"), "https://mediaspace.wisc.edu/media/x/1_abc");
  for (const url of [
    "http://mediaspace.wisc.edu/media/x",
    "https://mediaspace.wisc.edu/lti/launch",
    "https://example-synthetic.test/",
    "https://pages.cs.wisc.edu/~synthetic/",
    "https://www.gradescope.com/courses/1",
    `${origin}/courses/${courseId}/external_tools/77`,
  ])
    assert.throws(() => checkedSpaceProbeUrl(url), url);
});

test("D41: each access state, with no request for LTI, own-login or link-only spaces", async () => {
  const spaces = buildInventory(parts);
  const session: string[] = [],
    publicCalls: string[] = [];
  const replies: Record<string, AccessResponse | Error> = {
    "https://mediaspace.wisc.edu/media/Lecture+1/1_abc": { status: 302, location: "https://login.wisc.edu/idp/profile/SAML2/Redirect/SSO" },
    "https://git.doit.wisc.edu/synthetic/course-code": { status: 200, body: "<html><title>course-code</title></html>" },
    "https://pages.cs.wisc.edu/~synthetic/course/": { status: 200, body: "<h1>Course</h1>" },
    "https://example-synthetic.test/notes": new Error("unreachable"),
  };
  const reply = (list: string[]) => async (url: string) => {
    list.push(url);
    const value = replies[url];
    if (!value) throw new Error(`unexpected ${url}`);
    if (value instanceof Error) throw value;
    return value;
  };
  const checked = await checkSpaceAccess(spaces, {
    session: reply(session),
    public: reply(publicCalls),
    now: () => new Date("2026-09-27T12:00:00Z"),
    canvas: (space) =>
      space.url.endsWith("/files") ? { state: "blocked", reason: "inaccessible" } : { state: "readable" },
  });
  const state = (url: string) => byUrl(checked, url).access;
  assert.deepEqual(session.sort(), ["https://git.doit.wisc.edu/synthetic/course-code", "https://mediaspace.wisc.edu/media/Lecture+1/1_abc"]);
  assert.deepEqual(publicCalls.sort(), ["https://example-synthetic.test/notes", "https://pages.cs.wisc.edu/~synthetic/course/"]);
  for (const url of [...session, ...publicCalls]) assert.equal(isLaunchUrl(url), false);
  assert.deepEqual(state("https://mediaspace.wisc.edu/media/Lecture+1/1_abc"), {
    state: "needs-uw-signin",
    reason: "redirected_to_sign_in",
    checkedAt: "2026-09-27T12:00:00.000Z",
    action: "sign_in_app_window",
  });
  assert.equal(state("https://git.doit.wisc.edu/synthetic/course-code").state, "readable");
  assert.equal(state("https://pages.cs.wisc.edu/~synthetic/course/").state, "readable");
  assert.deepEqual([state("https://example-synthetic.test/notes").state, state("https://example-synthetic.test/notes").reason], ["blocked", "unreachable"]);
  assert.deepEqual([state("https://uwmadison.box.com/s/synthetic").state, state("https://uwmadison.box.com/s/synthetic").action], ["needs-own-login", "open_in_browser"]);
  assert.equal(state("https://piazza.com/class/synthetic").state, "needs-own-login");
  const tophat = state(`${origin}/courses/${courseId}/external_tools/77`);
  assert.deepEqual([tophat.state, tophat.action], ["link-only", "open_in_browser"]);
  const honorlock = state(`${origin}/courses/${courseId}/external_tools/78`);
  assert.deepEqual([honorlock.state, honorlock.action], ["link-only", "none"]);
  assert.equal(state(`${origin}/courses/${courseId}/modules/items/15`).state, "link-only");
  assert.equal(state(`${origin}/courses/${courseId}/files`).state, "blocked");
  assert.equal(state(`${origin}/courses/${courseId}/pages/lecture-1`).state, "readable");
  for (const space of checked) assert.equal(space.access.checkedAt, "2026-09-27T12:00:00.000Z");

  const [summary] = accessSummary(checked);
  assert.equal(summary?.courseId, courseId);
  assert.equal(summary?.counts["needs-uw-signin"], 1);
  assert.equal(summary?.counts["needs-own-login"], 2);
  assert.equal(summary?.needSignIn, 3);
  assert.equal(summary?.chip, "3 sources need a sign-in");
  assert.equal(summary?.actions[0]?.action, "sign_in_app_window");
  assert.equal(summary?.actions.some((a) => a.state === "readable"), false);
  assert.equal(
    summary?.counts.readable! + summary?.counts["needs-uw-signin"]! + summary?.counts["needs-own-login"]! + summary?.counts["link-only"]! + summary?.counts.blocked!,
    checked.length,
  );

  // A recheck (content probe) only touches what isn't readable, and a sign-in clears it.
  replies["https://mediaspace.wisc.edu/media/Lecture+1/1_abc"] = { status: 200, body: "<h1>Video</h1>" };
  session.length = 0;
  publicCalls.length = 0;
  const rechecked = await checkSpaceAccess(checked, {
    session: reply(session),
    public: reply(publicCalls),
    now: () => new Date("2026-09-27T12:15:00Z"),
    canvas: () => ({ state: "readable" }),
    only: (space) => space.access.state !== "readable",
  });
  assert.deepEqual(session, ["https://mediaspace.wisc.edu/media/Lecture+1/1_abc"]);
  assert.equal(byUrl(rechecked, "https://mediaspace.wisc.edu/media/Lecture+1/1_abc").access.state, "readable");
  assert.equal(byUrl(rechecked, "https://git.doit.wisc.edu/synthetic/course-code").access.checkedAt, "2026-09-27T12:00:00.000Z");
  assert.equal(accessSummary([])[0], undefined);
});

test("a login page served with 200, or a 403 on a UW host, reads as needing the UW sign-in", async () => {
  const spaces = buildInventory({
    ...parts,
    tabs: [],
    tools: [],
    modules: [],
    resources: [
      {
        ...resources[0]!,
        links: [
          { url: "https://mediaspace.wisc.edu/media/other" },
          { url: "https://pages.cs.wisc.edu/~synthetic/private/" },
          { url: "https://example-synthetic.test/private" },
        ],
      },
    ],
  });
  const checked = await checkSpaceAccess(spaces, {
    session: async () => ({ status: 200, body: '<form action="/idp/profile/SAML2"><input type="password"></form>' }),
    public: async () => ({ status: 403 }),
    now: () => new Date("2026-09-27T12:00:00Z"),
    canvas: () => ({ state: "readable" }),
  });
  const state = (url: string) => byUrl(checked, url).access.state;
  assert.equal(state("https://mediaspace.wisc.edu/media/other"), "needs-uw-signin");
  assert.equal(state("https://pages.cs.wisc.edu/~synthetic/private/"), "needs-uw-signin");
  assert.equal(state("https://example-synthetic.test/private"), "blocked");
});

test("wired into ingestion: a sync inventories each included course through the Canvas reader, GET only", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createStore } = await import("@magic/storage");
  const { createIngestion } = await import("../apps/desktop/src/ingestion");
  const { createSyntheticCanvasUniversity } = await import("../packages/connectors/src/canvas-fixture");
  const university = createSyntheticCanvasUniversity({ origin, rateLimit: false });
  const requested: string[] = [],
    spaceChecks: string[] = [],
    publicChecks: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), "magic-inventory-"));
  const store = createStore(join(directory, "db.sqlite"));
  const runtime = createIngestion(store, {
    directory,
    now: () => new Date("2026-09-26T15:00:00Z"),
    client: {
      isCanvas: (url) => new URL(url).origin === origin,
      async get(url) {
        publicChecks.push(url);
        throw new Error("offline");
      },
      async text(url) {
        publicChecks.push(url);
        throw new Error("offline");
      },
      async feed() {
        throw new Error("offline");
      },
      async signedDownload() {
        throw new Error("offline");
      },
    },
    async canvasFetch(url, init) {
      requested.push(url);
      assert.equal(init?.method, "GET");
      const path = new URL(url).pathname;
      const course = path.match(/^\/api\/v1\/courses\/(\d+)\/(tabs|external_tools)$/);
      if (course)
        return new Response(
          JSON.stringify(
            course[2] === "tabs"
              ? [
                  { id: "modules", html_url: `/courses/${course[1]}/modules`, label: "Modules", type: "internal" },
                  { id: "context_external_tool_9", html_url: `/courses/${course[1]}/external_tools/9`, label: "Piazza", type: "external", url: `${origin}/api/v1/courses/${course[1]}/external_tools/sessionless_launch?id=9` },
                ]
              : [{ id: 9, name: "Piazza", url: "https://piazza.com/lti" }],
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      return university.fetch(url, init);
    },
    async spaceFetch(url) {
      spaceChecks.push(url);
      return new Response("", { status: 302, headers: { location: "https://login.wisc.edu/idp" } });
    },
    async secrets() {
      return {};
    },
  });
  try {
    await runtime.tick("manual");
    const spaces = runtime.spaces();
    const courses = new Set(spaces.map((s) => s.courseId));
    assert.deepEqual([...courses].sort(), ["101", "102", "103", "104", "105"]);
    for (const url of requested) assert.ok(!/sessionless_launch|\/external_tools\/\d|\/modules\/items\//.test(url), url);
    assert.equal(spaceChecks.length, 0, "no UW single-sign-on host in the synthetic courses");
    for (const url of publicChecks) assert.equal(new URL(url).hostname, "courses.synthetic.test");
    const piazza = spaces.find((s) => s.courseId === "101" && s.label === "Piazza")!;
    assert.deepEqual([piazza.access.state, piazza.kind, piazza.route], ["link-only", "qa", "lti_launch"]);
    const site = spaces.find((s) => s.courseId === "101" && s.host === "courses.synthetic.test")!;
    assert.equal(site.access.state, "blocked");
    const summary = runtime.accessSummary().find((s) => s.courseId === "101")!;
    assert.ok(summary.counts["link-only"] >= 1);
    assert.ok(runtime.moduleHashes().size === 5);
  } finally {
    await runtime.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
