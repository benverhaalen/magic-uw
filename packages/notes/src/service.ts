/**
 * The notes service behind the `notes` command (CoreSeams.notes). Code does all of it at 0 tokens
 * except `notes.fill`, which runs one checked call only when the student asks.
 *
 * - `refresh()` pre-creates the code-built scaffold for every lecture, discussion and lab in the
 *   rolling window (this week plus next) and refreshes untouched scaffolds when the schedule or
 *   materials change; each refresh is a new version. A note the student edited is never rebuilt.
 * - `notes.open` also creates a note lazily for a session outside the window.
 * - Edited notes become passages (a "notes" source, one resource per note), so search, the
 *   notebook and analytics read them. They are `course_text` for maySend like any course text.
 * - `syncTick()` keeps notes the student exported in two-way sync; nothing is created remotely in
 *   the background, and a remote edit never silently replaces an unsynced local one.
 */
import type {
  CourseCoreStore,
  NoteBlock,
  NoteDetail,
  NoteRemoteState,
  NoteSummary,
  NoteSyncProvider,
  NoteTemplateId,
  NoteTree,
  NotesRequest,
  NotesResult,
  NotesSyncStatus,
  Resource,
  SessionType,
  Store,
} from "@magic/contracts";
import { createHash } from "node:crypto";
import type { LearningStore } from "../../learning/src/store";
import type { ModelRunner } from "../../runner/src/index";
import { courseInclusion } from "../../core/src/access";
import type { SqlNotesStore, NoteRecord, NoteRemoteRecord } from "./sql-store";
import {
  addDays,
  chicago,
  createSessionsAdapter,
  memoStore,
  parseSessionId,
  rollingWindow,
  type CanvasCourseInfo,
  type NoteSession,
  type SessionsPort,
} from "./sessions";
import { courseContext, scaffold, scaffoldBlocks, SCAFFOLD_VERSION, sessionLabel, sessionOrdinal, type CourseContext } from "./scaffold";
import type { CourseRef } from "../../contracts/src/course-core"; // owner: drain
import { suggestTemplate, templateBlocks, templateInfo, TEMPLATES } from "./templates/index";
import { blocksText, docxToHtml, htmlToBlocks, noteToDocx, sameContent } from "./docx";
import type { NotesRemote } from "./remote";
import { fillFromSlides } from "./fill";

export type NotesWorkspaceStore = Store & CourseCoreStore & { learning: LearningStore; notes: SqlNotesStore };
export interface NotesServiceDeps {
  store: NotesWorkspaceStore;
  sessions?: SessionsPort & { course(courseId: string, accountScope?: string): CanvasCourseInfo | null };
  runner?: () => ModelRunner | null | Promise<ModelRunner | null>;
  remotes?: Partial<Record<NoteSyncProvider, NotesRemote>>;
  now?: () => Date;
}
const HEAD = new Set(["context", "sources", "terms", "due"]);
const PROVIDERS: NoteSyncProvider[] = ["microsoft", "google"];
/** A provider is checked at most this often on the refresh tick. */
export const SYNC_INTERVAL_MS = 120_000;
export const NOTE_URL = "https://local-note.invalid/";

export function createNotesService(deps: NotesServiceDeps) {
  const { store } = deps;
  const notes = store.notes;
  const now = deps.now ?? (() => new Date());
  const iso = () => now().toISOString();
  // One operation (a refresh, a tree, an open) reads each list once through a memo view.
  let view: NotesWorkspaceStore = store;
  const port = deps.sessions ?? createSessionsAdapter(() => view);
  function memo<T>(run: () => T): T {
    if (view !== store) return run();
    view = memoStore(store);
    try {
      return run();
    } finally {
      view = store;
    }
  }
  const remotes = deps.remotes ?? {};
  let fingerprint: string | null = null;

  // ---------- reading ----------
  function syncOf(n: NoteRecord, rs: NoteRemoteRecord[]): NoteSummary["sync"] {
    if (n.conflictVersion !== null || rs.some((r) => r.status === "conflict")) return "conflict";
    if (!rs.length) return "local";
    return rs.every((r) => r.syncedVersion === n.revision) ? "synced" : "pending";
  }
  function summary(n: NoteRecord, blocks = notes.blocks(n.id) ?? []): NoteSummary {
    const first =
      blocks.filter((b) => !HEAD.has(b.id)).flatMap((b) => b.items)[0]?.text ??
      (n.state === "untouched" ? "" : blocks.flatMap((b) => b.items)[0]?.text ?? "");
    return {
      id: n.id,
      courseId: n.courseId,
      accountScope: n.accountScope,
      title: n.title,
      sessionId: n.sessionId,
      sessionType: n.sessionType,
      date: n.sessionDate,
      moduleName: n.moduleName,
      template: n.template,
      state: n.state,
      sync: syncOf(n, notes.remotes({ noteId: n.id })),
      revision: n.revision,
      updatedAt: n.updatedAt,
      editedAt: n.editedAt,
      preview: first.split(/\r?\n/)[0]!.slice(0, 160),
      scheduled: n.scheduled,
    };
  }
  function detail(id: string): NoteDetail {
    const n = notes.note(id)!;
    const blocks = notes.blocks(id) ?? [];
    return {
      ...summary(n, blocks),
      blocks,
      session: n.session,
      versions: notes.versions(id),
      suggestions: notes.suggestions(id),
      remotes: notes.remotes({ noteId: id }).map(
        (r): NoteRemoteState => ({
          provider: r.provider,
          webUrl: r.webUrl,
          syncedVersion: r.syncedVersion,
          syncedAt: r.syncedAt,
          status: r.status !== "error" && r.syncedVersion !== n.revision && r.status === "synced" ? "pending" : r.status,
          error: r.error,
        }),
      ),
      templateReason: n.templateReason,
    };
  }

  // ---------- creating and refreshing scaffolds ----------
  const contexts = new Map<string, CourseContext>();
  // owner: drain. The view, sessions port and context cache are parameters so `reconcile()` can
  // run one course against its own narrow view while other notes operations use `view`.
  type Reads = { v: NotesWorkspaceStore; p: typeof port; cache: Map<string, CourseContext> };
  const shared = (): Reads => ({ v: view, p: port, cache: contexts });
  function contextFor(course: CanvasCourseInfo, reads: Reads = shared()): CourseContext {
    const key = `${course.accountScope}\u0000${course.courseId}`;
    let ctx = reads.cache.get(key);
    if (!ctx) reads.cache.set(key, (ctx = courseContext(reads.v, course)));
    return ctx;
  }
  function templateFor(course: CanvasCourseInfo, type: SessionType): { template: NoteTemplateId; reason: string } {
    const chosen = notes.templateChoice(course.accountScope, course.courseId, type);
    if (chosen) return { template: chosen, reason: "chosen by you for this course" };
    const s = suggestTemplate({ courseName: course.courseName, courseCode: course.courseCode }, { type });
    return { template: s.template, reason: s.reason };
  }
  function shortCourse(course: CanvasCourseInfo): string {
    const code = (course.courseCode ?? "").replace(/^(?:FA|SP|SU)\d{2}\s+/i, "").replace(/\s+\d{3}$/, "");
    return code || course.courseName.split(":")[0]!.trim();
  }
  function titleFor(course: CanvasCourseInfo, s: NoteSession): string {
    const type = `${s.type[0]!.toUpperCase()}${s.type.slice(1)}`;
    return `${shortCourse(course)} ${type} · ${sessionLabel({ ...s, startMinute: null, endMinute: null })}`;
  }
  function createForSession(course: CanvasCourseInfo, s: NoteSession): NoteRecord {
    return insertForSession(course, s, buildForSession(course, s));
  }
  function buildForSession(course: CanvasCourseInfo, s: NoteSession, reads: Reads = shared()) {
    const ctx = contextFor(course, reads);
    return { built: scaffold(store, ctx, s, sessionOrdinal(reads.p, ctx, s)), ...templateFor(course, s.type) };
  }
  function insertForSession(
    course: CanvasCourseInfo,
    s: NoteSession,
    { built, template, reason }: ReturnType<typeof buildForSession>,
  ): NoteRecord {
    const note = notes.insert(
      {
        id: `note-${createHash("sha256").update(`${course.accountScope}\u0000${s.id}`).digest("hex").slice(0, 20)}`,
        accountScope: course.accountScope,
        courseId: course.courseId,
        sessionId: s.id,
        session: sessionRef(s),
        sessionDate: s.date,
        sessionType: s.type,
        moduleId: built.moduleId,
        moduleName: built.moduleName,
        title: titleFor(course, s),
        template,
        templateReason: reason,
        state: "untouched",
        scaffoldHash: built.hash,
        scheduled: true,
        editedAt: null,
      },
      scaffoldBlocks(built, template),
      "scaffold",
    );
    notes.setLinks(note.id, built.links);
    return note;
  }
  function sessionRef(s: NoteSession) {
    const { accountScope: _a, courseId: _c, courseName: _n, courseSessionId: _s, ...ref } = s;
    return ref;
  }
  /** An untouched scaffold is rebuilt when its inputs changed; an edited note keeps its content. */
  function refreshNote(course: CanvasCourseInfo, n: NoteRecord, s: NoteSession): "refreshed" | "kept" {
    const planned = planRefresh(course, n, s);
    planned.apply?.();
    return planned.outcome;
  }
  /**
   * What refreshing one note would write, without writing it. `apply` re-reads the note first and
   * writes nothing if it changed since (the student edited it while a batched run yielded).
   */
  function planRefresh(
    course: CanvasCourseInfo,
    n: NoteRecord,
    s: NoteSession,
    reads: Reads = shared(),
  ): { outcome: "refreshed" | "kept"; apply?: () => void } {
    const ref = sessionRef(s);
    const moved = JSON.stringify(n.session) !== JSON.stringify(ref) || !n.scheduled;
    const unchanged = () => notes.note(n.id)?.revision === n.revision;
    const move = moved ? () => void (unchanged() && notes.patch(n.id, { session: ref, scheduled: true })) : undefined;
    if (n.state !== "untouched") return { outcome: "kept", ...(move ? { apply: move } : {}) };
    const ctx = contextFor(course, reads);
    const built = scaffold(store, ctx, s, sessionOrdinal(reads.p, ctx, s));
    if (built.hash === n.scaffoldHash) return { outcome: "kept", ...(move ? { apply: move } : {}) };
    return {
      outcome: "refreshed",
      apply() {
        const current = notes.note(n.id);
        if (!current || current.revision !== n.revision || current.state !== "untouched") return;
        notes.addVersion(n.id, scaffoldBlocks(built, n.template), "scaffold", {
          scaffoldHash: built.hash,
          session: ref,
          scheduled: true,
          moduleId: built.moduleId,
          moduleName: built.moduleName,
          title: titleFor(course, s),
        });
        notes.setLinks(n.id, built.links);
      },
    };
  }
  function currentCourses(reads: Pick<Reads, "v" | "p"> = shared()): CanvasCourseInfo[] {
    const { v: view, p: port } = reads;
    const sources = new Map(view.sources().map((s) => [s.id, s]));
    const included = courseInclusion(view);
    const seen = new Set<string>();
    const out: CanvasCourseInfo[] = [];
    for (const r of view.resources()) {
      if (r.deleted || r.kind !== "course" || !included(r)) continue;
      const src = sources.get(r.sourceId);
      if (!src || src.kind === "notes") continue;
      const key = `${src.accountScope}\u0000${r.courseId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const info = port.course(r.courseId, src.accountScope);
      if (info) out.push(info);
    }
    return out;
  }
  function inputsFingerprint(window: { from: string; to: string }): string {
    const parts = [
      window.from,
      ...view
        .sources()
        .filter((s) => s.kind !== "notes")
        .map((s) => `${s.id}:${s.lastSuccessAt}:${s.resourceCount}`),
      ...store.planningSources().map((s) => `${s.id}:${s.observedAt}`),
      String(store.courseSessions().length),
      String(store.mapLinks().length),
      JSON.stringify(store.courseOverrides()),
    ];
    return createHash("sha256").update(parts.join("\n")).digest("hex");
  }
  /**
   * The rolling window: every scheduled lecture, discussion and lab this week and next has a note.
   * Skipped when nothing it reads changed since the last run (the refresh tick calls it often).
   */
  function refresh(options: { force?: boolean } = {}) {
    return memo(() => refreshWindow(options));
  }
  function refreshWindow(options: { force?: boolean }) {
    const window = rollingWindow(now());
    const print = inputsFingerprint(window);
    const stats = { courses: 0, sessions: 0, created: 0, refreshed: 0, kept: 0, unscheduled: 0, skipped: false };
    if (!options.force && print === fingerprint) return { ...stats, skipped: true };
    contexts.clear();
    for (const course of currentCourses()) {
      stats.courses++;
      const sessions = port.sessions(course.courseId, window).filter((s) => s.type !== "other");
      const listed = new Set(sessions.map((s) => s.id));
      for (const s of sessions) {
        stats.sessions++;
        const existing = notes.noteBySession(course.accountScope, course.courseId, s.id);
        if (!existing) {
          createForSession(course, s);
          stats.created++;
        } else stats[refreshNote(course, existing, s)]++;
      }
      // A session the schedule no longer lists keeps its note; it is only marked.
      for (const n of notes.notes({ accountScope: course.accountScope, courseId: course.courseId }))
        if (n.sessionId && n.scheduled && n.sessionDate && n.sessionDate >= window.from && n.sessionDate <= window.to && !listed.has(n.sessionId)) {
          notes.patch(n.id, { scheduled: false }, false);
          stats.unscheduled++;
        }
    }
    fingerprint = print;
    contexts.clear();
    return stats;
  }

  // owner: drain. The incremental, sliced refresh the worker runs (never during a sync read).
  const courseMarks = new Map<string, string>();
  type ReconcileStore = NotesWorkspaceStore &
    Partial<{ sourceResources(sourceId: string): Resource[]; courseDigest(course: CourseRef): string; courseDerivedHash(course: CourseRef): string | undefined; deriveBatch<T>(run: () => T): T }>;
  /**
   * A sessions port that reads each course's sessions once per start date, up to `to`, and answers
   * a narrower range by filtering it: a session's ordinal (every session since the term began) no
   * longer rescans the calendar for each session. The same answer: sessions are per-day records
   * filtered by date, sorted by date then start.
   */
  function windowedSessions(inner: typeof port, to: string): typeof port {
    const lists = new Map<string, NoteSession[]>();
    return {
      course: inner.course,
      sessions(courseId, range) {
        if (range.to > to) return inner.sessions(courseId, range);
        const key = `${courseId}\u0000${range.from}`;
        let all = lists.get(key);
        if (!all) lists.set(key, (all = inner.sessions(courseId, { from: range.from, to })));
        return all.filter((x) => x.date <= range.to);
      },
    };
  }
  /** A read-through view whose `resources()` is the given list (in `resources()` order). */
  function narrowView(list: Resource[]): NotesWorkspaceStore {
    return memoStore({ ...store, resources: (search?: string) => (search === undefined ? list : store.resources(search)) });
  }
  /**
   * `refresh()`'s result, reached incrementally and in slices:
   * - skipped when nothing it reads changed (the same fingerprint as `refresh()`);
   * - per course, a fingerprint of that course's inputs (its resources, completions and derived
   *   facts, the shared account-level lists, sessions sources, map links, profile, template choices,
   *   its notes, the window); a course whose fingerprint is unchanged costs one comparison;
   * - a changed course reads only the resources it can use (its own sources and the account-level
   *   ones, not the whole workspace), plans each session's scaffold, and writes only notes whose
   *   scaffold changed and that the student never edited, re-checked at write time;
   * - writes go in one transaction per stretch of about `budgetMs`, with a yield between stretches;
   *   the signal (a sync starting, a purge) stops it between stretches, and the next run continues.
   */
  async function reconcile(options: { signal?: AbortSignal; budgetMs?: number } = {}) {
    const s = store as ReconcileStore;
    const budgetMs = options.budgetMs ?? 8;
    const stats = {
      courses: 0, sessions: 0, created: 0, refreshed: 0, kept: 0, unscheduled: 0, skipped: false,
      unchanged: 0, transactions: 0, maxBatchMs: 0, interrupted: false,
    };
    let stretch = performance.now();
    const elapsed = () => performance.now() - stretch;
    const breathe = async () => {
      stats.maxBatchMs = Math.max(stats.maxBatchMs, elapsed());
      await new Promise<void>((resolve) => setImmediate(resolve));
      stretch = performance.now();
    };
    let queue: (() => void)[] = [];
    const flush = () => {
      if (!queue.length) return;
      const run = queue;
      queue = [];
      const apply = () => run.forEach((write) => write());
      if (s.deriveBatch) s.deriveBatch(apply);
      else apply();
      stats.transactions++;
    };
    const stopped = () => {
      flush();
      stats.maxBatchMs = Math.max(stats.maxBatchMs, elapsed());
      return { ...stats, interrupted: true };
    };

    const window = rollingWindow(now());
    const print = inputsFingerprint(window);
    if (print === fingerprint) return { ...stats, skipped: true };
    const sources = store.sources().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const read = (id: string) => (s.sourceResources ? s.sourceResources(id) : store.resources().filter((r) => r.sourceId === id));
    // The course list and inclusion read only the course records, not every resource.
    const records = narrowView(sources.filter((x) => x.scope === "course").flatMap((x) => read(x.id)));
    const courses = currentCourses({ v: records, p: createSessionsAdapter(() => records) });
    const real = new Set(records.resources().filter((r) => r.kind === "course").map((r) => r.courseId));
    const planning = store.planningSources().map((x) => `${x.id}:${x.observedAt}`);
    const overrides = JSON.stringify(store.courseOverrides());
    const selectedTerm = store.ingestionSettings().selectedTerm ?? "";
    const digests = new Map<string, string>();
    const digest = (c: CourseRef) => {
      const key = `${c.accountScope}\u0000${c.courseId}`;
      let d = digests.get(key);
      if (d === undefined) digests.set(key, (d = s.courseDigest ? s.courseDigest(c) : ""));
      return d;
    };
    if (elapsed() >= budgetMs) await breathe();

    for (const course of courses) {
      if (options.signal?.aborted) return stopped();
      const key = `${course.accountScope}\u0000${course.courseId}`;
      // What a course's notes can read: its own sources and the account-level lists.
      const mine = sources.filter((x) => x.courseId === course.courseId || !real.has(x.courseId));
      const groups = [...new Map(mine.map((x) => [`${x.accountScope}\u0000${x.courseId}`, { accountScope: x.accountScope, courseId: x.courseId }])).values()];
      const ref = { accountScope: course.accountScope, courseId: course.courseId };
      const markOf = () =>
        createHash("sha256")
          .update(
            JSON.stringify([
              SCAFFOLD_VERSION, window, course, groups.map((g) => [g, digest(g)]), s.courseDerivedHash?.(ref) ?? "",
              store.mapLinks(ref), store.courseSessions(ref), planning, overrides, selectedTerm,
              store.courseIntelligence().filter((p) => p.accountScope === course.accountScope && p.courseId === course.courseId),
              (["lecture", "discussion", "lab"] as const).map((t) => notes.templateChoice(course.accountScope, course.courseId, t)),
              notes.notes(ref).map((n) => [n.id, n.revision, n.state, n.scheduled, n.sessionId, n.sessionDate]),
            ]),
          )
          .digest("hex");
      if (courseMarks.get(key) === markOf()) {
        stats.unchanged++;
        if (elapsed() >= budgetMs) await breathe();
        continue;
      }
      stats.courses++;
      const list: Resource[] = [];
      for (const x of mine) {
        list.push(...read(x.id));
        if (elapsed() >= budgetMs) {
          await breathe();
          if (options.signal?.aborted) return stopped();
        }
      }
      const v = narrowView(list);
      const reads: Reads = { v, p: windowedSessions(createSessionsAdapter(() => v), window.to), cache: new Map() };
      const sessions = reads.p.sessions(course.courseId, window).filter((x) => x.type !== "other");
      if (elapsed() >= budgetMs) {
        await breathe();
        if (options.signal?.aborted) return stopped();
      }
      if (sessions.length) {
        contextFor(course, reads); // the course's inputs, in their own stretch (only when a session needs them)
        if (elapsed() >= budgetMs) {
          await breathe();
          if (options.signal?.aborted) return stopped();
        }
      }
      const listed = new Set(sessions.map((x) => x.id));
      for (const session of sessions) {
        stats.sessions++;
        const existing = notes.noteBySession(course.accountScope, course.courseId, session.id);
        if (!existing) {
          const built = buildForSession(course, session, reads);
          queue.push(() => {
            if (!notes.noteBySession(course.accountScope, course.courseId, session.id)) insertForSession(course, session, built);
          });
          stats.created++;
        } else {
          const planned = planRefresh(course, existing, session, reads);
          if (planned.apply) queue.push(planned.apply);
          stats[planned.outcome]++;
        }
        if (elapsed() >= budgetMs) {
          flush();
          await breathe();
          if (options.signal?.aborted) return stopped();
        }
      }
      // A session the schedule no longer lists keeps its note; it is only marked.
      for (const n of notes.notes(ref))
        if (n.sessionId && n.scheduled && n.sessionDate && n.sessionDate >= window.from && n.sessionDate <= window.to && !listed.has(n.sessionId)) {
          queue.push(() => {
            if (notes.note(n.id)?.revision === n.revision) notes.patch(n.id, { scheduled: false }, false);
          });
          stats.unscheduled++;
        }
      flush();
      // The mark after this pass's own writes, so an unchanged course is skipped next time.
      courseMarks.set(key, markOf());
      if (elapsed() >= budgetMs) await breathe();
    }
    fingerprint = print;
    stats.maxBatchMs = Math.max(stats.maxBatchMs, elapsed());
    return stats;
  }

  // ---------- passages ----------
  /** An edited note's text as one resource of the course's "notes" source (passages, search). */
  function indexNote(id: string) {
    const n = notes.note(id);
    if (!n || n.state === "untouched") return;
    const blocks = notes.blocks(id) ?? [];
    const course = port.course(n.courseId, n.accountScope);
    store.ingest({
      source: {
        id: `notes:${n.accountScope}:${n.courseId}`.slice(0, 500),
        label: "My notes",
        kind: "notes",
        accountScope: n.accountScope,
        courseId: n.courseId,
        scope: "notes",
      },
      observedAt: iso(),
      complete: false,
      status: "ok",
      resources: [
        {
          externalId: n.id,
          kind: "material",
          courseId: n.courseId,
          courseName: course?.courseName ?? n.courseId,
          title: n.title,
          url: `${NOTE_URL}${encodeURIComponent(n.id)}`,
          text: blocksText(blocks).slice(0, 200000),
          contentType: "text/plain",
          createdAt: n.createdAt,
          updatedAt: n.updatedAt,
        },
      ],
    });
  }

  // ---------- sync ----------
  function exportBlocks(blocks: NoteBlock[]): NoteBlock[] {
    return blocks.map(({ hint: _hint, ...b }) => b);
  }
  function remoteName(n: NoteRecord): { folders: string[]; name: string } {
    const course = port.course(n.courseId, n.accountScope);
    const folder = course ? shortCourse(course) : n.courseId;
    const name = n.sessionDate ? `${n.sessionDate} ${n.sessionType ?? "note"}` : n.title;
    return { folders: [folder], name: `${name}.docx` };
  }
  async function push(n: NoteRecord, remote: NotesRemote): Promise<NoteRemoteRecord> {
    const prior = notes.remote(n.id, remote.provider) ?? null;
    const bytes = await noteToDocx(n.title, exportBlocks(notes.blocks(n.id) ?? []));
    const saved = await remote.put({
      ...remoteName(n),
      bytes,
      remote: prior ? { remoteId: prior.remoteId, webUrl: prior.webUrl, etag: prior.etag, modifiedTime: prior.modifiedTime } : null,
    });
    const record: NoteRemoteRecord = {
      noteId: n.id,
      provider: remote.provider,
      remoteId: saved.remoteId,
      webUrl: saved.webUrl,
      etag: saved.etag,
      modifiedTime: saved.modifiedTime,
      syncedVersion: n.revision,
      syncedAt: iso(),
      status: "synced",
      error: null,
    };
    notes.putRemote(record);
    return record;
  }
  /** One note with one provider: pull a remote change, else push local edits. Never drops either side. */
  async function syncOne(rec: NoteRemoteRecord, remote: NotesRemote): Promise<"unchanged" | "pulled" | "pushed" | "conflict" | "missing"> {
    const n = notes.note(rec.noteId);
    if (!n) return "unchanged";
    const read = await remote.get({ remoteId: rec.remoteId, webUrl: rec.webUrl, etag: rec.etag, modifiedTime: rec.modifiedTime });
    if (read.status === "missing") {
      notes.putRemote({ ...rec, status: "error", error: "The document was deleted or moved; your note here is unchanged." });
      return "missing";
    }
    if (read.status === "unchanged") {
      if (n.revision > rec.syncedVersion && n.conflictVersion === null) {
        await push(n, remote);
        return "pushed";
      }
      return "unchanged";
    }
    const html = read.format === "docx" ? await docxToHtml(read.bytes) : new TextDecoder().decode(read.bytes);
    const base = notes.blocks(n.id, rec.syncedVersion) ?? notes.blocks(n.id) ?? [];
    const current = notes.blocks(n.id) ?? [];
    const { blocks } = htmlToBlocks(html, base);
    const mark = { etag: read.etag, modifiedTime: read.modifiedTime, syncedAt: iso(), error: null };
    if (sameContent(blocks, current)) {
      notes.putRemote({ ...rec, ...mark, syncedVersion: n.revision, status: "synced" });
      return "unchanged";
    }
    const localEdits = n.revision > rec.syncedVersion && !sameContent(current, base);
    // Remote edits become a new version. Local edits made since the last sync stay as their own
    // version, kept from pruning and flagged, so neither side is lost.
    const revision = notes.addVersion(n.id, blocks, "remote", {
      state: "edited",
      editedAt: iso(),
      ...(localEdits ? { conflictVersion: n.revision } : {}),
    });
    notes.putRemote({ ...rec, ...mark, syncedVersion: revision, status: localEdits ? "conflict" : "synced" });
    indexNote(n.id);
    return localEdits ? "conflict" : "pulled";
  }
  async function syncTick(options: { force?: boolean } = {}) {
    const stats = { checked: 0, pulled: 0, pushed: 0, conflicts: 0, errors: 0 };
    for (const provider of PROVIDERS) {
      const setting = notes.syncSetting(provider);
      const remote = remotes[provider];
      if (!setting.enabled || !remote) continue;
      if (!options.force && setting.lastCheckAt && now().getTime() - Date.parse(setting.lastCheckAt) < SYNC_INTERVAL_MS) continue;
      let message: string | null = null;
      for (const rec of notes.remotes({ provider })) {
        stats.checked++;
        try {
          const outcome = await syncOne(rec, remote);
          if (outcome === "pulled") stats.pulled++;
          if (outcome === "pushed") stats.pushed++;
          if (outcome === "conflict") stats.conflicts++;
          if (outcome === "missing") stats.errors++;
        } catch (error) {
          stats.errors++;
          message = error instanceof Error ? error.message.slice(0, 300) : "Sync failed.";
          notes.putRemote({ ...rec, status: "error", error: message });
        }
      }
      notes.setSyncSetting({ ...notes.syncSetting(provider), lastCheckAt: iso(), message });
    }
    return stats;
  }
  async function syncStatus(): Promise<NotesSyncStatus> {
    const providers = [];
    for (const provider of PROVIDERS) {
      const s = notes.syncSetting(provider);
      const rs = notes.remotes({ provider });
      const remote = remotes[provider];
      let connected = false;
      try {
        connected = remote ? await remote.connected() : false;
      } catch {
        connected = false;
      }
      providers.push({
        provider,
        enabled: s.enabled,
        connected,
        enabledAt: s.enabledAt,
        lastCheckAt: s.lastCheckAt,
        notes: rs.length,
        conflicts: rs.filter((r) => r.status === "conflict").length,
        errors: rs.filter((r) => r.status === "error").length,
        message: remote ? s.message : provider === "microsoft" ? "Word sync needs the Microsoft connection, which isn't in this build yet." : "Google Docs sync isn't configured in this build.",
      });
    }
    return { providers };
  }

  // ---------- commands ----------
  const fail = (op: NotesRequest["op"], status: Exclude<NotesResult["status"], "ok">, message: string, extra: object = {}): NotesResult =>
    ({ op, status, message, ...extra }) as NotesResult;
  function studentBlockIndex(blocks: NoteBlock[]): number {
    const i = blocks.findIndex((b) => !HEAD.has(b.id) && (b.kind === "section" || b.kind === "cues" || b.kind === "vocabulary"));
    return i >= 0 ? i : blocks.findIndex((b) => !HEAD.has(b.id));
  }
  function edit(id: string, blocks: NoteBlock[], origin: "student" | "fill" | "template", extra: Parameters<SqlNotesStore["addVersion"]>[3] = {}) {
    notes.addVersion(id, blocks, origin, { state: "edited", editedAt: iso(), ...extra });
    indexNote(id);
  }
  /** Moves the student's content into a new template's blocks; nothing is dropped. */
  function switchTemplate(blocks: NoteBlock[], template: NoteTemplateId): NoteBlock[] {
    const head = blocks.filter((b) => HEAD.has(b.id));
    const next = templateBlocks(template);
    const extra: NoteBlock[] = [];
    for (const old of blocks.filter((b) => !HEAD.has(b.id) && b.items.length)) {
      const target = next.find((b) => b.kind === old.kind && !b.items.length) ?? next.find((b) => b.id === old.id && !b.items.length);
      if (target) target.items = old.items;
      else extra.push(old);
    }
    return [...head, ...next, ...extra];
  }
  function sessionFor(id: string): { course: CanvasCourseInfo; session: NoteSession } | null {
    const parsed = parseSessionId(id);
    if (!parsed) return null;
    const course = port.course(parsed.courseId);
    if (!course) return null;
    const session = port.sessions(parsed.courseId, { from: parsed.date, to: parsed.date }).find((s) => s.id === id);
    return session ? { course, session } : null;
  }
  function openSession(id: string): { note: NoteRecord; created: boolean } | null {
    const parsed = parseSessionId(id);
    if (!parsed) return null;
    const course = port.course(parsed.courseId);
    if (!course) return null;
    const existing = notes.noteBySession(course.accountScope, course.courseId, id);
    if (existing) return { note: existing, created: false };
    const found = sessionFor(id);
    if (!found) return null;
    contexts.clear();
    const note = createForSession(found.course, found.session);
    contexts.clear();
    return { note, created: true };
  }

  async function handle(request: NotesRequest, signal?: AbortSignal): Promise<NotesResult> {
    switch (request.op) {
      case "notes.tree":
        return { op: request.op, status: "ok", tree: memo(() => tree(request.courseId, request.accountScope)) };
      case "notes.recent":
        return { op: request.op, status: "ok", notes: recent(request.courseId, request.limit) };
      case "notes.templates":
        return { op: request.op, status: "ok", templates: templateInfo() };
      case "notes.open": {
        if (request.noteId) {
          const n = notes.note(request.noteId);
          return n ? { op: request.op, status: "ok", note: detail(n.id), created: false } : fail(request.op, "not_found", "That note isn't on this device.");
        }
        if (!request.sessionId) return fail(request.op, "needs_clarification", "Choose a session or a note.");
        const sessionId = request.sessionId;
        const opened = memo(() => openSession(sessionId));
        return opened
          ? { op: request.op, status: "ok", note: detail(opened.note.id), created: opened.created }
          : fail(request.op, "not_found", "That session isn't in the schedule.");
      }
      case "notes.save": {
        const n = notes.note(request.noteId);
        if (!n) return fail(request.op, "not_found", "That note isn't on this device.");
        if (request.revision !== n.revision)
          return fail(request.op, "stale_revision", "This note changed since you opened it (in another window or from sync). Your text wasn't saved; merge it into the current version.", {
            note: detail(n.id),
          });
        const current = notes.blocks(n.id) ?? [];
        if (JSON.stringify(current) !== JSON.stringify(request.blocks))
          edit(n.id, request.blocks, "student", { conflictVersion: null });
        return { op: request.op, status: "ok", note: detail(n.id) };
      }
      case "notes.setTemplate": {
        const n = notes.note(request.noteId);
        if (!n) return fail(request.op, "not_found", "That note isn't on this device.");
        notes.setTemplateChoice(n.accountScope, n.courseId, n.sessionType ?? "other", request.template);
        if (n.template !== request.template) {
          const blocks = notes.blocks(n.id) ?? [];
          const patch = { template: request.template, templateReason: "chosen by you for this course" };
          if (n.state === "untouched") notes.addVersion(n.id, [...blocks.filter((b) => HEAD.has(b.id)), ...templateBlocks(request.template)], "template", patch);
          else edit(n.id, switchTemplate(blocks, request.template), "template", patch);
        }
        return { op: request.op, status: "ok", note: detail(n.id) };
      }
      case "notes.create": {
        const course = port.course(request.courseId, request.accountScope);
        if (!course) return fail(request.op, "not_found", "That course isn't on this device.");
        const { template, reason } = templateFor(course, "other");
        const n = notes.insert(
          {
            id: `note-${createHash("sha256").update(`${course.accountScope}\u0000${course.courseId}\u0000${request.title}\u0000${iso()}`).digest("hex").slice(0, 20)}`,
            accountScope: course.accountScope,
            courseId: course.courseId,
            sessionId: null,
            session: null,
            sessionDate: null,
            sessionType: null,
            moduleId: null,
            moduleName: null,
            title: request.title,
            template,
            templateReason: reason,
            state: "untouched",
            scaffoldHash: null,
            scheduled: true,
            editedAt: null,
          },
          templateBlocks(template),
          "student",
        );
        return { op: request.op, status: "ok", note: detail(n.id), created: true };
      }
      case "notes.append": {
        const n = notes.note(request.noteId);
        if (!n) return fail(request.op, "not_found", "That note isn't on this device.");
        const blocks = structuredClone(notes.blocks(n.id) ?? []);
        const at = studentBlockIndex(blocks);
        const itemId = `a-${createHash("sha256").update(`${request.text}\u0000${iso()}\u0000${n.revision}`).digest("hex").slice(0, 12)}`;
        const added = { id: itemId, text: request.text, origin: "student" as const };
        if (at >= 0) blocks[at]!.items.push(added);
        else blocks.push({ id: "notes", kind: "section", heading: "Notes", items: [added] });
        edit(n.id, blocks, "student");
        return { op: request.op, status: "ok", note: detail(n.id) };
      }
      case "notes.version": {
        const n = notes.note(request.noteId);
        const blocks = n && notes.blocks(n.id, request.version);
        if (!n || !blocks) return fail(request.op, "not_found", "That version isn't kept any more.");
        edit(n.id, blocks, "student");
        return { op: request.op, status: "ok", note: detail(n.id) };
      }
      case "notes.suggestion": {
        const n = notes.note(request.noteId);
        const s = n && notes.suggestions(n.id).find((x) => x.id === request.suggestionId);
        if (!n || !s) return fail(request.op, "not_found", "That suggestion isn't there any more.");
        if (s.status === "pending") {
          if (request.action === "accept") {
            const blocks = structuredClone(notes.blocks(n.id) ?? []);
            const target = blocks.find((b) => b.id === s.blockId) ?? blocks[studentBlockIndex(blocks)];
            const r = store.resource(s.resourceId);
            const item = {
              id: s.id,
              text: s.text,
              origin: "fill" as const,
              ...(r && /^https:/.test(r.url) ? { link: { title: r.title.slice(0, 500), url: r.url, resourceId: r.id } } : {}),
            };
            if (target) target.items.push(item);
            else blocks.push({ id: "notes", kind: "section", heading: "Notes", items: [item] });
            edit(n.id, blocks, "fill");
          }
          notes.setSuggestionStatus(s.id, request.action === "accept" ? "accepted" : "dismissed");
        }
        return { op: request.op, status: "ok", note: detail(n.id) };
      }
      case "notes.fill": {
        const n = notes.note(request.noteId);
        if (!n) return fail(request.op, "not_found", "That note isn't on this device.");
        const course = port.course(n.courseId, n.accountScope);
        const resourceIds = request.resourceIds?.length
          ? request.resourceIds
          : notes.links(n.id).filter((l) => l.role !== "module").map((l) => l.resourceId);
        const outcome = await fillFromSlides(
          { store, runner: deps.runner ?? (() => null), now },
          { id: n.id, accountScope: n.accountScope, courseId: n.courseId, courseName: course?.courseName ?? n.courseId, blocks: notes.blocks(n.id) ?? [] },
          resourceIds,
          signal,
        );
        if (outcome.status !== "ok") return fail(request.op, outcome.status, outcome.message);
        notes.addSuggestions(n.id, outcome.suggestions);
        const ids = new Set(outcome.suggestions.map((s) => s.id));
        return {
          op: request.op,
          status: "ok",
          note: detail(n.id),
          suggestions: notes.suggestions(n.id).filter((s) => ids.has(s.id)),
          cached: outcome.cached,
          tokens: outcome.tokens,
          dropped: outcome.dropped,
          receiptIds: outcome.receiptIds,
        };
      }
      case "notes.sync.enable": {
        const remote = remotes[request.provider];
        if (!remote)
          return fail(request.op, "not_connected", request.provider === "microsoft" ? "Word sync needs the Microsoft connection, which isn't in this build yet." : "Google Docs sync isn't configured in this build.");
        const connect = (remote as NotesRemote & { connect?: () => Promise<boolean> }).connect;
        const connected = connect ? await connect() : await remote.connected();
        if (!connected) return fail(request.op, "not_connected", "Sign-in didn't finish, so sync stays off.");
        notes.setSyncSetting({ ...notes.syncSetting(request.provider), enabled: true, enabledAt: iso(), message: null });
        return { op: request.op, status: "ok", sync: await syncStatus() };
      }
      case "notes.sync.disable":
        notes.setSyncSetting({ ...notes.syncSetting(request.provider), enabled: false });
        return { op: request.op, status: "ok", sync: await syncStatus() };
      case "notes.sync.status":
        return { op: request.op, status: "ok", sync: await syncStatus() };
      case "notes.sync.export": {
        const n = notes.note(request.noteId);
        if (!n) return fail(request.op, "not_found", "That note isn't on this device.");
        const remote = remotes[request.provider];
        if (!remote || !notes.syncSetting(request.provider).enabled)
          return fail(request.op, "sync_off", `Turn on ${request.provider === "google" ? "Google Docs" : "Word"} sync first.`);
        try {
          const prior = notes.remote(n.id, request.provider);
          const rec = prior ? await syncOne(prior, remote).then(() => notes.remote(n.id, request.provider)!) : await push(n, remote);
          return { op: request.op, status: "ok", webUrl: rec.webUrl ?? "", note: detail(n.id) };
        } catch (error) {
          return fail(request.op, "failed", error instanceof Error ? error.message.slice(0, 300) : "Export failed.");
        }
      }
    }
  }

  function tree(courseId: string, accountScope?: string): NoteTree {
    const course = port.course(courseId, accountScope);
    if (!course) return { courseId, accountScope: accountScope ?? null, courseName: null, modules: [], loose: [] };
    const window = rollingWindow(now());
    const from = course.startAt?.slice(0, 10) ?? addDays(window.from, -28);
    const sessions = port.sessions(courseId, { from, to: window.to }).filter((s) => s.type !== "other");
    const all = notes.notes({ accountScope: course.accountScope, courseId });
    const bySession = new Map(all.filter((n) => n.sessionId).map((n) => [n.sessionId!, n]));
    const groups = new Map<string, NoteTree["modules"][number]>();
    const group = (moduleId: string | null, moduleName: string | null) => {
      const key = moduleId ?? "";
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { moduleId, moduleName, sessions: [] }));
      return g;
    };
    const listed = new Set<string>();
    for (const s of sessions) {
      const n = bySession.get(s.id);
      listed.add(s.id);
      group(n?.moduleId ?? null, n?.moduleName ?? null).sessions.push({ session: sessionRef(s), note: n ? summary(n) : null });
    }
    // Notes whose session left the schedule stay in the tree.
    for (const n of all)
      if (n.sessionId && !listed.has(n.sessionId) && n.session)
        group(n.moduleId, n.moduleName).sessions.push({ session: n.session, note: summary(n) });
    for (const g of groups.values()) g.sessions.sort((a, b) => a.session.date.localeCompare(b.session.date) || (a.session.startMinute ?? 0) - (b.session.startMinute ?? 0));
    return {
      courseId,
      accountScope: course.accountScope,
      courseName: course.courseName,
      modules: [...groups.values()].sort((a, b) => (a.sessions[0]?.session.date ?? "").localeCompare(b.sessions[0]?.session.date ?? "")),
      loose: all.filter((n) => !n.sessionId).map((n) => summary(n)),
    };
  }
  /** The course page's compact list: edited notes by last edit, then the upcoming scaffolds. */
  function recent(courseId: string, limit: number): NoteSummary[] {
    const today = chicago(now()).date;
    const all = notes.notes({ courseId });
    const edited = all.filter((n) => n.state === "edited").sort((a, b) => (b.editedAt ?? "").localeCompare(a.editedAt ?? ""));
    const upcoming = all
      .filter((n) => n.state === "untouched" && (!n.sessionDate || n.sessionDate >= today))
      .sort((a, b) => (a.sessionDate ?? "9999").localeCompare(b.sessionDate ?? "9999"));
    return [...edited, ...upcoming].slice(0, limit).map((n) => summary(n));
  }
  /** Today's (or the next) session of a type for a course: for the command actions. */
  function sessionOn(courseId: string, date: string, type: SessionType = "lecture"): NoteSession | null {
    const today = chicago(now()).date;
    if (date === "today") date = today;
    if (date !== "next") return port.sessions(courseId, { from: date, to: date }).find((s) => s.type === type) ?? null;
    return port.sessions(courseId, { from: today, to: addDays(today, 21) }).find((s) => s.type === type) ?? null;
  }
  return { handle, refresh, reconcile /* owner: drain */, syncTick, sessionOn, templates: TEMPLATES };
}
export type NotesService = ReturnType<typeof createNotesService>;
