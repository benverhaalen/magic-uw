/**
 * The Canvas sync on a synthetic account sized like the operator's live one (live copy 2026-09-26:
 * 35 course rows = 6 current courses, 12 Ongoing/Supplemental shells, 10 concluded courses and 7
 * date-restricted id-only rows from the completed-enrollment list), with ~700 items, ~250 files,
 * ~50 modules, the Files tab hidden on 4 courses and the Pages list hidden on 3.
 *
 * Every answer is generated here (no network, no real course data) and held for a latency model
 * (150 ms per request, like evals/perf/baseline.ts LATENCY_MS) so the scheduler's concurrency and
 * ordering show. The whole desktop ingestion runs (createIngestion: refresh coordinator, probes,
 * connector, documents, inventory, ICS feeds), not the connector alone.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { captureBatchSchema, type CaptureBatch, type Store } from "@magic/contracts";
import { createCore } from "@magic/core";
import { createIngestion, ACQUISITION_APP } from "../../apps/desktop/src/ingestion";
import { pipelineJobRegistry } from "../../packages/core/src/jobs/default-registry";
import { canvasFileDownloadUrl } from "../../packages/connectors/src/canvas-file-download";
import { createPublicClient } from "../../packages/connectors/src/network";
import type { DocumentExtractor } from "../../packages/connectors/src/documents";
import fixture from "../../fixtures/course.json";

export const origin = "https://canvas.wisc.edu";
export const LATENCY_MS = 150;
const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "x-rate-limit-remaining": "700", "x-request-cost": "0.4", ...headers },
  });

export interface AccountShape {
  current: number;
  shells: number;
  concluded: number;
  restricted: number;
  assignmentsPerCourse: number;
  pagesPerCourse: number;
  filesPerCourse: number;
  modulesPerCourse: number;
  itemsPerModule: number;
  announcementsPerCourse: number;
  hiddenFiles: number[];
  hiddenPages: number[];
}
/** The live account's shape (see the file comment). */
export const LIVE_ACCOUNT: AccountShape = {
  current: 6,
  shells: 12,
  concluded: 10,
  restricted: 7,
  assignmentsPerCourse: 25,
  pagesPerCourse: 20,
  filesPerCourse: 42,
  modulesPerCourse: 8,
  itemsPerModule: 6,
  announcementsPerCourse: 10,
  hiddenFiles: [1001, 1003, 1004, 1005],
  hiddenPages: [1002, 1003, 1004],
};
const CURRENT_CODES = ["COMP SCI 400", "MATH 340", "STAT 340", "ECON 101", "PSYCH 202", "ENGL 100"];
const SHELL_NAMES = [
  "Student Org Alpha", "New Student Orientation", "Library Training Sandbox", "Community of Practice",
  "Advising Resources", "Career Fair Prep", "Research Group Commons", "Tutoring Center",
  "Honors Community", "Writing Center Workshops", "Study Abroad Info", "Residence Hall Community",
];

export interface AccountCounters {
  requests: number;
  byEndpoint: Map<string, number>;
  byUrl: Map<string, number>;
  courses: Set<string>;
  downloads: number;
  ics: number;
}
export function endpointOf(url: string): string {
  const u = new URL(url);
  const path = u.pathname
    .replace(/\/courses\/\d+/, "/courses/:id")
    .replace(/\/modules\/\d+\/items/, "/modules/:m/items")
    .replace(/\/pages\/[^/]+$/, "/pages/:slug")
    .replace(/\/files\/\d+/, "/files/:id")
    .replace(/\/feeds\/calendars\/[^/]+$/, "/feeds/calendars/:feed");
  const keys = ["enrollment_state", "sort", "only_active_courses"]
    .filter((k) => u.searchParams.has(k))
    .map((k) => `${k}=${u.searchParams.get(k)}`);
  return keys.length ? `${path}?${keys.join("&")}` : path;
}

export function syntheticAccount(shape: AccountShape = LIVE_ACCOUNT, latencyMs = LATENCY_MS) {
  let revision = 0;
  const changed = new Map<string, number>(); // assignment id -> revision
  const current = Array.from({ length: shape.current }, (_, i) => 1001 + i);
  const shells = Array.from({ length: shape.shells }, (_, i) => 2001 + i);
  const concluded = Array.from({ length: shape.concluded }, (_, i) => 3001 + i);
  const restricted = Array.from({ length: shape.restricted }, (_, i) => 4001 + i);
  const courseRow = (id: number) => {
    const i = id - 1001;
    const spring = i === shape.current - 1;
    return {
      id,
      name: `${CURRENT_CODES[i % CURRENT_CODES.length]}: Synthetic course ${i + 1}`,
      course_code: CURRENT_CODES[i % CURRENT_CODES.length],
      workflow_state: "available",
      enrollments: [{ type: "student", enrollment_state: "active" }],
      term: spring
        ? { id: 49, name: "Spring 2025-2026", start_at: "2026-01-13T06:00:00Z", end_at: "2026-05-20T05:00:00Z" }
        : { id: 50, name: "Fall 2026-2027", start_at: "2026-09-01T05:00:00Z", end_at: "2026-12-23T06:00:00Z" },
      // The live account's sixth course: a Spring term, open to Sep 30 by the course's own dates.
      ...(spring ? { restrict_enrollments_to_course_dates: true } : {}),
      start_at: spring ? "2026-01-13T06:00:00Z" : "2026-09-02T05:00:00Z",
      end_at: spring ? "2026-09-30T05:00:00Z" : "2026-12-23T06:00:00Z",
      syllabus_body: `<p>Syllabus for course ${id}.</p><a href="${origin}/courses/${id}/files/${fileId(id, 0)}">Syllabus PDF</a>`,
      calendar: { ics: `${origin}/feeds/calendars/course_SYNTH${id}.ics` },
    };
  };
  const shellRow = (id: number) => ({
    id,
    name: SHELL_NAMES[(id - 2001) % SHELL_NAMES.length],
    course_code: `ORG-${id}`,
    workflow_state: "available",
    enrollments: [{ type: "student", enrollment_state: "active" }],
    term: { id: id % 2 ? 1 : 2, name: id % 2 ? "Ongoing" : "Supplemental" },
    syllabus_body: "",
    calendar: { ics: `${origin}/feeds/calendars/course_SYNTH${id}.ics` },
  });
  const concludedRow = (id: number) => ({
    id,
    name: `PAST ${100 + (id - 3000)}: Synthetic past course`,
    course_code: `PAST ${100 + (id - 3000)}`,
    workflow_state: "available",
    concluded: true,
    enrollments: [{ type: "student", enrollment_state: "active" }],
    term: { id: 40, name: "Fall 2024-2025", start_at: "2024-09-04T05:00:00Z", end_at: "2024-12-25T06:00:00Z" },
    calendar: { ics: `${origin}/feeds/calendars/course_SYNTH${id}.ics` },
  });
  function fileId(course: number, n: number) {
    return (course - 1000) * 1000 + n + 100000;
  }
  function pageSlug(course: number, n: number) {
    return `topic-${course}-${n}`;
  }
  const due = (course: number, n: number) =>
    new Date(Date.UTC(2026, 8, 20) + (n * 4 + (course % 3)) * 86400_000 + 23 * 3600_000).toISOString();
  function assignment(course: number, n: number) {
    const id = course * 100 + n;
    const rev = changed.get(String(id)) ?? 0;
    return {
      id,
      course_id: course,
      name: `Assignment ${n + 1}`,
      description: `<p>Complete part ${n + 1}.</p><a href="${origin}/courses/${course}/pages/${pageSlug(course, n % shape.pagesPerCourse)}">Instructions</a><a href="${origin}/courses/${course}/files/${fileId(course, (n * 2) % shape.filesPerCourse)}?verifier=SYNTH">Handout</a>`,
      created_at: "2026-09-01T12:00:00Z",
      updated_at: rev ? `2026-09-26T1${rev}:00:00Z` : "2026-09-10T12:00:00Z",
      due_at: rev ? new Date(Date.parse(due(course, n)) + rev * 86400_000).toISOString() : due(course, n),
      unlock_at: null,
      lock_at: null,
      points_possible: 10,
      assignment_group_id: 11,
      submission_types: ["online_upload"],
      workflow_state: "published",
      submission: { assignment_id: id, workflow_state: "unsubmitted", submitted_at: null, score: null, grade: null, late: false, missing: false, excused: false },
    };
  }
  function page(course: number, n: number, withBody: boolean) {
    const files = [fileId(course, (n * 2 + 1) % shape.filesPerCourse), fileId(course, (n * 2 + 2) % shape.filesPerCourse)];
    return {
      page_id: course * 100 + n,
      url: pageSlug(course, n),
      title: `Topic ${n + 1}`,
      updated_at: "2026-09-12T12:00:00Z",
      ...(withBody
        ? { body: `<h2>Topic ${n + 1}</h2><p>Lecture notes for topic ${n + 1} in course ${course}.</p>${files.map((f) => `<a href="${origin}/courses/${course}/files/${f}">Reading ${f}</a>`).join("")}` }
        : {}),
    };
  }
  function moduleItems(course: number, m: number) {
    return Array.from({ length: shape.itemsPerModule }, (_, k) => {
      const n = m * shape.itemsPerModule + k;
      const id = course * 1000 + n;
      const kind = k % 6;
      if (kind === 0) return { id, module_id: course * 100 + m, position: k + 1, type: "SubHeader", title: `Week ${m + 1}` };
      if (kind === 1 || kind === 4)
        return { id, module_id: course * 100 + m, position: k + 1, type: "Page", title: `Topic ${(n % shape.pagesPerCourse) + 1}`, page_url: pageSlug(course, n % shape.pagesPerCourse) };
      if (kind === 2 || kind === 5)
        return { id, module_id: course * 100 + m, position: k + 1, type: "File", title: `File ${n}`, content_id: fileId(course, n % shape.filesPerCourse) };
      return { id, module_id: course * 100 + m, position: k + 1, type: "Assignment", title: `Assignment ${(n % shape.assignmentsPerCourse) + 1}`, content_id: course * 100 + (n % shape.assignmentsPerCourse) };
    });
  }
  const counters: AccountCounters = { requests: 0, byEndpoint: new Map(), byUrl: new Map(), courses: new Set(), downloads: 0, ics: 0 };
  function count(url: string) {
    counters.requests++;
    const endpoint = endpointOf(url);
    counters.byEndpoint.set(endpoint, (counters.byEndpoint.get(endpoint) ?? 0) + 1);
    const key = url.replace(/([?&])end_date=[^&]*/, "$1");
    counters.byUrl.set(key, (counters.byUrl.get(key) ?? 0) + 1);
    const course = new URL(url).pathname.match(/\/courses\/(\d+)/)?.[1] ?? new URL(url).searchParams.get("context_codes[]")?.replace("course_", "");
    if (course) counters.courses.add(course);
  }
  function resetCounters() {
    counters.requests = 0;
    counters.byEndpoint.clear();
    counters.byUrl.clear();
    counters.courses.clear();
    counters.downloads = 0;
    counters.ics = 0;
  }
  function todo() {
    return current.flatMap((course) =>
      Array.from({ length: 2 }, (_, n) => ({ type: "submitting", course_id: course, assignment: assignment(course, n + 3) })),
    );
  }
  function upcoming() {
    return current.flatMap((course) =>
      Array.from({ length: 2 }, (_, n) => ({
        id: `assignment_${course * 100 + n + 3}`,
        context_code: `course_${course}`,
        title: `Assignment ${n + 4}`,
        start_at: assignment(course, n + 3).due_at,
        assignment: assignment(course, n + 3),
      })),
    );
  }
  function stream() {
    return current.flatMap((course) => [
      { id: course * 10 + 1, type: "Announcement", course_id: course, title: "Weekly update", message: "<p>Update</p>", created_at: "2026-09-20T12:00:00Z", updated_at: revision > 1 && course === 1002 ? "2026-09-26T16:00:00Z" : "2026-09-20T12:00:00Z" },
    ]);
  }
  async function api(url: string, signal?: AbortSignal | null): Promise<Response> {
    const u = new URL(url);
    const path = u.pathname;
    await sleep(latencyMs, signal);
    if (path === "/api/v1/users/self/profile") return json({ id: 777, name: "Synthetic student" });
    if (path === "/api/v1/courses") {
      const state = u.searchParams.get("enrollment_state");
      if (state === "completed") return json([...concluded.map(concludedRow), ...restricted.map((id) => ({ id, access_restricted_by_date: true }))]);
      return json([...current.map(courseRow), ...shells.map(shellRow)]);
    }
    if (path === "/api/v1/users/self/todo") return json(todo());
    if (path === "/api/v1/users/self/upcoming_events") return json(upcoming());
    if (path === "/api/v1/users/self/activity_stream") return json(stream());
    if (path === "/api/v1/users/self/activity_stream/summary") return json([{ type: "Announcement", count: 6 + revision, unread_count: 1 }]);
    if (path === "/api/v1/announcements") {
      const course = Number(u.searchParams.get("context_codes[]")?.replace("course_", ""));
      return json(Array.from({ length: shape.announcementsPerCourse }, (_, n) => ({
        id: course * 10 + n + 1,
        title: `Announcement ${n + 1}`,
        message: `<p>Reminder ${n + 1}.</p>`,
        context_code: `course_${course}`,
        posted_at: new Date(Date.UTC(2026, 8, 1 + n * 2)).toISOString(),
      })));
    }
    const meta = /^\/api\/v1\/files\/(\d+)$/.exec(path);
    if (meta) {
      const id = Number(meta[1]);
      const course = Math.floor((id - 100000) / 1000) + 1000;
      return json({
        id, folder_id: 1, display_name: `reading-${id}.txt`, filename: `reading-${id}.txt`, "content-type": "text/plain",
        size: 2048, updated_at: "2026-09-12T12:00:00Z", locked_for_user: false, hidden: false,
        context_type: "Course", context_id: String(course), url: `${origin}/files/${id}/download?download_frd=1&verifier=SYNTH`,
      });
    }
    const match = path.match(/^\/api\/v1\/courses\/(\d+)(.*)$/);
    if (!match) return json({ errors: [{ message: "not found" }] }, 404);
    const course = Number(match[1]),
      tail = match[2]!;
    if (!current.includes(course)) {
      // A past or shell course the student opened on demand: metadata-sized answers.
      if (tail === "/assignments") return json([]);
      if (tail === "/modules") return json([]);
      return json([]);
    }
    if (!tail) return json(courseRow(course));
    if (tail === "/assignments")
      return json(Array.from({ length: shape.assignmentsPerCourse }, (_, n) => assignment(course, n)));
    if (/^\/assignments\/\d+$/.test(tail)) {
      const n = Number(tail.split("/").pop()) - course * 100;
      return json(assignment(course, n));
    }
    if (tail === "/modules")
      return json(Array.from({ length: shape.modulesPerCourse }, (_, m) => {
        const items = moduleItems(course, m);
        return { id: course * 100 + m, name: `Week ${m + 1}`, position: m + 1, items_count: items.length, state: "unlocked", ...(u.searchParams.getAll("include[]").includes("items") ? { items } : {}) };
      }));
    const items = tail.match(/^\/modules\/(\d+)\/items$/);
    if (items) return json(moduleItems(course, Number(items[1]) - course * 100));
    if (tail === "/pages") {
      if (shape.hiddenPages.includes(course)) return json({ message: "That page has been disabled for this course" }, 404);
      if (u.searchParams.get("sort") === "updated_at") return json([page(course, 0, false)]);
      return json(Array.from({ length: shape.pagesPerCourse }, (_, n) => page(course, n, false)));
    }
    const slug = tail.match(/^\/pages\/(.+)$/);
    if (slug) {
      const n = Number(decodeURIComponent(slug[1]!).split("-").pop());
      return json(page(course, n, true));
    }
    if (tail === "/files") {
      if (shape.hiddenFiles.includes(course)) return json({ status: "unauthorized", errors: [{ message: "user not authorized to perform that action" }] }, 403);
      if (u.searchParams.get("sort") === "updated_at")
        return json([{ id: fileId(course, 0), display_name: "syllabus.txt", updated_at: "2026-09-12T12:00:00Z", size: 2048 }]);
      return json(Array.from({ length: shape.filesPerCourse }, (_, n) => ({
        id: fileId(course, n), folder_id: 1, display_name: `reading-${fileId(course, n)}.txt`, filename: `reading-${fileId(course, n)}.txt`,
        "content-type": "text/plain", size: 2048, updated_at: "2026-09-12T12:00:00Z",
      })));
    }
    if (tail === "/folders") return json([{ id: 1, name: "course files", files_count: shape.filesPerCourse, folders_count: 0 }]);
    if (tail === "/assignment_groups") return json([{ id: 11, name: "Homework", group_weight: 100 }]);
    if (tail === "/quizzes") return json(Array.from({ length: 3 }, (_, n) => ({ id: course * 10 + n, title: `Quiz ${n + 1}`, description: "<p>Practice.</p>", points_possible: 5 })));
    if (tail === "/discussion_topics") return json(Array.from({ length: 5 }, (_, n) => ({ id: course * 20 + n, title: `Discussion ${n + 1}`, message: "<p>Discuss.</p>" })));
    if (tail === "/students/submissions") return json([]);
    if (tail === "/tabs")
      return json([
        { id: "home", label: "Home", type: "internal", html_url: `/courses/${course}` },
        { id: "modules", label: "Modules", type: "internal", html_url: `/courses/${course}/modules` },
        { id: "assignments", label: "Assignments", type: "internal", html_url: `/courses/${course}/assignments` },
      ]);
    if (tail === "/external_tools") return json([]);
    return json({ errors: [{ message: "not found" }] }, 404);
  }
  async function canvasFetch(url: string, init?: RequestInit): Promise<Response> {
    count(url);
    if (canvasFileDownloadUrl(url, origin)) {
      await sleep(latencyMs, init?.signal);
      counters.downloads++;
      const id = /\/files\/(\d+)\/download/.exec(new URL(url).pathname)?.[1] ?? "0";
      return new Response(`Synthetic reading ${id}. Lecture notes about topic ${id}.\n`.repeat(40), {
        headers: { "content-type": "text/plain", "x-magic-host-class": "canvas" },
      });
    }
    return api(url, init?.signal);
  }
  const ics = (course: string) =>
    [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Synthetic//EN",
      "BEGIN:VEVENT", `UID:event-${course}-1@synthetic`, "DTSTAMP:20260901T120000Z",
      "DTSTART:20261001T150000Z", "DTEND:20261001T160000Z", `SUMMARY:Exam review ${course}`,
      `URL:${origin}/courses/${course}/calendar_events/1`, "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
  const client = createPublicClient({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (request) => {
      count(request.url.href);
      counters.ics++;
      await sleep(latencyMs, request.signal);
      const course = /course_SYNTH(\d+)\.ics$/.exec(request.url.pathname)?.[1] ?? "0";
      return new Response(ics(course), { headers: { "content-type": "text/calendar" } });
    },
  });
  return {
    canvasFetch,
    client,
    counters,
    resetCounters,
    current,
    shells,
    concluded,
    restricted,
    /** Moves one assignment's due date (a teacher edit): the change the hot probe must catch. */
    changeAssignment(course: number, n: number) {
      const id = String(course * 100 + n);
      changed.set(id, (changed.get(id) ?? 0) + 1);
      revision++;
    },
    shape,
  };
}

/** Records when each batch lands, so the milestones can be read afterwards. */
export function timedStore(store: Store, clock: () => number) {
  const landed: Array<{ at: number; batch: CaptureBatch }> = [];
  const proxy = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "ingest")
        return (batch: CaptureBatch) => {
          landed.push({ at: clock(), batch });
          return (value as Store["ingest"]).call(target, batch);
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { store: proxy as typeof store, landed };
}

const textExtractor: DocumentExtractor = {
  async extract(path) {
    const { readFile } = await import("node:fs/promises");
    const text = (await readFile(path, "utf8")).slice(0, 20_000);
    return { status: "ok", text, parts: [], pages: [], diagnostics: [] } as unknown as Awaited<ReturnType<DocumentExtractor["extract"]>>;
  },
};

export interface Milestones {
  agendaUsableMs: number | null;
  textUsableMs: number | null;
  filesDoneMs: number | null;
  syncMs: number;
}
function milestones(
  landed: Array<{ at: number; batch: CaptureBatch }>,
  start: number,
  end: number,
  current: number[],
  expectedPages: number,
): Milestones {
  const since = landed.filter((l) => l.at >= start);
  let agenda: number | null = null;
  const assignmentsDone = new Set<string>();
  const pages = new Set<string>();
  let text: number | null = null,
    files: number | null = null;
  for (const { at, batch } of since) {
    const course = batch.source.courseId ?? "";
    if (!current.includes(Number(course))) continue;
    if (batch.source.scope === "assignments" && batch.complete) {
      assignmentsDone.add(course);
      if (assignmentsDone.size === current.length && agenda === null) agenda = at - start;
    }
    if (/^(?:page|linked-page):/.test(batch.source.scope ?? "") && batch.status === "ok")
      for (const r of batch.resources) if (r.text.trim()) pages.add(r.url);
    if (text === null && pages.size >= expectedPages) text = at - start;
    if (/^document:/.test(batch.source.scope ?? "")) files = at - start;
  }
  return { agendaUsableMs: agenda, textUsableMs: text, filesDoneMs: files, syncMs: end - start };
}

export interface Scenario {
  name: string;
  trigger: string;
  requests: number;
  byEndpoint: Record<string, number>;
  duplicates: Record<string, number>;
  coursesRead: { current: number; shells: number; past: number };
  downloads: number;
  ics: number;
  milestones: Milestones;
  action?: string;
  warmCourses?: string[];
  derivationMs?: number;
}
function snapshot(
  name: string,
  trigger: string,
  account: ReturnType<typeof syntheticAccount>,
  m: Milestones,
  run?: { action?: string; warmCourses?: string[] },
): Scenario {
  const c = account.counters;
  const read = [...c.courses].map(Number);
  return {
    name,
    trigger,
    requests: c.requests,
    byEndpoint: Object.fromEntries([...c.byEndpoint].sort(([a], [b]) => a.localeCompare(b))),
    duplicates: Object.fromEntries([...c.byUrl].filter(([, n]) => n > 1).map(([u, n]) => [u.replace(origin, ""), n])),
    coursesRead: {
      current: read.filter((id) => account.current.includes(id)).length,
      shells: read.filter((id) => account.shells.includes(id)).length,
      past: read.filter((id) => account.concluded.includes(id) || account.restricted.includes(id)).length,
    },
    downloads: c.downloads,
    ics: c.ics,
    milestones: m,
    ...(run?.action ? { action: run.action } : {}),
    ...(run?.warmCourses ? { warmCourses: run.warmCourses } : {}),
  };
}

/**
 * The scenarios: sign-in sync, a background tick right after it, a second launch within the
 * freshness window, the steady hot tick, focus, a teacher's due-date change, a manual refresh,
 * and the six-hour backstop. Each scenario's counters start at zero.
 */
export async function runSyncAccount(options: { latencyMs?: number; shape?: AccountShape; derivation?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "magic-perf-sync-account-"));
  const file = join(directory, "sync.sqlite");
  const account = syntheticAccount(options.shape ?? LIVE_ACCOUNT, options.latencyMs ?? LATENCY_MS);
  let at = new Date("2026-09-27T15:00:00Z");
  const secrets = new Map<string, string>();
  const expectedPages = account.current.length * account.shape.pagesPerCourse;
  const scenarios: Scenario[] = [];
  let base = createStore(file);
  let timed = timedStore(base, () => performance.now());
  const core = options.derivation === false
    ? undefined
    : createCore(base, { fixture: captureBatchSchema.parse(fixture), jobs: pipelineJobRegistry(), now: () => at });
  const make = () =>
    createIngestion(timed.store as Parameters<typeof createIngestion>[0], {
      directory,
      now: () => at,
      client: account.client,
      canvasFetch: account.canvasFetch,
      extractor: textExtractor,
      acquisition: { ...ACQUISITION_APP, pool: false, ocrPagesPerRun: 0 },
      secrets: async (operation, key, value) => {
        if (operation === "set" && key && value) secrets.set(key, value);
        return operation === "list" ? Object.fromEntries(secrets) : undefined;
      },
      onSaved: (sourceId) => void core?.saved(sourceId),
    });
  let ingestion = make();
  async function step(name: string, trigger: string, run: () => Promise<unknown>, derive = false) {
    account.resetCounters();
    core?.pipeline.syncStarted();
    const start = performance.now();
    const result = (await run()) as { action?: string; warmCourses?: string[] } | undefined;
    const end = performance.now();
    core?.pipeline.syncEnded();
    const scenario = snapshot(name, trigger, account, milestones(timed.landed, start, end, account.current, expectedPages), result);
    if (derive && core) {
      const t = performance.now();
      await core.settled();
      scenario.derivationMs = Math.round(performance.now() - t);
    }
    scenarios.push(scenario);
    process.stderr.write(`[sync] ${name}: ${scenario.requests} requests, ${Math.round(scenario.milestones.syncMs)} ms
`);
    return scenario;
  }
  const minutes = (n: number) => {
    at = new Date(at.getTime() + n * 60_000);
  };
  try {
    await ingestion.reconnected();
    await step("first sync after sign-in", "sign-in (renderer's manual sync)", () => ingestion.tick("manual"), true);
    minutes(0.5);
    await step("worker timer right after the sign-in sync", "background (30 s timer)", () => ingestion.tick("background"));
    minutes(0.5);
    await step("manual refresh within a minute", "manual", () => ingestion.tick("manual"));
    // A second launch: a new worker process over the same database, 10 minutes later.
    await ingestion.stop();
    minutes(10);
    ingestion = make();
    await step("second launch within the freshness window", "background (first timer tick)", () => ingestion.tick("background"));
    minutes(6.5);
    await step("steady hot tick (+5 min)", "background", () => ingestion.tick("background"));
    minutes(1.5);
    ingestion.focus();
    await step("app focus", "focus → background", () => ingestion.tick("background"));
    account.changeAssignment(1003, 3);
    minutes(6.5);
    await step("teacher moves one due date", "background", () => ingestion.tick("background"));
    minutes(2);
    await step("manual refresh (steady)", "manual", () => ingestion.tick("manual"));
    minutes(6 * 60 + 1);
    await step("six-hour backstop", "background", () => ingestion.tick("background"));
    return { shape: account.shape, latencyMs: options.latencyMs ?? LATENCY_MS, scenarios };
  } finally {
    await ingestion.stop();
    await core?.close();
    if (!core) base.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
