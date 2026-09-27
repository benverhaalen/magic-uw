/**
 * A localhost Canvas replica over one synthetic account: the REST API (the shapes our connector and
 * the gold read, with Link pagination) and a plain server-rendered UI (dashboard, course home,
 * modules, assignments, pages, files, syllabus, quizzes, discussions) behind one cookie session and
 * a login form. Write endpoints exist (submit, take quiz) only so the dry run can show the proxy
 * blocks them; any write that reaches the replica is recorded and fails the dry run.
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import { goldDocumentText, textBearing } from "./docs";
import type { Gold, GoldFile } from "./gold";
import { buildAccount, mutate, type Account, type RCourse, type Scale } from "./replica-data";
import { hash32, htmlLinks, htmlToText } from "./text";

export const REPLICA_LOGIN = { username: "student", password: "synthetic-password" } as const;

export interface Replica {
  url: string;
  account: Account;
  stats: { requests: number; api: number; ui: number; downloads: number; writes: string[] };
  truth(options?: { filesSampledPerCourse?: number }): Promise<Gold>;
  mutate(): ReturnType<typeof mutate>;
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const chicagoFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});
const shown = (instant: string | null) => (instant ? chicagoFormat.format(new Date(instant)) : "No due date");

export async function startReplica(options: { seed?: number; scale?: Scale; anchor?: Date; ocwDir?: string; port?: number } = {}): Promise<Replica> {
  const account = buildAccount(options);
  const sessions = new Set<string>();
  const stats: Replica["stats"] = { requests: 0, api: 0, ui: 0, downloads: 0, writes: [] };
  const byId = new Map(account.courses.map((c) => [c.id, c]));

  const server = http.createServer((req, res) => {
    stats.requests++;
    const host = req.headers.host ?? "127.0.0.1";
    const origin = (req.headers["x-bench-public-origin"] as string | undefined) ?? `http://${host}`;
    const url = new URL(req.url ?? "/", `http://${host}`);
    const cookie = /(?:^|;\s*)canvas_session=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1];
    const signedIn = !!cookie && sessions.has(cookie);
    const send = (status: number, body: string | Uint8Array, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "cache-control": "no-store", ...headers });
      res.end(body);
    };
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
      send(status, JSON.stringify(value), { "content-type": "application/json; charset=utf-8", ...headers });
    const page = (title: string, body: string, status = 200, course?: RCourse) =>
      send(status, layout(title, body, course, origin), { "content-type": "text/html; charset=utf-8" });

    if (req.method !== "GET" && req.method !== "HEAD") {
      if (url.pathname === "/login" && req.method === "POST") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const form = new URLSearchParams(raw);
          if (form.get("username") === REPLICA_LOGIN.username && form.get("password") === REPLICA_LOGIN.password) {
            const token = randomBytes(16).toString("hex");
            sessions.add(token);
            send(302, "", { location: "/", "set-cookie": `canvas_session=${token}; Path=/; HttpOnly; SameSite=Lax` });
          } else send(401, "Invalid login");
        });
        return;
      }
      stats.writes.push(`${req.method} ${url.pathname}`);
      return json({ errors: [{ message: "recorded write (the bench proxy should have blocked this)" }] }, 403);
    }

    // The file host: token URLs, no session needed (as inst-fs).
    const fs = url.pathname.match(/^\/_fs\/(\d+)\/[^/]+$/);
    if (fs) {
      for (const c of account.courses) {
        const f = c.files.find((x) => x.id === fs[1]);
        if (f) {
          stats.downloads++;
          return send(200, f.bytes, { "content-type": f.contentType, "content-disposition": `attachment; filename="${encodeURIComponent(f.name)}"` });
        }
      }
      return send(404, "not found");
    }
    if (url.pathname === "/login") return send(200, loginForm(), { "content-type": "text/html; charset=utf-8" });

    const isApi = url.pathname.startsWith("/api/v1/");
    if (!signedIn) {
      if (isApi) return json({ status: "unauthenticated", errors: [{ message: "user authorization required" }] }, 401);
      return send(302, "", { location: `/login?return_to=${encodeURIComponent(url.pathname)}` });
    }
    if (isApi) {
      stats.api++;
      return api(url, origin, json);
    }
    stats.ui++;
    return ui(url, origin, page, send);
  });

  function readable(course: RCourse | undefined): course is RCourse {
    return !!course && course.kind !== "restricted";
  }
  function visibleFiles(course: RCourse) {
    return course.files;
  }
  function findFile(fid: string) {
    for (const c of account.courses) {
      const f = c.files.find((x) => x.id === fid);
      if (f) return { course: c, file: f };
    }
    return undefined;
  }
  const absolute = (html: string, origin: string) => html.replace(/(href=")(\/(?:courses|files)\/)/g, `$1${origin}$2`);

  function courseJson(c: RCourse, origin: string, include: string[]) {
    if (c.kind === "restricted") return { id: Number(c.id), access_restricted_by_date: true };
    const concluded = c.kind === "past";
    return {
      id: Number(c.id), name: c.name, course_code: c.code, workflow_state: "available", account_id: 1,
      start_at: c.term.start, end_at: c.term.end, enrollment_term_id: Number(c.term.id), default_view: "modules",
      apply_assignment_group_weights: c.weighted, time_zone: "America/Chicago", uuid: `course-${c.id}`,
      enrollments: [{ type: "student", role: "StudentEnrollment", enrollment_state: concluded ? "completed" : "active", user_id: Number(account.user.id) }],
      calendar: { ics: `${origin}/feeds/calendars/course_${c.id}synthetic.ics` },
      ...(include.includes("term") ? { term: { id: Number(c.term.id), name: c.term.name, start_at: c.term.start, end_at: c.term.end } } : {}),
      ...(include.includes("syllabus_body") ? { syllabus_body: absolute(c.syllabusHtml, origin) } : {}),
      ...(include.includes("concluded") ? { concluded } : {}),
    };
  }
  function assignmentJson(c: RCourse, a: RCourse["assignments"][number], origin: string, include: string[]) {
    return {
      id: Number(a.id), name: a.name, description: absolute(a.descriptionHtml, origin), due_at: a.dueAt, unlock_at: null, lock_at: null,
      points_possible: a.points, grading_type: "points", assignment_group_id: Number(a.groupId), course_id: Number(c.id),
      submission_types: a.submissionTypes, workflow_state: "published", published: true, created_at: c.term.start, updated_at: a.updatedAt,
      html_url: `${origin}/courses/${c.id}/assignments/${a.id}`, has_submitted_submissions: false,
      ...(a.quizId ? { quiz_id: Number(a.quizId), is_quiz_assignment: true } : {}),
      ...(a.discussionId ? { discussion_topic: { id: Number(a.discussionId) } } : {}),
      ...(include.includes("submission") ? { submission: { assignment_id: Number(a.id), workflow_state: "unsubmitted", submitted_at: null, score: null, grade: null, late: false, missing: false, excused: false } } : {}),
    };
  }
  function itemJson(c: RCourse, it: RCourse["modules"][number]["items"][number], origin: string, details: boolean) {
    const target =
      it.type === "Page" ? `${origin}/api/v1/courses/${c.id}/pages/${it.pageUrl}`
      : it.type === "File" ? `${origin}/api/v1/courses/${c.id}/files/${it.contentId}`
      : it.type === "Assignment" ? `${origin}/api/v1/courses/${c.id}/assignments/${it.contentId}`
      : it.type === "Quiz" ? `${origin}/api/v1/courses/${c.id}/quizzes/${it.contentId}`
      : it.type === "Discussion" ? `${origin}/api/v1/courses/${c.id}/discussion_topics/${it.contentId}`
      : undefined;
    const assignment = it.type === "Assignment" ? c.assignments.find((a) => a.id === it.contentId) : it.type === "Quiz" ? c.assignments.find((a) => a.quizId === it.contentId) : undefined;
    return {
      id: Number(it.id), module_id: Number(it.moduleId), position: it.position, title: it.title, indent: 0, type: it.type,
      ...(it.contentId ? { content_id: Number(it.contentId) } : {}),
      html_url: `${origin}/courses/${c.id}/modules/items/${it.id}`,
      ...(target ? { url: target } : {}),
      ...(it.pageUrl ? { page_url: it.pageUrl } : {}),
      ...(it.externalUrl ? { external_url: it.externalUrl } : {}),
      published: true,
      ...(details ? { content_details: assignment ? { due_at: assignment.dueAt, points_possible: assignment.points, locked_for_user: false } : {} } : {}),
    };
  }
  function fileJson(c: RCourse, f: RCourse["files"][number], origin: string) {
    return {
      id: Number(f.id), uuid: `u${f.id}`, folder_id: Number(f.folderId), display_name: f.name, filename: f.name.replace(/\s+/g, "_"),
      "content-type": f.contentType, url: `${origin}/files/${f.id}/download?download_frd=1&verifier=v${hash32(f.id)}`, size: f.bytes.byteLength,
      created_at: f.updatedAt, updated_at: f.updatedAt, modified_at: f.updatedAt, locked: false, hidden: false, locked_for_user: false,
      mime_class: f.contentType.includes("pdf") ? "pdf" : "file", context_type: "Course", context_id: Number(c.id),
    };
  }
  function pageJson(c: RCourse, p: RCourse["pages"][number], origin: string, body: boolean) {
    return {
      page_id: Number(p.pageId), url: p.url, title: p.title, created_at: c.term.start, updated_at: p.updatedAt, published: true,
      front_page: false, html_url: `${origin}/courses/${c.id}/pages/${p.url}`, editing_roles: "teachers",
      ...(body ? { body: absolute(p.bodyHtml, origin), locked_for_user: false } : {}),
    };
  }

  function paginate(url: URL, rows: unknown[], json: (v: unknown, s?: number, h?: Record<string, string>) => void) {
    const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get("per_page") ?? 10) || 10));
    const pageNo = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
    const last = Math.max(1, Math.ceil(rows.length / perPage));
    const link = (n: number, rel: string) => {
      const u = new URL(url.href);
      u.searchParams.set("page", String(n));
      u.searchParams.set("per_page", String(perPage));
      return `<${u.pathname}${u.search}>; rel="${rel}"`;
    };
    const links = [link(pageNo, "current"), ...(pageNo < last ? [link(pageNo + 1, "next")] : []), link(1, "first"), link(last, "last")];
    json(rows.slice((pageNo - 1) * perPage, pageNo * perPage), 200, { link: links.join(",") });
  }

  function api(url: URL, origin: string, json: (v: unknown, s?: number, h?: Record<string, string>) => void) {
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const include = url.searchParams.getAll("include[]");
    const list = (rows: unknown[]) => paginate(url, rows, (v, s, h) => {
      // Absolute Link URLs, as Canvas sends them.
      const withOrigin: Record<string, string> = h?.link ? { link: h.link.replace(/<\//g, `<${origin}/`) } : {};
      json(v, s, withOrigin);
    });
    const unauthorized = () => json({ status: "unauthorized", errors: [{ message: "user not authorized to perform that action" }] }, 401);
    if (path === "/users/self/profile") return json({ id: Number(account.user.id), name: account.user.name, short_name: "Student", primary_email: "student@example.test", time_zone: "America/Chicago" });
    if (path === "/users/self") return json({ id: Number(account.user.id), name: account.user.name });
    if (path === "/courses") {
      const state = url.searchParams.get("enrollment_state");
      const rows = account.courses.filter((c) =>
        state === "active" ? c.kind === "current" || c.kind === "org"
        : state === "completed" ? c.kind === "past" || c.kind === "restricted"
        : true);
      return list(rows.map((c) => courseJson(c, origin, include)));
    }
    if (path === "/users/self/todo") {
      const soon = account.courses.filter((c) => c.kind === "current").flatMap((c) =>
        c.assignments.filter((a) => a.dueAt && Date.parse(a.dueAt) > account.now.getTime() && Date.parse(a.dueAt) < account.now.getTime() + 7 * 86400_000)
          .map((a) => ({ type: "submitting", course_id: Number(c.id), context_type: "Course", assignment: assignmentJson(c, a, origin, []), html_url: `${origin}/courses/${c.id}/assignments/${a.id}` })));
      return json(soon);
    }
    if (path === "/users/self/upcoming_events") {
      const soon = account.courses.filter((c) => c.kind === "current").flatMap((c) =>
        c.assignments.filter((a) => a.dueAt && Date.parse(a.dueAt) > account.now.getTime() && Date.parse(a.dueAt) < account.now.getTime() + 14 * 86400_000)
          .map((a) => ({ id: `assignment_${a.id}`, title: a.name, start_at: a.dueAt, context_code: `course_${c.id}`, assignment: assignmentJson(c, a, origin, []) })));
      return json(soon);
    }
    if (path === "/users/self/activity_stream") return json([]);
    if (path === "/users/self/activity_stream/summary")
      return json([{ type: "Announcement", count: account.courses.reduce((n, c) => n + c.announcements.length, 0), unread_count: 0 }]);
    if (path === "/planner/items") {
      const start = Date.parse(url.searchParams.get("start_date") ?? "") || account.now.getTime();
      const end = Date.parse(url.searchParams.get("end_date") ?? "") || start + 14 * 86400_000;
      const rows = account.courses.filter((c) => c.kind === "current").flatMap((c) =>
        c.assignments.filter((a) => a.dueAt && Date.parse(a.dueAt) >= start && Date.parse(a.dueAt) <= end)
          .map((a) => ({ course_id: Number(c.id), plannable_id: Number(a.id), plannable_type: "assignment", plannable_date: a.dueAt, plannable: { id: Number(a.id), title: a.name, due_at: a.dueAt, points_possible: a.points }, html_url: `/courses/${c.id}/assignments/${a.id}` })));
      return list(rows);
    }
    if (path === "/announcements") {
      const ids = url.searchParams.getAll("context_codes[]").map((x) => x.replace(/^course_/, ""));
      return list(ids.flatMap((id) => {
        const c = byId.get(id);
        return readable(c) ? c.announcements.map((t) => ({ id: Number(t.id), title: t.title, message: absolute(t.messageHtml, origin), posted_at: t.postedAt, context_code: `course_${c.id}`, user_name: "Instructor", published: true })) : [];
      }));
    }
    const fileOnly = path.match(/^\/files\/(\d+)$/);
    if (fileOnly) {
      const found = findFile(fileOnly[1]!);
      return found && readable(found.course) ? json(fileJson(found.course, found.file, origin)) : json({ errors: [{ message: "The specified resource does not exist." }] }, 404);
    }
    const m = path.match(/^\/courses\/(\d+)(\/.*)?$/);
    if (!m) return json({ errors: [{ message: "The specified resource does not exist." }] }, 404);
    const c = byId.get(m[1]!);
    if (!c) return json({ errors: [{ message: "The specified resource does not exist." }] }, 404);
    if (!readable(c)) return unauthorized();
    const tail = m[2] ?? "";
    if (!tail) return json(courseJson(c, origin, include));
    if (tail === "/assignments") return list(c.assignments.slice().sort((a, b) => (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~") || a.id.localeCompare(b.id)).map((a) => assignmentJson(c, a, origin, include)));
    const aOne = tail.match(/^\/assignments\/(\d+)$/);
    if (aOne) {
      const a = c.assignments.find((x) => x.id === aOne[1]);
      return a ? json(assignmentJson(c, a, origin, include)) : json({}, 404);
    }
    if (tail === "/assignment_groups")
      return list(c.groups.map((g) => ({
        id: Number(g.id), name: g.name, position: g.position, group_weight: g.weight ?? 0, rules: {},
        ...(include.includes("assignments") ? { assignments: c.assignments.filter((a) => a.groupId === g.id).map((a) => assignmentJson(c, a, origin, [])) } : {}),
      })));
    if (tail === "/modules") {
      const withItems = include.includes("items");
      return list(c.modules.map((mod) => ({
        id: Number(mod.id), name: mod.name, position: mod.position, unlock_at: null, require_sequential_progress: false, published: true,
        items_count: mod.items.length, items_url: `${origin}/api/v1/courses/${c.id}/modules/${mod.id}/items`, state: "unlocked",
        ...(withItems ? { items: mod.items.map((it) => itemJson(c, it, origin, include.includes("content_details"))) } : {}),
      })));
    }
    const mOne = tail.match(/^\/modules\/(\d+)(\/items)?$/);
    if (mOne) {
      const mod = c.modules.find((x) => x.id === mOne[1]);
      if (!mod) return json({}, 404);
      if (mOne[2]) return list(mod.items.map((it) => itemJson(c, it, origin, include.includes("content_details"))));
      return json({ id: Number(mod.id), name: mod.name, position: mod.position, items_count: mod.items.length, state: "unlocked" });
    }
    if (tail === "/pages") {
      const rows = c.pages.slice();
      if (url.searchParams.get("sort") === "updated_at") rows.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.url.localeCompare(b.url));
      if (url.searchParams.get("order") === "desc") rows.reverse();
      return list(rows.map((p) => pageJson(c, p, origin, false)));
    }
    const pOne = tail.match(/^\/pages\/([^/]+)$/);
    if (pOne) {
      const p = c.pages.find((x) => x.url === decodeURIComponent(pOne[1]!) || x.pageId === pOne[1]);
      return p ? json(pageJson(c, p, origin, true)) : json({ errors: [{ message: "page not found" }] }, 404);
    }
    if (tail === "/front_page") return json({ errors: [{ message: "No front page has been set" }] }, 404);
    if (tail === "/files") {
      if (c.filesHidden) return unauthorized();
      const rows = visibleFiles(c).slice();
      if (url.searchParams.get("sort") === "updated_at") rows.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
      if (url.searchParams.get("order") === "desc") rows.reverse();
      return list(rows.map((f) => fileJson(c, f, origin)));
    }
    const fOne = tail.match(/^\/files\/(\d+)$/);
    if (fOne) {
      const f = c.files.find((x) => x.id === fOne[1]);
      return f ? json(fileJson(c, f, origin)) : json({}, 404);
    }
    if (tail === "/folders") return c.filesHidden ? unauthorized() : list([{ id: 9000 + c.index, name: "course files", full_name: "course files", files_count: c.files.length, folders_count: 0, parent_folder_id: null }]);
    if (tail === "/quizzes") return list(c.quizzes.map((q) => ({ id: Number(q.id), title: q.title, description: q.descriptionHtml, due_at: q.dueAt, points_possible: q.points, assignment_id: Number(q.assignmentId), quiz_type: "assignment", published: true, html_url: `${origin}/courses/${c.id}/quizzes/${q.id}` })));
    const qOne = tail.match(/^\/quizzes\/(\d+)$/);
    if (qOne) {
      const q = c.quizzes.find((x) => x.id === qOne[1]);
      return q ? json({ id: Number(q.id), title: q.title, description: q.descriptionHtml, due_at: q.dueAt, points_possible: q.points, assignment_id: Number(q.assignmentId) }) : json({}, 404);
    }
    if (tail === "/discussion_topics") {
      const topics = url.searchParams.get("only_announcements") === "true" ? c.announcements : c.discussions;
      return list(topics.map((t) => ({ id: Number(t.id), title: t.title, message: absolute(t.messageHtml, origin), posted_at: t.postedAt, published: true, user_name: "Instructor", ...(t.assignmentId ? { assignment_id: Number(t.assignmentId) } : {}), html_url: `${origin}/courses/${c.id}/discussion_topics/${t.id}` })));
    }
    const dOne = tail.match(/^\/discussion_topics\/(\d+)$/);
    if (dOne) {
      const t = [...c.discussions, ...c.announcements].find((x) => x.id === dOne[1]);
      return t ? json({ id: Number(t.id), title: t.title, message: absolute(t.messageHtml, origin), posted_at: t.postedAt }) : json({}, 404);
    }
    if (tail === "/tabs")
      return json(tabs(c).map(([id, label], i) => ({ id, label, type: "internal", position: i + 1, html_url: `/courses/${c.id}${id === "home" ? "" : `/${id}`}`, full_url: `${origin}/courses/${c.id}${id === "home" ? "" : `/${id}`}`, visibility: "public" })));
    if (tail === "/external_tools") return json([]);
    if (tail === "/students/submissions") return json([]);
    return json({ errors: [{ message: "The specified resource does not exist." }] }, 404);
  }

  function tabs(c: RCourse): Array<[string, string]> {
    return [
      ["home", "Home"], ["announcements", "Announcements"], ["assignments", "Assignments"], ["discussion_topics", "Discussions"],
      ["pages", "Pages"], ...(c.filesHidden ? [] : [["files", "Files"] as [string, string]]), ["assignments/syllabus", "Syllabus"],
      ["quizzes", "Quizzes"], ["modules", "Modules"], ["grades", "Grades"],
    ];
  }
  function layout(title: string, body: string, course: RCourse | undefined, _origin: string) {
    const nav = course
      ? `<nav aria-label="Course navigation"><ul>${tabs(course).map(([id, label]) => `<li><a href="/courses/${course.id}${id === "home" ? "" : `/${id}`}">${label}</a></li>`).join("")}</ul></nav>`
      : "";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>
<header><a href="/">Dashboard</a> · <a href="/courses">Courses</a> · <span>Times shown in America/Chicago</span></header>
${course ? `<h1><a href="/courses/${course.id}">${esc(course.name)}</a></h1>${nav}` : ""}<main><h2>${esc(title)}</h2>${body}</main></body></html>`;
  }
  const loginForm = () => `<!doctype html><html><body><h1>Sign in to Canvas (synthetic)</h1><form method="post" action="/login"><label>Username <input name="username"></label><label>Password <input name="password" type="password"></label><button type="submit">Sign in</button></form></body></html>`;

  function ui(url: URL, _origin: string, page: (t: string, b: string, s?: number, c?: RCourse) => void, send: (s: number, b: string, h?: Record<string, string>) => void) {
    const p = url.pathname.replace(/\/$/, "") || "/";
    if (p === "/") {
      const cards = account.courses.filter((c) => c.kind === "current" || c.kind === "org")
        .map((c) => `<li class="card"><a href="/courses/${c.id}">${esc(c.name)}</a> <span>${esc(c.term.name)}</span></li>`).join("");
      return page("Dashboard", `<ul class="dashboard-cards">${cards}</ul><p><a href="/courses">All courses</a></p>`);
    }
    if (p === "/courses") {
      const row = (c: RCourse) => c.kind === "restricted"
        ? `<tr><td>${esc(c.name)} (access restricted)</td><td>${esc(c.term.name)}</td></tr>`
        : `<tr><td><a href="/courses/${c.id}">${esc(c.name)}</a></td><td>${esc(c.term.name)}</td></tr>`;
      return page("All Courses", `<h3>Current enrollments</h3><table>${account.courses.filter((c) => c.kind === "current" || c.kind === "org").map(row).join("")}</table><h3>Past enrollments</h3><table>${account.courses.filter((c) => c.kind === "past" || c.kind === "restricted").map(row).join("")}</table>`);
    }
    const m = p.match(/^\/courses\/(\d+)(\/.*)?$/);
    const c = m ? byId.get(m[1]!) : undefined;
    if (!m || !c) return page("Page not found", "<p>The page you requested does not exist.</p>", 404);
    if (!readable(c)) return page("Access restricted", "<p>This course is not available: access is restricted by date.</p>", 401);
    const tail = m[2] ?? "";
    const modules = () => c.modules.map((mod) => `<section class="module"><h3>${esc(mod.name)}</h3><ul>${mod.items.map((it) =>
      it.type === "SubHeader" ? `<li class="subheader">${esc(it.title)}</li>` : `<li class="item ${it.type}"><span class="type">${it.type}</span> <a href="/courses/${c.id}/modules/items/${it.id}">${esc(it.title)}</a></li>`).join("")}</ul></section>`).join("");
    if (!tail || tail === "/modules") return page(tail ? "Modules" : "Home", modules(), 200, c);
    const item = tail.match(/^\/modules\/items\/(\d+)$/);
    if (item) {
      const it = c.modules.flatMap((mod) => mod.items).find((x) => x.id === item[1]);
      if (!it) return page("Not found", "", 404, c);
      const to = it.type === "Page" ? `/courses/${c.id}/pages/${it.pageUrl}` : it.type === "File" ? `/courses/${c.id}/files/${it.contentId}`
        : it.type === "Assignment" ? `/courses/${c.id}/assignments/${it.contentId}` : it.type === "Quiz" ? `/courses/${c.id}/quizzes/${it.contentId}`
        : it.type === "Discussion" ? `/courses/${c.id}/discussion_topics/${it.contentId}` : it.externalUrl ?? `/courses/${c.id}/modules`;
      return send(302, "", { location: to });
    }
    if (tail === "/assignments") {
      const body = c.groups.map((g) => `<section><h3>${esc(g.name)}${g.weight !== null ? ` (${g.weight}% of total)` : ""}</h3><ul>${c.assignments.filter((a) => a.groupId === g.id)
        .map((a) => `<li><a href="/courses/${c.id}/assignments/${a.id}">${esc(a.name)}</a> · Due ${esc(shown(a.dueAt))} · ${a.points ?? "-"} pts</li>`).join("")}</ul></section>`).join("");
      return page("Assignments", body, 200, c);
    }
    if (tail === "/assignments/syllabus") {
      const summary = c.assignments.slice().sort((a, b) => (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~"))
        .map((a) => `<tr><td>${esc(shown(a.dueAt))}</td><td><a href="/courses/${c.id}/assignments/${a.id}">${esc(a.name)}</a></td></tr>`).join("");
      return page("Syllabus", `<div class="syllabus">${c.syllabusHtml}</div><h3>Course summary</h3><table>${summary}</table>`, 200, c);
    }
    const a = tail.match(/^\/assignments\/(\d+)$/);
    if (a) {
      const row = c.assignments.find((x) => x.id === a[1]);
      if (!row) return page("Not found", "", 404, c);
      return page(row.name, `<p>Due: ${esc(shown(row.dueAt))}</p><p>Points: ${row.points ?? "-"}</p><p>Submitting: ${row.submissionTypes.join(", ")}</p><div class="description">${row.descriptionHtml}</div><form method="post" action="/courses/${c.id}/assignments/${row.id}/submissions"><button>Submit assignment</button></form>`, 200, c);
    }
    if (tail === "/pages" || tail === "/wiki")
      return page("Pages", `<ul>${c.pages.map((pg) => `<li><a href="/courses/${c.id}/pages/${pg.url}">${esc(pg.title)}</a></li>`).join("")}</ul>`, 200, c);
    const pg = tail.match(/^\/(?:pages|wiki)\/([^/]+)$/);
    if (pg) {
      const row = c.pages.find((x) => x.url === decodeURIComponent(pg[1]!));
      return row ? page(row.title, `<div class="page-body">${row.bodyHtml}</div><p class="updated">Updated ${esc(shown(row.updatedAt))}</p>`, 200, c) : page("Not found", "", 404, c);
    }
    if (tail === "/files") {
      if (c.filesHidden) return page("Unauthorized", "<p>You do not have permission to view this page.</p>", 401, c);
      return page("Files", `<table>${c.files.map((f) => `<tr><td><a href="/courses/${c.id}/files/${f.id}">${esc(f.name)}</a></td><td>${f.bytes.byteLength} bytes</td></tr>`).join("")}</table>`, 200, c);
    }
    const f = tail.match(/^\/files\/(\d+)(\/download)?$/);
    if (f) {
      const row = c.files.find((x) => x.id === f[1]);
      if (!row) return page("Not found", "", 404, c);
      if (f[2]) return send(302, "", { location: `/_fs/${row.id}/${encodeURIComponent(row.name)}?token=t${hash32(row.id)}` });
      return page(row.name, `<p>${esc(row.contentType)}, ${row.bytes.byteLength} bytes</p><p><a href="/courses/${c.id}/files/${row.id}/download?download_frd=1">Download ${esc(row.name)}</a></p>`, 200, c);
    }
    if (tail === "/quizzes") return page("Quizzes", `<ul>${c.quizzes.map((q) => `<li><a href="/courses/${c.id}/quizzes/${q.id}">${esc(q.title)}</a> · Due ${esc(shown(q.dueAt))} · ${q.points} pts</li>`).join("")}</ul>`, 200, c);
    const q = tail.match(/^\/quizzes\/(\d+)$/);
    if (q) {
      const row = c.quizzes.find((x) => x.id === q[1]);
      return row ? page(row.title, `<p>Due ${esc(shown(row.dueAt))} · ${row.points} pts</p>${row.descriptionHtml}<form method="post" action="/courses/${c.id}/quizzes/${row.id}/take"><button>Take the Quiz</button></form>`, 200, c) : page("Not found", "", 404, c);
    }
    if (tail === "/announcements") return page("Announcements", c.announcements.map((t) => `<article><h3>${esc(t.title)}</h3><p>${esc(shown(t.postedAt))}</p>${t.messageHtml}</article>`).join(""), 200, c);
    if (tail === "/discussion_topics") return page("Discussions", `<ul>${c.discussions.map((t) => `<li><a href="/courses/${c.id}/discussion_topics/${t.id}">${esc(t.title)}</a></li>`).join("")}</ul>`, 200, c);
    const d = tail.match(/^\/discussion_topics\/(\d+)$/);
    if (d) {
      const row = c.discussions.find((x) => x.id === d[1]);
      return row ? page(row.title, row.messageHtml, 200, c) : page("Not found", "", 404, c);
    }
    if (tail === "/grades") return page("Grades", `<table>${c.assignments.map((x) => `<tr><td>${esc(x.name)}</td><td>-/${x.points ?? "-"}</td></tr>`).join("")}</table>`, 200, c);
    if (tail.startsWith("/external_tools")) return page("External tool", "<p>An LTI tool would launch here.</p>", 200, c);
    return page("Page not found", "", 404, c);
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  return {
    url,
    account,
    stats,
    truth: (o) => replicaTruth(account, url, o?.filesSampledPerCourse ?? 3),
    mutate: () => mutate(account),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The gold the replica implies (the crawler's result must equal it: the gold's self-test). */
export async function replicaTruth(account: Account, origin: string, filesSampledPerCourse = 3): Promise<Gold> {
  const gold: Gold = {
    schema: "bench-gold/1", origin, capturedAt: account.now.toISOString(), now: account.now.toISOString(),
    courses: [], modules: [], items: [], groups: [], assignments: [], pages: [], files: [], syllabus: [],
    crawl: { requests: 0, ms: 0, filesListHidden: 0, pagesListHidden: 0, unreadable: 0 },
  };
  for (const c of account.courses) {
    gold.courses.push({
      id: c.id,
      name: c.kind === "restricted" ? null : c.name,
      code: c.kind === "restricted" ? null : c.code,
      term: c.kind === "restricted" ? null : c.term.name,
      termStart: c.kind === "restricted" ? null : c.term.start,
      termEnd: c.kind === "restricted" ? null : c.term.end,
      listedAs: [c.kind === "current" || c.kind === "org" ? "active" : "completed"],
      restricted: c.kind === "restricted",
      current: c.kind === "current",
      weighted: c.kind === "restricted" ? false : c.weighted,
    });
    if (c.kind !== "current") continue;
    if (c.filesHidden) gold.crawl.filesListHidden++;
    const base = `${origin}/courses/${c.id}/`;
    const fileRef = (u: string) => new URL(u).pathname.match(new RegExp(`^(?:/courses/${c.id})?/files/(\\d+)`))?.[1];
    const pageRef = (u: string) => {
      const m = new URL(u).pathname.match(new RegExp(`^/courses/${c.id}/(?:pages|wiki)/([^/?#]+)$`));
      return m ? decodeURIComponent(m[1]!) : undefined;
    };
    const via = new Map<string, Set<GoldFile["reachableVia"][number]>>();
    const add = (id: string, how: GoldFile["reachableVia"][number]) => via.set(id, (via.get(id) ?? new Set()).add(how));
    for (const g of c.groups) gold.groups.push({ id: g.id, courseId: c.id, name: g.name, weight: c.weighted ? g.weight : null });
    for (const mod of c.modules) {
      gold.modules.push({ id: mod.id, courseId: c.id, name: mod.name, position: mod.position });
      for (const it of mod.items) {
        gold.items.push({ id: it.id, moduleId: mod.id, courseId: c.id, title: it.title, type: it.type, contentId: it.contentId ?? null, pageUrl: it.pageUrl ?? null, position: it.position });
        if (it.type === "File" && it.contentId) add(it.contentId, "module");
      }
    }
    for (const a of c.assignments) {
      const links = htmlLinks(a.descriptionHtml, base);
      for (const l of links) {
        const f = fileRef(l);
        if (f) add(f, "link");
      }
      gold.assignments.push({
        id: a.id, courseId: c.id, name: a.name, dueAt: a.dueAt, points: a.points, groupId: a.groupId,
        links: {
          files: [...new Set(links.map(fileRef).filter((x): x is string => !!x))].sort(),
          pages: [...new Set(links.map(pageRef).filter((x): x is string => !!x))].sort(),
        },
        text: htmlToText(a.descriptionHtml),
      });
    }
    for (const html of [c.syllabusHtml, ...c.pages.map((p) => p.bodyHtml)])
      for (const l of htmlLinks(html, base)) {
        const f = fileRef(l);
        if (f) add(f, "link");
      }
    if (!c.filesHidden) for (const f of c.files) add(f.id, "files_list");
    for (const p of c.pages)
      gold.pages.push({ courseId: c.id, url: p.url, pageId: p.pageId, title: p.title, updatedAt: p.updatedAt, text: htmlToText(p.bodyHtml) });
    for (const f of c.files) {
      const how = via.get(f.id);
      if (!how) continue;
      gold.files.push({
        id: f.id, courseId: c.id, name: f.name, contentType: f.contentType, size: f.bytes.byteLength, updatedAt: f.updatedAt,
        reachableVia: [...how].sort(), textBearing: textBearing(f.name, f.contentType),
      });
    }
    const bodyText = htmlToText(c.syllabusHtml);
    const syllabusPage = c.pages.find((p) => /syllabus/i.test(p.title));
    const syllabusFile = c.files.filter((f) => /syllabus/i.test(f.name) && via.has(f.id) && textBearing(f.name, f.contentType)).sort((a, b) => a.id.localeCompare(b.id))[0];
    if (bodyText.length >= 200) gold.syllabus.push({ courseId: c.id, source: "syllabus_body", text: bodyText });
    else if (syllabusPage) gold.syllabus.push({ courseId: c.id, source: "page", text: htmlToText(syllabusPage.bodyHtml), ref: syllabusPage.url });
    else if (syllabusFile) gold.syllabus.push({ courseId: c.id, source: "file", text: (await goldDocumentText(syllabusFile.bytes, syllabusFile.name, syllabusFile.contentType)) ?? "", ref: syllabusFile.id });
    else if (bodyText) gold.syllabus.push({ courseId: c.id, source: "syllabus_body", text: bodyText });
  }
  // The same deterministic sample the crawler takes.
  for (const c of account.courses.filter((x) => x.kind === "current")) {
    const bearing = gold.files.filter((f) => f.courseId === c.id && f.textBearing).sort((a, b) => hash32(a.id) - hash32(b.id));
    const sample = new Set(bearing.slice(0, filesSampledPerCourse).map((f) => f.id));
    for (const s of gold.syllabus) if (s.courseId === c.id && s.source === "file" && s.ref) sample.add(s.ref);
    for (const f of gold.files.filter((x) => sample.has(x.id))) {
      const raw = c.files.find((x) => x.id === f.id)!;
      f.text = (await goldDocumentText(raw.bytes, raw.name, raw.contentType)) ?? "";
    }
  }
  const by = <T>(key: (x: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));
  gold.courses.sort(by((c) => c.id));
  gold.modules.sort(by((m) => m.id));
  gold.items.sort(by((i) => i.id));
  gold.groups.sort(by((g) => g.id));
  gold.assignments.sort(by((a) => a.id));
  gold.pages.sort(by((p) => `${p.courseId}/${p.url}`));
  gold.files.sort(by((f) => f.id));
  gold.syllabus.sort(by((s) => s.courseId));
  return gold;
}
