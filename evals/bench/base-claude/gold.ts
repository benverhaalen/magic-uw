/**
 * The gold: an independent, GET-only crawl of the Canvas REST API that lists what a complete and
 * accurate ingestion must contain. It shares no code with the product's connectors or storage and
 * never reads our database. Scope: every listed course (to judge "current"); modules, items,
 * assignments, groups, pages, files and syllabus for current-term courses only.
 */
import { goldDocumentText, textBearing } from "./docs";
import { hash32, htmlLinks, htmlToText } from "./text";
import { nextLink, type CanvasTransport } from "./transport";

export interface GoldCourse {
  id: string;
  name: string | null;
  code: string | null;
  term: string | null;
  termStart: string | null;
  termEnd: string | null;
  listedAs: ("active" | "completed")[];
  restricted: boolean;
  current: boolean;
  weighted: boolean;
}
export interface GoldModule { id: string; courseId: string; name: string; position: number | null }
export interface GoldItem {
  id: string; moduleId: string; courseId: string; title: string; type: string;
  contentId: string | null; pageUrl: string | null; position: number | null;
}
export interface GoldGroup { id: string; courseId: string; name: string; weight: number | null }
export interface GoldAssignment {
  id: string; courseId: string; name: string; dueAt: string | null; points: number | null; groupId: string | null;
  /** File ids and page slugs linked from the description (Part B's readings tasks). */
  links: { files: string[]; pages: string[] };
  text: string;
}
export interface GoldPage { courseId: string; url: string; pageId: string; title: string; updatedAt: string | null; text: string }
export interface GoldFile {
  id: string; courseId: string; name: string; contentType: string | null; size: number | null; updatedAt: string | null;
  reachableVia: ("files_list" | "module" | "link")[];
  textBearing: boolean;
  /** Present for the sampled files only (and every syllabus file). */
  text?: string;
}
export interface GoldSyllabus { courseId: string; source: "syllabus_body" | "page" | "file"; text: string; ref?: string }
export interface Gold {
  schema: "bench-gold/1";
  origin: string;
  capturedAt: string;
  /** The instant "current term" was judged at. */
  now: string;
  courses: GoldCourse[];
  modules: GoldModule[];
  items: GoldItem[];
  groups: GoldGroup[];
  assignments: GoldAssignment[];
  pages: GoldPage[];
  files: GoldFile[];
  syllabus: GoldSyllabus[];
  crawl: { requests: number; ms: number; filesListHidden: number; pagesListHidden: number; unreadable: number };
}

const SEASONS: Record<string, [number, number]> = { winter: [0, 1], spring: [0, 4], summer: [5, 7], fall: [8, 11], autumn: [8, 11] };

/**
 * The term in session at `now`: the term's own dates when Canvas gives them; otherwise a
 * "<Season> <year>" name (a two-year name like "Spring 2026-2027" counts spring and summer in the
 * second year); otherwise the course's own dates. A term with none of these is not current.
 */
export function termIsCurrent(
  term: { name?: string | null; start_at?: string | null; end_at?: string | null } | null | undefined,
  course: { start_at?: string | null; end_at?: string | null },
  now: Date,
): boolean {
  const within = (start?: string | null, end?: string | null) => {
    const s = start ? Date.parse(start) : NaN, e = end ? Date.parse(end) : NaN;
    if (!Number.isFinite(s) && !Number.isFinite(e)) return undefined;
    return (!Number.isFinite(s) || s <= now.getTime()) && (!Number.isFinite(e) || now.getTime() <= e);
  };
  const byTerm = within(term?.start_at, term?.end_at);
  if (byTerm !== undefined) return byTerm;
  const match = (term?.name ?? "").match(/\b(winter|spring|summer|fall|autumn)\b\D{0,4}(\d{4})(?:\s*[-–/]\s*(\d{4}))?/i);
  if (match) {
    const season = match[1]!.toLowerCase();
    let year = Number(match[2]);
    if (match[3] && (season === "spring" || season === "summer" || season === "winter")) year = Number(match[3]);
    const [from, to] = SEASONS[season]!;
    return now.getUTCFullYear() === year && now.getUTCMonth() >= from && now.getUTCMonth() <= to;
  }
  return within(course.start_at, course.end_at) ?? false;
}

interface Json { [key: string]: unknown }
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface CrawlOptions {
  now?: Date;
  /** Text-bearing files sampled per current course for the text similarity check. */
  filesSampledPerCourse?: number;
  concurrency?: number;
  log?: (line: string) => void;
}

export async function crawlGold(transport: CanvasTransport, options: CrawlOptions = {}): Promise<Gold> {
  const started = performance.now();
  const now = options.now ?? new Date();
  const origin = transport.origin;
  const api = (path: string) => `${origin}/api/v1${path}`;
  const log = options.log ?? (() => {});
  let unreadable = 0;

  async function getJson(url: string): Promise<{ status: number; data: unknown; next?: string }> {
    const r = await transport.get(url);
    let data: unknown = null;
    try {
      data = JSON.parse(r.body.replace(/^while\(1\);/, ""));
    } catch {}
    return { status: r.status, data, next: nextLink(r.headers) };
  }
  /** Every page of a list; `undefined` when the list is not readable (hidden tab, restricted). */
  async function list(url: string): Promise<Json[] | undefined> {
    const out: Json[] = [];
    let next: string | undefined = url;
    for (let page = 0; next && page < 50; page++) {
      const r = await getJson(next);
      if (r.status !== 200 || !Array.isArray(r.data)) {
        if (page === 0) return undefined;
        unreadable++;
        break;
      }
      out.push(...(r.data as Json[]));
      next = r.next;
    }
    return out;
  }
  async function one(url: string): Promise<Json | undefined> {
    const r = await getJson(url);
    return r.status === 200 && r.data && typeof r.data === "object" && !Array.isArray(r.data) ? (r.data as Json) : undefined;
  }
  async function pool<T>(items: T[], work: (item: T) => Promise<void>) {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(options.concurrency ?? 4, items.length) }, async () => {
        while (next < items.length) await work(items[next++]!);
      }),
    );
  }

  const profile = await getJson(api("/users/self/profile"));
  if (profile.status !== 200) throw new Error(`gold: Canvas profile read returned ${profile.status}; the session is not signed in`);

  const byId = new Map<string, { raw: Json; listedAs: Set<"active" | "completed"> }>();
  for (const state of ["active", "completed"] as const) {
    const rows = (await list(api(`/courses?enrollment_state=${state}&include[]=term&include[]=syllabus_body&per_page=100`))) ?? [];
    for (const raw of rows) {
      const id = String(raw.id);
      const entry = byId.get(id) ?? { raw, listedAs: new Set() };
      if (state === "active" || !byId.has(id)) entry.raw = { ...raw, ...(entry.raw ?? {}) };
      entry.listedAs.add(state);
      byId.set(id, entry);
    }
  }
  const courses: GoldCourse[] = [...byId.entries()]
    .map(([id, { raw, listedAs }]) => {
      const term = (raw.term ?? null) as Json | null;
      const restricted = raw.access_restricted_by_date === true;
      return {
        id,
        name: str(raw.name),
        code: str(raw.course_code),
        term: str(term?.name),
        termStart: str(term?.start_at),
        termEnd: str(term?.end_at),
        listedAs: [...listedAs].sort(),
        restricted,
        current:
          listedAs.has("active") && !restricted && raw.workflow_state !== "completed" &&
          termIsCurrent(term as { name?: string; start_at?: string; end_at?: string } | null, raw as { start_at?: string; end_at?: string }, now),
        weighted: raw.apply_assignment_group_weights === true,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const current = courses.filter((c) => c.current);
  log(`courses: ${courses.length} listed, ${current.length} current`);

  const gold: Gold = {
    schema: "bench-gold/1", origin, capturedAt: new Date().toISOString(), now: now.toISOString(),
    courses, modules: [], items: [], groups: [], assignments: [], pages: [], files: [], syllabus: [],
    crawl: { requests: 0, ms: 0, filesListHidden: 0, pagesListHidden: 0, unreadable: 0 },
  };

  for (const course of current) {
    const cid = course.id;
    const raw = byId.get(cid)!.raw;
    const coursePath = (p: string) => api(`/courses/${cid}${p}`);
    const [groups, assignments, modules, pageList, fileList] = await Promise.all([
      list(coursePath("/assignment_groups?per_page=100")),
      list(coursePath("/assignments?per_page=100")),
      list(coursePath("/modules?include[]=items&per_page=100")),
      list(coursePath("/pages?per_page=100")),
      list(coursePath("/files?per_page=100")),
    ]);
    if (!pageList) gold.crawl.pagesListHidden++;
    if (!fileList) gold.crawl.filesListHidden++;
    for (const g of groups ?? [])
      gold.groups.push({ id: String(g.id), courseId: cid, name: String(g.name ?? ""), weight: course.weighted ? numOrNull(g.group_weight) : null });

    // Modules and their items (inline when Canvas includes them, else the items list).
    for (const m of modules ?? []) {
      const mid = String(m.id);
      gold.modules.push({ id: mid, courseId: cid, name: String(m.name ?? ""), position: numOrNull(m.position) });
      let items = Array.isArray(m.items) ? (m.items as Json[]) : undefined;
      if (!items || (typeof m.items_count === "number" && items.length < m.items_count))
        items = (await list(coursePath(`/modules/${mid}/items?per_page=100`))) ?? [];
      for (const it of items)
        gold.items.push({
          id: String(it.id), moduleId: mid, courseId: cid, title: String(it.title ?? ""), type: String(it.type ?? ""),
          contentId: it.content_id === undefined || it.content_id === null ? null : String(it.content_id),
          pageUrl: str(it.page_url), position: numOrNull(it.position),
        });
    }

    // Page slugs and file ids referenced from Canvas content of this course.
    const pageRef = (url: string) => {
      try {
        const u = new URL(url);
        const m = u.pathname.match(new RegExp(`^/courses/${cid}/(?:pages|wiki)/([^/?#]+)$`));
        return u.origin === origin && m ? decodeURIComponent(m[1]!) : undefined;
      } catch {
        return undefined;
      }
    };
    const fileRef = (url: string) => {
      try {
        const u = new URL(url);
        const m = u.pathname.match(new RegExp(`^(?:/courses/${cid})?/files/(\\d+)(?:/|$)`));
        return u.origin === origin && m ? m[1]! : undefined;
      } catch {
        return undefined;
      }
    };
    const fileVia = new Map<string, Set<GoldFile["reachableVia"][number]>>();
    const addFile = (id: string, via: GoldFile["reachableVia"][number]) => {
      const set = fileVia.get(id) ?? new Set();
      set.add(via);
      fileVia.set(id, set);
    };
    const slugs = new Set<string>();
    const scan = (html: string | null | undefined, base: string) => {
      for (const link of htmlLinks(html, base)) {
        const slug = pageRef(link);
        if (slug) slugs.add(slug);
        const file = fileRef(link);
        if (file) addFile(file, "link");
      }
    };
    const courseBase = `${origin}/courses/${cid}/`;
    for (const a of assignments ?? []) {
      const html = str(a.description);
      const links = htmlLinks(html, courseBase);
      gold.assignments.push({
        id: String(a.id), courseId: cid, name: String(a.name ?? ""), dueAt: str(a.due_at), points: numOrNull(a.points_possible),
        groupId: str(a.assignment_group_id),
        links: {
          files: [...new Set(links.map(fileRef).filter((x): x is string => !!x))].sort(),
          pages: [...new Set(links.map(pageRef).filter((x): x is string => !!x))].sort(),
        },
        text: htmlToText(html),
      });
      scan(html, courseBase);
    }
    scan(str(raw.syllabus_body), courseBase);
    for (const p of pageList ?? []) slugs.add(String(p.url));
    for (const it of gold.items.filter((i) => i.courseId === cid)) {
      if (it.type === "Page" && it.pageUrl) slugs.add(it.pageUrl);
      if (it.type === "File" && it.contentId) addFile(it.contentId, "module");
    }
    for (const f of fileList ?? []) addFile(String(f.id), "files_list");

    // Page bodies, following same-course page links (bounded).
    const seen = new Set<string>();
    for (let depth = 0; depth < 4; depth++) {
      const wave = [...slugs].filter((s) => !seen.has(s));
      if (!wave.length || seen.size > 500) break;
      await pool(wave, async (slug) => {
        seen.add(slug);
        const page = await one(coursePath(`/pages/${encodeURIComponent(slug)}`));
        if (!page) return;
        const html = str(page.body);
        gold.pages.push({
          courseId: cid, url: String(page.url ?? slug), pageId: String(page.page_id ?? ""), title: String(page.title ?? ""),
          updatedAt: str(page.updated_at), text: htmlToText(html),
        });
        scan(html, courseBase);
      });
    }

    // File metadata: the list gives it; referenced-only files are read one by one.
    const listed = new Map((fileList ?? []).map((f) => [String(f.id), f]));
    await pool([...fileVia.keys()], async (fid) => {
      const meta = listed.get(fid) ?? (await one(coursePath(`/files/${fid}`)));
      if (!meta) {
        unreadable++;
        return;
      }
      const name = String(meta.display_name ?? meta.filename ?? "");
      const type = str(meta["content-type"]);
      gold.files.push({
        id: fid, courseId: cid, name, contentType: type, size: numOrNull(meta.size), updatedAt: str(meta.updated_at),
        reachableVia: [...fileVia.get(fid)!].sort(), textBearing: textBearing(name, type),
      });
    });

    // Syllabus: a substantive syllabus body, else a page, else a file named as the syllabus.
    const bodyText = htmlToText(str(raw.syllabus_body));
    const syllabusPage = gold.pages.find((p) => p.courseId === cid && /syllabus/i.test(p.title));
    const syllabusFile = gold.files
      .filter((f) => f.courseId === cid && /syllabus/i.test(f.name) && f.textBearing)
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    if (bodyText.length >= 200) gold.syllabus.push({ courseId: cid, source: "syllabus_body", text: bodyText });
    else if (syllabusPage) gold.syllabus.push({ courseId: cid, source: "page", text: syllabusPage.text, ref: syllabusPage.url });
    else if (syllabusFile) gold.syllabus.push({ courseId: cid, source: "file", text: "", ref: syllabusFile.id });
    else if (bodyText) gold.syllabus.push({ courseId: cid, source: "syllabus_body", text: bodyText });
    log(`course ${cid}: ${gold.assignments.filter((a) => a.courseId === cid).length} assignments, ${gold.files.filter((f) => f.courseId === cid).length} files`);
  }

  // Document text: a deterministic sample per course, plus every syllabus file.
  const perCourse = options.filesSampledPerCourse ?? 3;
  const sample = new Set<string>();
  for (const course of current) {
    const bearing = gold.files.filter((f) => f.courseId === course.id && f.textBearing).sort((a, b) => hash32(a.id) - hash32(b.id));
    for (const f of bearing.slice(0, perCourse)) sample.add(f.id);
  }
  for (const s of gold.syllabus) if (s.source === "file" && s.ref) sample.add(s.ref);
  await pool([...sample], async (fid) => {
    const file = gold.files.find((f) => f.id === fid)!;
    const r = await transport.download(`${origin}/courses/${file.courseId}/files/${fid}/download?download_frd=1`);
    if (r.status !== 200) {
      unreadable++;
      return;
    }
    file.text = (await goldDocumentText(r.bytes, file.name, r.contentType).catch(() => undefined)) ?? "";
  });
  for (const s of gold.syllabus)
    if (s.source === "file") s.text = gold.files.find((f) => f.id === s.ref)?.text ?? "";

  const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));
  gold.modules.sort(byKey((m) => m.id));
  gold.items.sort(byKey((i) => i.id));
  gold.groups.sort(byKey((g) => g.id));
  gold.assignments.sort(byKey((a) => a.id));
  gold.pages.sort(byKey((p) => `${p.courseId}/${p.url}`));
  gold.files.sort(byKey((f) => f.id));
  gold.syllabus.sort(byKey((s) => s.courseId));
  gold.crawl = { ...gold.crawl, requests: transport.requests(), ms: Math.round(performance.now() - started), unreadable };
  return gold;
}

/** Counts only: what a public report may say about the gold. */
export function goldCounts(gold: Gold) {
  return {
    coursesListed: gold.courses.length,
    coursesCurrent: gold.courses.filter((c) => c.current).length,
    coursesRestricted: gold.courses.filter((c) => c.restricted).length,
    modules: gold.modules.length,
    items: gold.items.length,
    groups: gold.groups.length,
    assignments: gold.assignments.length,
    assignmentsDated: gold.assignments.filter((a) => a.dueAt).length,
    pages: gold.pages.length,
    files: gold.files.length,
    filesTextBearing: gold.files.filter((f) => f.textBearing).length,
    filesSampled: gold.files.filter((f) => f.text !== undefined).length,
    syllabus: gold.syllabus.length,
    filesListHidden: gold.crawl.filesListHidden,
    requests: gold.crawl.requests,
  };
}
