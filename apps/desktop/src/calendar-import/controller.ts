// owner: calendar-import. Google Calendar import in the student's default browser.
// Main writes each reviewed .ics to a private temporary folder, asks the browser for a NEW
// window on Google Calendar's Import & export page, and hands only that observed window's
// file chooser the exact file. The student chooses the destination and clicks Import;
// Magic reports only what it observed: dispatched, preselected, imported or unknown.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  CalendarImportCapability, CalendarImportFamily, CalendarImportFile, CalendarImportRequest, CalendarImportResult, CalendarImportSession,
} from "@magic/contracts";
import type { RunHelper } from "../task-windows/controller";

export interface CalendarImportHost {
  run: RunHelper;
  /** Headless verification never asks the browser for anything. */
  headless: boolean;
  /** Parent of the private magic-calendar-* folders (the OS temporary directory in the app). */
  tempRoot: string;
  /** Manual fallback only: shows one prepared file in Finder. */
  reveal(path: string): void;
  now(): Date;
}

/** Google's settings route for Import & export. Only used as a start; the page itself is then observed. */
export const GOOGLE_IMPORT_URL = "https://calendar.google.com/calendar/r/settings/export";
const MAX_BYTES = 1_000_000;
const WINDOW_TTL = 60 * 60_000, SESSION_TTL = 2 * 60 * 60_000, SWEEP_AGE = 24 * 60 * 60_000;
const NAMES: Record<CalendarImportFamily, string> = { combined: "UW classes and coursework", lectures: "Lectures", assignments: "Assignments", exams: "Exams & quizzes" };
const SLUGS: Record<CalendarImportFamily, string> = { combined: "UW-calendar", lectures: "Lectures", assignments: "Assignments", exams: "Exams-and-quizzes" };

const id = z.string().min(1).max(100);
const file = z.object({ family: z.enum(["combined", "lectures", "assignments", "exams"]), calendarName: z.string().max(100), events: z.number().int().min(1).max(20000), ics: z.string().max(MAX_BYTES) }).strict();
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("request-access") }).strict(),
  z.object({ action: z.literal("prepare"), mode: z.enum(["combined", "split"]), files: z.array(file).min(1).max(3) }).strict(),
  z.object({ action: z.enum(["open", "stop"]), sessionId: id }).strict(),
  z.object({ action: z.enum(["attach", "check", "create-calendar", "reveal"]), sessionId: id, fileKey: id }).strict(),
]);

/** Structure, declared count, calendar name and no links; the renderer is not trusted to have checked. */
export function checkIcs(value: z.infer<typeof file>): string | null {
  if (value.calendarName !== NAMES[value.family]) return "calendar name";
  if (Buffer.byteLength(value.ics, "utf8") > MAX_BYTES) return "size";
  if (!value.ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n") || !value.ics.endsWith("END:VCALENDAR\r\n")) return "structure";
  if ((value.ics.match(/\r\nBEGIN:VEVENT\r\n/g) ?? []).length !== value.events || (value.ics.match(/\r\nEND:VEVENT\r\n/g) ?? []).length !== value.events) return "event count";
  if (/:\/\//.test(value.ics.replace(/\r\n /g, ""))) return "link";
  return null;
}

const CODE_TEXT: Record<string, string> = {
  new_window_unsupported: "Your default browser doesn't give Magic a way to open and identify a new window.",
  several_browser_processes: "Your browser is running more than once (for example two profiles), so Magic can't tell which window is Google's.",
  ambiguous_new_window: "Your browser opened more than one window, so Magic couldn't tell which one is Google Calendar.",
  new_window_not_observed: "Your browser may have opened Google Calendar, but Magic didn't see a new window.",
  launch_failed: "Your browser didn't accept the request.",
  no_default_browser: "Magic couldn't find your default browser.",
  accessibility_required: "Magic needs Accessibility permission to hand the file to Google's file chooser.",
  browser_process_gone: "The browser window Magic opened was closed or restarted. Open Google Calendar again.",
  window_gone: "The Google Calendar window Magic opened is closed. Open Google Calendar again.",
  window_ambiguous: "Magic can't tell the Google Calendar window apart from another window of the same size, so it did nothing.",
  window_stale: "The Google Calendar window Magic opened is over an hour old. Open Google Calendar again.",
  page_not_observed: "Magic can't read the page in that window yet. Wait for Google Calendar to load, then try again.",
  not_google_calendar: "That window isn't on Google Calendar now (it may be on sign-in or another tab). Finish signing in there, then try again.",
  import_form_not_observed: "Magic didn't find Google's Import form. In the window Magic opened, choose Settings → Import & export, then try again.",
  control_not_found: "Magic didn't find that Google control on the page.",
  control_ambiguous: "Google's page shows that control more than once, so Magic didn't press it.",
  control_not_pressed: "Google's page didn't accept the press.",
  chooser_not_observed: "Google's file chooser didn't open in the window Magic opened.",
  chooser_already_open: "A file chooser is already open in that window. Close it, then try again.",
  focus_moved: "Another window took focus, so Magic closed the chooser without choosing a file.",
  go_to_field_not_observed: "The file chooser didn't offer its Go to folder field, so Magic closed it.",
  go_to_field_not_set: "The file chooser didn't accept the file location, so Magic closed it.",
  filename_mismatch: "The file chooser selected a different file, so Magic cancelled it. Nothing was sent to Google.",
  open_not_pressed: "The file chooser didn't accept Open, so Magic cancelled it.",
  invalid_file: "Magic refused a file it didn't prepare.",
  file_missing: "The prepared file is gone. Prepare the export again.",
  headless: "Browser windows are disabled in this test run.",
  helper_missing: "This build doesn't include Magic's Google Calendar helper.",
  helper_failed: "Magic's Google Calendar helper stopped unexpectedly.",
  stopped: "You stopped this import. Remaining files weren't attached.",
  busy: "Magic is still finishing the previous step.",
};
const explain = (code: unknown) => CODE_TEXT[String(code)] ?? "Magic couldn't finish that step.";
/** Permission or capability blocks automation; only then is the manual path offered. */
const MANUAL = new Set(["accessibility_required", "new_window_unsupported", "several_browser_processes", "no_default_browser", "helper_missing", "go_to_field_not_observed"]);

type OwnedWindow = { pid: number; bundleId: string; windowNumber: number; openedAt: number };
type PreparedFile = CalendarImportFile & { path: string; resultAtAttach: boolean; attachedAt?: number; attaching?: boolean };
type Session = { id: string; mode: "combined" | "split"; dir: string; files: PreparedFile[]; window: OwnedWindow | null; dispatched: boolean; page?: CalendarImportSession["page"]; stopped: boolean; touched: number; manual: boolean };

export function createCalendarImport(host: CalendarImportHost) {
  const sessions = new Map<string, Session>();
  let busy = false;
  let capability: CalendarImportCapability = { browser: null, newWindow: false, accessibility: false };

  const view = (s: Session | null): CalendarImportSession | null => s && ({
    id: s.id, mode: s.mode, window: s.window ? "observed" : s.dispatched ? "dispatched" : "none", page: s.page, stopped: s.stopped,
    files: s.files.map(({ path: _path, resultAtAttach: _r, attachedAt: _a, attaching: _b, ...shown }) => shown),
  });
  const result = (s: Session | null, notice?: string, code?: string): CalendarImportResult => {
    const manual = !!code && MANUAL.has(code);
    if (s && manual) s.manual = true;
    return { capability, session: view(s), ...(notice ? { notice } : {}), ...(manual ? { manual: true } : {}) };
  };

  async function status() {
    try {
      const reply = await host.run({ action: "status" }, 5000);
      capability = reply.event === "status"
        ? { browser: typeof reply.name === "string" ? reply.name.replace(/\.app$/, "") : null, newWindow: reply.newWindow === true, accessibility: reply.accessibility === true,
            reason: reply.newWindow === true ? undefined : CODE_TEXT.new_window_unsupported }
        : { browser: null, newWindow: false, accessibility: false, reason: explain(reply.code) };
    } catch (error) {
      capability = { browser: null, newWindow: false, accessibility: false, reason: explain((error as Error).message) };
    }
    return capability;
  }
  async function dispose(s: Session) {
    sessions.delete(s.id);
    await rm(s.dir, { recursive: true, force: true });
  }
  /** Removes abandoned private folders from earlier runs. */
  async function sweep() {
    const now = host.now().getTime();
    for (const s of [...sessions.values()]) if (now - s.touched > SESSION_TTL) await dispose(s);
    let names: string[] = [];
    try { names = await readdir(host.tempRoot); } catch { return; }
    for (const name of names) {
      if (!name.startsWith("magic-calendar-") || [...sessions.values()].some(s => s.dir === join(host.tempRoot, name))) continue;
      try { if (now - (await stat(join(host.tempRoot, name))).mtimeMs > SWEEP_AGE) await rm(join(host.tempRoot, name), { recursive: true, force: true }); } catch { /* already gone */ }
    }
  }
  function session(sessionId: string) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("This export has ended. Prepare it again.");
    s.touched = host.now().getTime();
    return s;
  }
  function owned(s: Session) {
    if (!s.window) return { error: "window_gone" };
    if (host.now().getTime() - s.window.openedAt > WINDOW_TTL) { s.window = null; return { error: "window_stale" }; }
    return { ref: { pid: s.window.pid, bundleId: s.window.bundleId, windowNumber: s.window.windowNumber } };
  }
  /** A gone or replaced window is forgotten, so nothing later acts on it. */
  function forget(s: Session, code: unknown) {
    if (["browser_process_gone", "window_gone", "window_ambiguous"].includes(String(code))) s.window = null;
  }
  async function helper(request: Record<string, unknown>, timeoutMs: number) {
    try { return await host.run(request, timeoutMs); }
    catch (error) { return { event: "error", code: (error as Error).message }; }
  }
  const pageOf = (reply: Record<string, unknown>): CalendarImportSession["page"] => reply.importForm === true ? "import" : reply.createForm === true ? "create" : "other";

  async function prepare(mode: "combined" | "split", files: z.infer<typeof file>[]) {
    const families = files.map(f => f.family);
    if (mode === "combined" ? families.join() !== "combined" : families.includes("combined") || new Set(families).size !== families.length)
      throw new Error("These files don't match the chosen calendar layout.");
    for (const f of files) { const problem = checkIcs(f); if (problem) throw new Error(`This calendar file failed its ${problem} check. Prepare it again.`); }
    await sweep();
    await mkdir(host.tempRoot, { recursive: true });
    const dir = await mkdtemp(join(host.tempRoot, "magic-calendar-"));
    const day = host.now().toISOString().slice(0, 10);
    const prepared: PreparedFile[] = [];
    try {
      for (const f of files) {
        const fileName = `Magic-${SLUGS[f.family]}-${day}-${randomBytes(3).toString("hex")}.ics`;
        const path = join(dir, fileName);
        await writeFile(path, f.ics, { encoding: "utf8", mode: 0o600, flag: "wx" });
        prepared.push({ key: randomUUID(), family: f.family, calendarName: f.calendarName, fileName, events: f.events, state: "waiting", path, resultAtAttach: false });
      }
    } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
    const s: Session = { id: randomUUID(), mode, dir, files: prepared, window: null, dispatched: false, stopped: false, touched: host.now().getTime(), manual: false };
    sessions.set(s.id, s);
    return result(s);
  }

  async function open(s: Session) {
    if (s.stopped) return result(s, CODE_TEXT.stopped);
    if (host.headless) return result(s, CODE_TEXT.headless);
    await status();
    if (!capability.newWindow) return result(s, capability.reason, "new_window_unsupported");
    s.dispatched = true; s.window = null; s.page = undefined;
    const reply = await helper({ action: "open", url: GOOGLE_IMPORT_URL, timeoutMs: 10000 }, 15000);
    if (reply.event !== "opened" || typeof reply.pid !== "number" || typeof reply.windowNumber !== "number" || typeof reply.bundleId !== "string")
      return result(s, explain(reply.code), String(reply.code));
    s.window = { pid: reply.pid, bundleId: reply.bundleId, windowNumber: reply.windowNumber, openedAt: host.now().getTime() };
    if (reply.accessibility !== true) return result(s, CODE_TEXT.accessibility_required, "accessibility_required");
    // Magic attaches the first waiting file itself once Google's own form is observed.
    const first = s.files.find(f => f.state === "waiting");
    return first ? attach(s, first) : result(s);
  }

  /** Goes back to Import & export in the owned window when the student was on another settings page. */
  async function importPage(s: Session, ref: Record<string, unknown>) {
    let page = await helper({ action: "page", ...ref, timeoutMs: 8000 }, 12000);
    if (page.event === "page" && page.importForm !== true) {
      const pressed = await helper({ action: "press", ...ref, label: "Import & export" }, 8000);
      if (pressed.event === "pressed") page = await helper({ action: "page", ...ref, timeoutMs: 6000 }, 10000);
    }
    if (page.event === "page") s.page = pageOf(page);
    return page;
  }

  async function attach(s: Session, f: PreparedFile): Promise<CalendarImportResult> {
    if (s.stopped) return result(s, CODE_TEXT.stopped);
    if (f.state === "imported") return result(s, "Google already reported importing this file. Importing it again can make duplicate events.");
    const window = owned(s);
    if (!window.ref) return result(s, explain(window.error), window.error);
    const page = await importPage(s, window.ref);
    if (s.stopped) return result(s, CODE_TEXT.stopped);
    if (page.event !== "page") { forget(s, page.code); return result(s, explain(page.code), String(page.code)); }
    if (page.importForm !== true) return result(s, CODE_TEXT.import_form_not_observed);
    // A result message still on the page from a previous file must not count for this one.
    const resultAtAttach = typeof page.imported === "number";
    f.attaching = true;
    const reply = await helper({ action: "attach", ...window.ref, path: f.path, expectedName: f.fileName }, 30000).finally(() => { f.attaching = false; });
    if (s.stopped) return result(s, CODE_TEXT.stopped);
    if (reply.event !== "attached") {
      forget(s, reply.code);
      if (reply.code === "filename_mismatch" || reply.code === "invalid_file") { f.state = "refused"; f.detail = explain(reply.code); }
      return result(s, explain(reply.code), String(reply.code));
    }
    f.resultAtAttach = resultAtAttach; f.attachedAt = host.now().getTime();
    if (typeof reply.destination === "string") f.destination = reply.destination;
    if (reply.observedFileName === f.fileName && reply.chooserClosed === true && reply.pageShowsFile === true) {
      f.state = "preselected"; f.detail = undefined;
    } else {
      f.state = "unknown";
      f.detail = reply.chooserClosed === true ? "Magic chose the file, but Google's page didn't show its name. Check the page before clicking Import." : "The file chooser didn't close as expected. Check the Google window.";
    }
    return result(s);
  }

  async function check(s: Session, f: PreparedFile) {
    if (f.state !== "preselected" && f.state !== "unknown") return result(s);
    const window = owned(s);
    if (!window.ref) return result(s, explain(window.error), window.error);
    const page = await helper({ action: "page", ...window.ref, expectedName: f.fileName, timeoutMs: 1000 }, 6000);
    // Stopped while reading: the stopped state and its history stand, whatever the page now says.
    if (s.stopped) return result(s, CODE_TEXT.stopped);
    if (page.event !== "page") { forget(s, page.code); return result(s, explain(page.code), String(page.code)); }
    s.page = pageOf(page);
    if (typeof page.destination === "string") f.destination = page.destination;
    if (typeof page.imported !== "number" || typeof page.total !== "number") {
      // An earlier file's message has since closed, so the next one seen is this file's.
      f.resultAtAttach = false;
      return result(s);
    }
    if (f.resultAtAttach) return result(s, "Close Google's earlier import message so Magic can read this file's result.");
    f.imported = page.imported; f.total = page.total;
    if (page.total === f.events && page.imported === page.total) { f.state = "imported"; f.detail = undefined; }
    else { f.state = "unknown"; f.detail = `Google reported ${page.imported} of ${page.total} events; this file has ${f.events}. Check the calendar in Google.`; }
    // A file Google has read is no longer needed on this computer.
    if (f.state === "imported") await rm(f.path, { force: true });
    if (s.files.every(x => x.state === "imported")) await dispose(s);
    return result(s);
  }

  async function createCalendar(s: Session, f: PreparedFile) {
    if (s.stopped) return result(s, CODE_TEXT.stopped);
    const window = owned(s);
    if (!window.ref) return result(s, explain(window.error), window.error);
    const reply = await helper({ action: "press", ...window.ref, label: "Create new calendar" }, 8000);
    if (reply.event !== "pressed") { forget(s, reply.code); return result(s, `${explain(reply.code)} In Google, choose Add calendar → Create new calendar, name it “${f.calendarName}”, then click Create calendar.`, String(reply.code)); }
    const page = await helper({ action: "page", ...window.ref, timeoutMs: 5000 }, 9000);
    if (page.event === "page") s.page = pageOf(page);
    // Creation is the student's click in Google; Magic only reports the form it saw.
    return result(s, s.page === "create" ? `In Google, name the calendar “${f.calendarName}” and click Create calendar. Then choose Attach file.` : `Google's create form wasn't observed. In Google, choose Add calendar → Create new calendar and name it “${f.calendarName}”.`);
  }

  async function stop(s: Session) {
    s.stopped = true;
    // A stopped file keeps what was observed: attached, mid-attach or unconfirmed is not "never attached".
    for (const f of s.files) if (f.state === "waiting" || f.state === "preselected" || f.state === "unknown") {
      f.stoppedFrom = f.attaching ? "attaching" : f.state; f.state = "stopped"; f.detail = undefined;
    }
    const window = owned(s);
    if (window.ref) await helper({ action: "cancel", ...window.ref }, 5000);
    const shown = result(s, CODE_TEXT.stopped);
    await dispose(s);
    return shown;
  }

  async function handle(raw: unknown): Promise<CalendarImportResult> {
    const request = requestSchema.parse(raw) as CalendarImportRequest;
    if (request.action === "status") { await status(); return result(null); }
    if (request.action === "request-access") {
      if (!host.headless) await helper({ action: "request_access" }, 5000);
      await status(); return result(null);
    }
    if (request.action === "stop") return stop(session(request.sessionId));
    if (busy) return result(request.action === "prepare" ? null : sessions.get(request.sessionId) ?? null, CODE_TEXT.busy);
    busy = true;
    try {
      if (request.action === "prepare") return await prepare(request.mode, request.files);
      const s = session(request.sessionId);
      if (!("fileKey" in request)) return await open(s);
      const f = s.files.find(x => x.key === request.fileKey);
      if (!f) throw new Error("That file isn't part of this export.");
      if (request.action === "attach") return await attach(s, f);
      if (request.action === "check") return await check(s, f);
      if (request.action === "create-calendar") return await createCalendar(s, f);
      // Finder is the fallback only after permission or capability blocked the automatic path.
      if (!s.manual) return result(s, "Magic attaches the file for you; Finder is only offered when that is blocked.");
      host.reveal(f.path);
      return result(s);
    } finally { busy = false; }
  }
  /** App quit or sign-out: every prepared file is removed. */
  async function disposeAll() { for (const s of [...sessions.values()]) await dispose(s); }
  return { handle, disposeAll, sweep };
}
