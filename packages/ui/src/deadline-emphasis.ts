/** How close a deadline is, as local calendar days. Pure; no clock or timezone lookup.
 * `today` and `due` are civil dates ('YYYY-MM-DD') already resolved in the caller's account/device
 * zone (for example `localTime(iso, timeZone).date` from @magic/domain, as `projectWork` does).
 * Counting whole civil days keeps DST and UTC-offset changes out of the bins.
 */
export type DeadlineBin = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'unknown' | 'completed';
/** Hue names in wheel order. Values come from the palette role seam in deadline-emphasis.css. */
export const IDENTITY_HUES = ['rose', 'coral', 'orange', 'yellow', 'lime', 'green', 'mint', 'teal', 'sky', 'blue', 'indigo', 'purple', 'magenta'] as const;
export type IdentityHue = typeof IDENTITY_HUES[number];
export interface DeadlineEmphasis {
  bin: DeadlineBin;
  /** Calendar days from today to due; negative when overdue; null when unknown. */
  days: number | null;
  /** Short relative word for the few bins that have one. The caller still renders the raw date. */
  label: string | null;
}

function civilDay(value: string | null | undefined): number | null {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(y, m - 1, d), check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return ms / 86_400_000;
}

/** Whole calendar days from `from` to `to`, or null if either is not a real 'YYYY-MM-DD' date. */
export function calendarDayDistance(from: string, to: string | null): number | null {
  const a = civilDay(from), b = civilDay(to);
  return a === null || b === null ? null : b - a;
}

/** `completed` counts only when it is literally true: completion known from evidence or the
 * student's own report. Unknown completion falls through to the date bins; an unknown date is
 * `unknown`, never distant and never completed.
 */
export function deadlineEmphasis({ today, due, completed }:
  { today: string; due: string | null; completed?: boolean }): DeadlineEmphasis {
  const days = calendarDayDistance(today, due);
  if (completed === true) return { bin: 'completed', days, label: null };
  if (days === null) return { bin: 'unknown', days, label: 'Due date not found' };
  if (days < 0) return { bin: 'overdue', days, label: 'Overdue' };
  if (days === 0) return { bin: 'today', days, label: 'Today' };
  if (days === 1) return { bin: 'tomorrow', days, label: 'Tomorrow' };
  return { bin: days < 7 ? 'week' : 'later', days, label: null };
}

/** The structured fields the mapper reads; a ResourceView satisfies it. */
export interface GroupedResource {
  sourceId: string;
  courseId: string;
  externalId: string;
  assignmentGroupId?: string | null;
  assignmentGroup?: { position?: number } | null;
  title: string;
}
export interface AssignmentTypeHue { hue: IdentityHue; groupId: string; groupName: string }
/** Account scope per source: the snapshot's SourceHealth list, or a resolver. Null/undefined means the
 * account is actually unknown for that source.
 */
export type SourceAccounts =
  | readonly { id: string; accountScope?: string | null }[]
  | ((sourceId: string) => string | null | undefined);

function accountResolver(accounts: SourceAccounts | undefined) {
  if (typeof accounts === 'function') return accounts;
  const scope = new Map((accounts ?? []).map(s => [s.id, s.accountScope]));
  return (sourceId: string) => scope.get(sourceId);
}

function fnv1a(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash;
}
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Hue per verified assignment group, distinct within a course and identical on every surface.
 * Scope: account (accountScope from `accounts`) + courseId; sources aliasing one account share it.
 * A source whose account is unknown is keyed by its own sourceId and never joins another scope.
 * Verified: a group resource in the same scope and course whose externalId equals the assignment's
 * assignmentGroupId and that carries Canvas's structured `assignmentGroup` (the buildCoursePage
 * match). Anything else returns null and renders neutral; titles are never read for typing.
 * Duplicate captures of one group (aliases) merge; its canonical position is the minimum reported.
 * Groups rank by (position, externalId); rank steps a coprime stride from a per-course offset, so up
 * to IDENTITY_HUES.length groups never share a hue and neighbours sit far apart on the wheel.
 * Pass the full snapshot resources and sources on every surface; a filtered subset can change ranks.
 */
export function createAssignmentTypeHues(resources: readonly GroupedResource[], accounts?: SourceAccounts) {
  // Stride 5 of 13: any course with up to five groups keeps at least one hue between every pair on the
  // wheel (observed real maximum: 13 groups, which still never collide).
  const n = IDENTITY_HUES.length, stride = [5, 4, 3, 2, 1].find(s => gcd(s, n) === 1)!;
  const account = accountResolver(accounts);
  const scopeOf = (sourceId: string) => { const a = account(sourceId); return a ? `account:${a}` : `source:${sourceId}`; };
  const byCourse = new Map<string, Map<string, { position: number; names: string[] }>>();
  for (const r of resources) {
    if (!r.assignmentGroup) continue;
    const course = `${scopeOf(r.sourceId)}\u0000${r.courseId}`;
    const groups = byCourse.get(course) ?? new Map<string, { position: number; names: string[] }>();
    const group = groups.get(r.externalId) ?? { position: Infinity, names: [] };
    group.position = Math.min(group.position, r.assignmentGroup.position ?? Infinity);
    group.names.push(r.title);
    groups.set(r.externalId, group); byCourse.set(course, groups);
  }
  const index = new Map<string, AssignmentTypeHue>();
  for (const [course, groups] of byCourse) {
    const ranked = [...groups].sort(([a, x], [b, y]) => x.position - y.position || byText(a, b));
    const offset = fnv1a(course) % n;
    ranked.forEach(([groupId, g], rank) => index.set(`${course}\u0000${groupId}`,
      { hue: IDENTITY_HUES[(offset + rank * stride) % n], groupId, groupName: [...g.names].sort(byText)[0] }));
  }
  return (resource: Pick<GroupedResource, 'sourceId' | 'courseId' | 'assignmentGroupId'>): AssignmentTypeHue | null =>
    resource.assignmentGroupId
      ? index.get(`${scopeOf(resource.sourceId)}\u0000${resource.courseId}\u0000${resource.assignmentGroupId}`) ?? null
      : null;
}

/** Attributes for the surface that carries the fill (row, chip or card); spread beside the caller's
 * own className. Null hue (no verified type) renders neutral. Proximity only changes intensity.
 * Styles: deadline-emphasis.css.
 */
export function deadlineSurface(bin: DeadlineBin, hue: IdentityHue | null) {
  return { 'data-magic-deadline': bin, 'data-magic-hue': hue ?? 'neutral' } as const;
}
