// owner: calendar-import. A one-time Google Calendar snapshot of three typed school families.
// Family comes from source metadata only: Course Search & Enroll meeting kinds, Canvas
// submission types, quiz scopes and module item types. Titles, categories and AI kind
// labels never decide a family, a date or an identity.
import { OUTLOOK_CALENDAR_COURSE_ID, type PlanningSnapshot, type StoredPlanningRecord } from '@magic/contracts';
import { scheduleAssignmentId } from '../schedule-projection';
import { addDays, canonicalCalendarResources, localTime, type CalendarResource } from './model';

export type ExportFamily = 'lectures' | 'assignments' | 'exams';
export type ExportMode = 'combined' | 'split';
export const EXPORT_FAMILIES: ExportFamily[] = ['lectures', 'assignments', 'exams'];
export const FAMILY_NAMES: Record<ExportFamily, string> = { lectures: 'Lectures', assignments: 'Assignments', exams: 'Exams & quizzes' };
export const COMBINED_NAME = 'UW classes and coursework';
const CHICAGO = 'America/Chicago';
const MAX_BYTES = 1_000_000;

export interface GoogleExportChoice {
  from: string; through: string;
  /** The Canvas account the student chose; enrollment must be linked to it. */
  canvasScope: string;
  timeZone: string; now: string;
  courseLabel: (resource: CalendarResource) => string;
}
export interface ExportRow { uid: string; family: ExportFamily; title: string; start: string; end: string | null; allDay: boolean; description: string; location?: string }
export interface ExportOmissions {
  /** No single confirmed due date, or an unresolved date mention. */
  dateReview: number; conflict: number;
  /** A calendar-feed or module record whose Canvas type was not captured. */
  typeUnknown: number;
  /** A wall-clock time that is skipped or repeated by a daylight-saving change. */
  clockChange: number;
  /** Enrollment records that are stale, incomplete, unlinked to this account, or ambiguous. */
  scheduleUnverified: number;
  cancelled: number;
}
export interface GoogleExportPreview { rows: ExportRow[]; counts: Record<ExportFamily, number>; omitted: ExportOmissions; scheduleNote: string | null }
export interface ExportFile { family: ExportFamily | 'combined'; calendarName: string; events: number; ics: string }

const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (value: string) => dateOnly.test(value) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const weekday = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7 + 1;
const DAY = 86400_000, FRESH = 7 * DAY;

/** Links and capability URLs never enter a file the student uploads elsewhere. */
const redact = (value: string) => value.replace(/\b(?:https?|webcal):\/\/\S+/gi, '(link omitted)');

/** Canvas family from provider metadata; null when the source did not say. */
export function canvasFamily(resource: CalendarResource): ExportFamily | null {
  const scope = resource.sourceScope?.split(':')[0];
  const types = resource.submissionTypes ?? [];
  if (scope === 'quizzes' || scheduleAssignmentId(resource)?.startsWith('quiz:')) return 'exams';
  if (resource.kind === 'assignment') return types.length && types.every(type => type === 'online_quiz') ? 'exams' : 'assignments';
  if (scope === 'module-items' && resource.moduleItem?.type === 'Assignment') return 'assignments';
  return null;
}

/**
 * Wall time in a zone to an instant, or null when it is skipped or occurs twice.
 * A repeated fall-back hour is held for review, never silently assigned to one offset.
 */
export function uniqueWallInstant(day: string, minute: number, timeZone: string): string | null {
  const desired = `${day} ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const base = Date.parse(`${day}T00:00:00Z`) + minute * 60000;
  const matches: number[] = [];
  for (let offset = -18 * 60; offset <= 18 * 60; offset += 15) {
    const candidate = base - offset * 60000;
    const local = localTime(new Date(candidate).toISOString(), timeZone);
    if (`${local.date} ${String(Math.floor(local.min / 60)).padStart(2, '0')}:${String(local.min % 60).padStart(2, '0')}` === desired) matches.push(candidate);
  }
  return matches.length === 1 ? new Date(matches[0]!).toISOString() : null;
}

type Enrollment = Extract<StoredPlanningRecord, { kind: 'enrollment_package' }>;
type AccountLink = Extract<StoredPlanningRecord, { kind: 'account_link' }>;
/** Current enrolled packages of the one private account linked to the chosen Canvas account. */
function verifiedEnrollment(planning: PlanningSnapshot | undefined, canvasScope: string, now: number): { rows: Enrollment[]; unverified: number; note: string | null } {
  const records = planning?.records ?? [];
  const enrolled = records.filter((row): row is Enrollment => !row.deleted && row.kind === 'enrollment_package' && row.enrollmentState === 'enrolled' && row.accountScope !== 'public');
  if (!enrolled.length) return { rows: [], unverified: 0, note: 'No current enrollment schedule has been captured, so no lectures are included.' };
  const scopes = new Set(enrolled.map(row => row.accountScope));
  if (scopes.size !== 1) return { rows: [], unverified: enrolled.length, note: 'More than one school account has a saved schedule, so lectures and exams from it are left out.' };
  const scope = [...scopes][0]!;
  const links = records.filter((row): row is AccountLink => !row.deleted && row.kind === 'account_link' && row.accountScope === scope && now - Date.parse(row.provenance.observedAt) <= FRESH);
  if (links.length !== 1 || links[0]!.canvasAccountScope !== canvasScope)
    return { rows: [], unverified: enrolled.length, note: 'Your saved class schedule is not confirmed to belong to this Canvas account, so lectures and exams from it are left out.' };
  const rows: Enrollment[] = [];
  let unverified = 0;
  for (const row of enrolled) {
    const source = planning?.sources.find(item => item.id === row.sourceId);
    const current = row.status !== 'cancelled' && row.meetingsComplete && row.provenance.scope.kind === 'enrollment_term' && row.provenance.scope.key === row.termCode &&
      source?.scope.kind === 'enrollment_term' && source.scope.key === row.termCode && source.accountScope === scope && source.status === 'complete' && source.completeness === 'complete' &&
      now - Date.parse(row.provenance.observedAt) <= FRESH;
    if (current) rows.push(row); else unverified++;
  }
  return { rows, unverified, note: unverified ? 'Some saved class schedules are stale or incomplete; refresh My UW to include them.' : null };
}

/** Builds the reviewed rows. Exact identities and dates are never inferred from titles. */
export function previewGoogleExport(resources: CalendarResource[], planning: PlanningSnapshot | undefined, choice: GoogleExportChoice): GoogleExportPreview {
  if (!validDate(choice.from) || !validDate(choice.through) || choice.from > choice.through || addDays(choice.from, 366) < choice.through) throw new Error('Choose a date range of one year or less.');
  if (!choice.canvasScope) throw new Error('Choose a school account.');
  const now = Date.parse(choice.now);
  const rows: ExportRow[] = [];
  const omitted: ExportOmissions = { dateReview: 0, conflict: 0, typeUnknown: 0, clockChange: 0, scheduleUnverified: 0, cancelled: 0 };
  const inRange = (day: string) => day >= choice.from && day <= choice.through;
  const scoped = resources.filter(r => r.accountScope === choice.canvasScope && r.courseId !== OUTLOOK_CALENDAR_COURSE_ID);
  omitted.cancelled = scoped.filter(r => !r.deleted && r.workflowState?.toUpperCase() === 'CANCELLED').length;
  for (const resource of canonicalCalendarResources(scoped)) {
    if (resource.deleted || resource.workflowState?.toUpperCase() === 'CANCELLED') continue;
    if (resource.kind !== 'assignment' && !resource.scheduleDeadline) continue;   // other Canvas events are not one of the three families
    // The source's own resolved date; a personal planning choice is not exported as the due date.
    // A day-only due date resolves without dueAt; it is accepted only when every matching confirmed claim is day-only.
    const deadline = resource.deadline;
    const at = deadline.dueAt ?? deadline.planningAt;
    const shown = at ?? deadline.preferredAt;
    if (shown && !inRange(localTime(shown, choice.timeZone).date)) continue;
    if (deadline.conflict) { omitted.conflict++; continue; }
    const matching = at ? deadline.claims.filter(claim => claim.kind === 'due' && claim.scopeConfirmed && Date.parse(claim.value) === Date.parse(at)) : [];
    const dayPrecision = matching.length > 0 && matching.every(claim => claim.precision === 'day');
    if (!at || (!deadline.dueAt && !dayPrecision) || deadline.unresolved?.some(item => item.kind === 'due')) { omitted.dateReview++; continue; }
    const due = at;
    const family = canvasFamily(resource);
    if (!family) { omitted.typeUnknown++; continue; }
    const course = redact(choice.courseLabel(resource).trim() || resource.courseName);
    const title = redact(resource.title.trim());
    const identity = resource.scheduleDeadline?.family ?? `resource:${resource.id}`;
    const day = dayPrecision ? localTime(due, CHICAGO).date : null;
    rows.push({ uid: uid(family, identity), family, title: `${course} · ${title}`, allDay: dayPrecision,
      start: day ?? due, end: day ? addDays(day, 1) : null,
      description: `${family === 'exams' ? 'Canvas quiz' : 'Canvas assignment'} · due ${dayPrecision ? 'on this date; time not provided' : 'at this time'}\n${course}${resource.submitted ? '\nSubmitted when this snapshot was made.' : ''}\nOne-time copy from My Magic UW; later changes do not sync.` });
  }
  const enrollment = verifiedEnrollment(planning, choice.canvasScope, now);
  omitted.scheduleUnverified += enrollment.unverified;
  const subjects = new Map((planning?.records ?? []).filter((row): row is Extract<StoredPlanningRecord, { kind: 'subject' }> => row.kind === 'subject' && !row.deleted).map(row => [row.code, row.shortName]));
  for (const row of enrollment.rows) {
    const [, subject, number] = row.courseKey.split(':');
    const label = `${subjects.get(subject ?? '') ?? subject ?? 'Course'} ${number ?? ''}`.trim();
    const lectureOnly = row.sections.length > 0 && row.sections.every(section => /^LEC\b/.test(section));
    for (const [index, meeting] of row.meetings.entries()) {
      if (meeting.mode !== 'scheduled' || meeting.startMinute === null || meeting.endMinute === null || !meeting.startDate || !meeting.endDate || meeting.timezone !== CHICAGO) continue;
      const family: ExportFamily = meeting.kind === 'exam' ? 'exams' : 'lectures';
      for (let day = meeting.startDate > choice.from ? meeting.startDate : choice.from; day <= meeting.endDate && day <= choice.through; day = addDays(day, 1)) {
        if (meeting.days.length ? !meeting.days.includes(weekday(day)) : day !== meeting.startDate || meeting.startDate !== meeting.endDate) continue;
        const start = uniqueWallInstant(day, meeting.startMinute, CHICAGO);
        const end = meeting.endMinute === 1440 ? uniqueWallInstant(addDays(day, 1), 0, CHICAGO) : uniqueWallInstant(day, meeting.endMinute, CHICAGO);
        if (!start || !end || end <= start) { omitted.clockChange++; continue; }
        const location = meeting.location?.trim() ? redact(meeting.location.trim()) : undefined;
        rows.push({ uid: uid(family, JSON.stringify([row.accountScope, row.localId, index, day])), family,
          title: `${label} ${family === 'exams' ? 'exam' : lectureOnly ? 'lecture' : 'class meeting'}`, start, end, allDay: false, location,
          description: `${redact(row.sections.join(', '))} · Course Search & Enroll\nOne-time copy from My Magic UW; later changes do not sync.` });
      }
    }
  }
  rows.sort((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid));
  const counts = { lectures: 0, assignments: 0, exams: 0 };
  for (const row of rows) counts[row.family]++;
  return { rows, counts, omitted, scheduleNote: enrollment.note };
}

/** One combined file, or one file per non-empty family; each file is checked against Google's 1 MB limit. */
export function exportFiles(preview: GoogleExportPreview, mode: ExportMode, generatedAt: string): ExportFile[] {
  const files: ExportFile[] = mode === 'combined'
    ? [{ family: 'combined', calendarName: COMBINED_NAME, events: preview.rows.length, ics: serializeIcs(preview.rows, COMBINED_NAME, generatedAt) }]
    : EXPORT_FAMILIES.flatMap(family => {
      const rows = preview.rows.filter(row => row.family === family);
      return rows.length ? [{ family, calendarName: FAMILY_NAMES[family], events: rows.length, ics: serializeIcs(rows, FAMILY_NAMES[family], generatedAt) }] : [];
    });
  for (const file of files) if (new TextEncoder().encode(file.ics).length > MAX_BYTES) throw new Error('This file is too large for Google Calendar. Choose a shorter date range.');
  return files.filter(file => file.events > 0);
}

const escapeText = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\n', '\\n').replaceAll(',', '\\,').replaceAll(';', '\\;');
const stamp = (value: string) => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function fold(line: string): string {
  const encoder = new TextEncoder();
  let result = '', column = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (column + bytes > 75) { result += '\r\n '; column = 1; }
    result += char; column += bytes;
  }
  return result;
}
/** RFC 5545: UTC timed events, exclusive all-day DTEND, CRLF and 75-octet folding. */
export function serializeIcs(rows: ExportRow[], calendarName: string, generatedAt: string): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//My Magic UW//Calendar export v1//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(calendarName)}`];
  for (const row of rows) {
    lines.push('BEGIN:VEVENT', `UID:${row.uid}`, `DTSTAMP:${stamp(generatedAt)}`,
      row.allDay ? `DTSTART;VALUE=DATE:${row.start.replaceAll('-', '')}` : `DTSTART:${stamp(row.start)}`);
    // A timed deadline is an instant: no invented duration.
    if (row.end) lines.push(row.allDay ? `DTEND;VALUE=DATE:${row.end.replaceAll('-', '')}` : `DTEND:${stamp(row.end)}`);
    lines.push(`SUMMARY:${escapeText(row.title)}`, `DESCRIPTION:${escapeText(row.description)}`, `TRANSP:${row.end && !row.allDay ? 'OPAQUE' : 'TRANSPARENT'}`);
    if (row.location) lines.push(`LOCATION:${escapeText(row.location)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Stable across runs and modes; account and source identifiers are hashed, not written. */
function uid(family: ExportFamily, identity: string): string {
  return `${sha256(JSON.stringify(['magic-calendar-export.v1', family, identity])).slice(0, 40)}@my-magic-uw`;
}
const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
/** Synchronous SHA-256 (FIPS 180-4) for the renderer, where node:crypto is unavailable. */
export function sha256(text: string): string {
  const data = new TextEncoder().encode(text);
  const length = ((data.length + 9 + 63) >> 6) << 6;
  const bytes = new Uint8Array(length); bytes.set(data); bytes[data.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(length - 4, data.length * 8); view.setUint32(length - 8, Math.floor(data.length / 0x20000000));
  const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3), s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh! + (rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0;
      hh = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0]! += a!; h[1]! += b!; h[2]! += c!; h[3]! += d!; h[4]! += e!; h[5]! += f!; h[6]! += g!; h[7]! += hh!;
  }
  return [...h].map(x => x.toString(16).padStart(8, '0')).join('');
}
