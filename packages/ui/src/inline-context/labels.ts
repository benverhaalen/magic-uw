/**
 * Concise presentation labels for inline object names. A display projection only: never an
 * identity, a source edit or a generated summary. The label is the raw title's own text with
 * recognised noise removed: every character shown comes from the raw title, in order, and every
 * removed character is recorded with a reason. Nothing is invented, reworded or ellipsised; a
 * title no rule recognises stays whole.
 */
export const PRESENTATION_LABEL_RULE = 'presentation-label.v2';

export type RemovedKind =
  // Already visible beside the label (verified by the caller's context).
  | 'context-prefix' | 'context-suffix' | 'course-wrapper'
  // Title hints: scheduling/location text inside a title. Hints, not claims: never show them as dates.
  | 'due-hint'
  // How to turn the work in, not what it is.
  | 'instruction-verb' | 'instruction-detail';

export interface LabelSpan { start: number; end: number; text: string }

export interface PresentationLabel {
  label: string;
  raw: string;
  shortened: boolean;
  /** Raw pieces shown, in order. Half-open UTF-16 offsets; label === kept texts joined. */
  kept: LabelSpan[];
  /** kept + removed partition the raw title exactly. */
  removed: Array<LabelSpan & { kind: RemovedKind }>;
  rule: typeof PRESENTATION_LABEL_RULE;
}

export interface PresentationContext {
  /**
   * Verified identifiers the surrounding text already shows, e.g. the course code
   * and title from projectCourseLabel. Only exact, case-sensitive matches are removed,
   * plus a trailing calendar wrapper whose only other tokens are term and section.
   * Pass nothing when the context is not visible beside the label.
   */
  shownPrefixes?: readonly string[];
  /** Verified exact trailing text already shown elsewhere, e.g. a section/term wrapper. */
  shownSuffixes?: readonly string[];
}

// A numbered stage token names which piece of work this is (Step 1, Part B, P1, HW 3, Week 5...).
// Keywords match any case; a letter stage must be a capital ("Part B"), so "parts" or "labs" never count.
const ci = (w: string) => w.replace(/\p{L}/gu, c => `[${c.toLowerCase()}${c.toUpperCase()}]`);
const LETTERED = ['step', 'part', 'phase', 'milestone', 'stage', 'project', 'assignment', 'lab', 'quiz', 'exam', 'unit', 'module', 'week'];
const NUMBERED = [...LETTERED, 'problem set', 'homework', 'chapter', 'class', 'pset', 'hw', 'ch', 'ps', 'p'];
const STAGE_SOURCE = `(?:^|[\\s(])(?:(?:${NUMBERED.map(ci).join('|')})\\.? ?\\d+[a-z]?|(?:${LETTERED.map(ci).join('|')}) [A-Z])(?=$|[\\s),.:-])`;
const STAGE = new RegExp(STAGE_SOURCE, 'u');
const STAGE_ALL = new RegExp(STAGE_SOURCE, 'gu');
// A sub-stage at the end of a task name ("… - Step 1") that later pieces must never lose.
const TAIL_STAGE = /(\s*[-–:|,]\s*|\s+)((?:step|part|phase|milestone|stage) ?\d+[a-z]?)$/iu;
// Only a complete, recognisable title-date suffix can be removed. It remains a title
// hint in provenance, never a verified deadline. Unknown suffix words stay visible.
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const WEEKDAY = '(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\\.?';
const DAY = '(?:[1-9]|[12]\\d|3[01])';
const DATE = `(?:(?:${WEEKDAY},?\\s+)?${MONTH}\\s+${DAY}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|(?:0?[1-9]|1[0-2])/${DAY}(?:/\\d{2,4})?|${WEEKDAY}|today|tonight|tomorrow)`;
const TIME = '(?:[1-9]|1[0-2])(?::[0-5]\\d)?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)';
const DUE_TEXT = `due\\s*:?\\s*(?:(?:by|on)\\s+)?${DATE}(?:\\s+(?:at\\s+)?${TIME})?`;
const DUE_HINT = new RegExp(`(?:\\s*[:\\-–|]\\s*|\\s+)${DUE_TEXT}\\s*$`, 'iu');
const DUE_PAREN = new RegExp(`\\s*\\(${DUE_TEXT}\\)\\s*$`, 'iu');
// "Submit X to Y/…": the verb says how, the clause after X says where. X is the work.
const PREAMBLE_VERB = /^(?:if you have(?: not|n't)(?: done so)?(?: already)?,?\s+)?(?:please\s+)?(?:submit|upload|turn in|hand in)\s+/iu;
const SERIES = /^[^:\s][^:]{0,23}: (?=\S)/u;
// Require an explicit handoff plus upload-link instruction. A generic "on", "to" or
// purpose clause can carry the subject of an assignment and is not safe noise.
const DESTINATION = /\s+(?:to|via|through)\s+\p{Lu}[\p{L}'&.-]*(?:\s+(?:\p{Lu}[\p{L}'&.-]*|and|of|the)){0,5}\/\s*[Uu][Pp][Ll][Oo][Aa][Dd]\s+(?:[Cc][Aa][Rr][Tt]\s+)?(?:[Uu][Rr][Ll]|[Ll][Ii][Nn][Kk])\s*$/u;

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
/** Removed text must not carry an identifier: no stage token and no number. */
const noIdentity = (text: string) => !STAGE.test(text) && !/\d/.test(text);

type Level = 'full' | 'context' | 'whole';

function whole(raw: string): PresentationLabel {
  return { label: raw, raw, shortened: false, kept: [{ start: 0, end: raw.length, text: raw }], removed: [], rule: PRESENTATION_LABEL_RULE };
}

function project(raw: string, context: PresentationContext, level: Level): PresentationLabel {
  if (level === 'whole') return whole(raw);
  let start = 0, end = raw.length;
  const removed: PresentationLabel['removed'] = [];
  const cut = (kind: RemovedKind, from: number, to: number) => removed.push({ kind, start: from, end: to, text: raw.slice(from, to) });
  const prefixes = [...(context.shownPrefixes ?? [])].filter(Boolean).sort((a, b) => b.length - a.length);
  // Longest identifier first so "COMPSCI 574" wins over "COMPSCI".
  for (const prefix of prefixes) {
    const separator = SEPARATORS.find(s => raw.startsWith(prefix + s));
    if (!separator) continue;
    start = prefix.length + separator.length;
    cut('context-prefix', 0, start);
    break;
  }
  for (const suffix of [...(context.shownSuffixes ?? [])].filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (!suffix.startsWith(' ') || !raw.endsWith(suffix) || raw.length - suffix.length <= start) continue;
    end = raw.length - suffix.length;
    cut('context-suffix', end, raw.length);
    break;
  }
  // Calendar copies end in "[FA26 ART 201 001]": removable only when, minus term and section, it is the shown course.
  const wrapper = end === raw.length ? /\s+\[([^\[\]]+)\]$/u.exec(raw) : null;
  if (wrapper && wrapper.index > start) {
    const tokens = wrapper[1]!.split(/\s+/);
    if (/^(?:FA|SP|SU|WI)\d{2}$/u.test(tokens[0]!)) tokens.shift();
    if (tokens.length > 2 && /^\d{3}$/u.test(tokens.at(-1)!)) tokens.pop();
    const course = tokens.join('');
    if (course && prefixes.some(p => compact(p) === compact(course))) { end = wrapper.index; cut('course-wrapper', end, raw.length); }
  }
  if (level === 'full') {
    const text = raw.slice(start, end);
    for (const pattern of [DUE_PAREN, DUE_HINT]) {
      const m = pattern.exec(text);
      if (!m || m.index === 0 || STAGE.test(m[0])) continue;
      if (!/\p{L}{2,}/u.test(text.slice(0, m.index))) continue;
      cut('due-hint', start + m.index, end);
      end = start + m.index;
      break;
    }
    // Keep a trailing sub-stage; reduce only the task wording before it.
    const stage = TAIL_STAGE.exec(raw.slice(start, end));
    const topicEnd = stage ? start + stage.index : end;
    const topic = raw.slice(start, topicEnd);
    const series = PREAMBLE_VERB.test(topic) ? null : SERIES.exec(topic);
    const verbAt = series ? series[0].length : 0;
    const verb = PREAMBLE_VERB.exec(topic.slice(verbAt));
    if (verb) {
      const objectAt = verbAt + verb[0].length;
      const tail = DESTINATION.exec(topic.slice(objectAt));
      const object = tail ? topic.slice(objectAt, objectAt + tail.index) : '';
      const detail = tail ? topic.slice(objectAt + tail.index) : '';
      if (tail && words(object) >= 2 && /\p{L}{3,}/u.test(object) && noIdentity(verb[0]) && noIdentity(detail)) {
        cut('instruction-verb', start + verbAt, start + objectAt);
        cut('instruction-detail', start + objectAt + tail.index, topicEnd);
      }
    }
  }
  if (!removed.length) return whole(raw);
  removed.sort((a, b) => a.start - b.start);
  const kept: LabelSpan[] = [];
  let at = 0;
  for (const r of removed) { if (r.start > at) kept.push({ start: at, end: r.start, text: raw.slice(at, r.start) }); at = r.end; }
  if (at < raw.length) kept.push({ start: at, end: raw.length, text: raw.slice(at) });
  const label = kept.map(k => k.text).join('');
  // A remainder must still name something and keep every stage/number outside shown context and hints.
  if (!/\p{L}/u.test(label) || label.trim() !== label || /\s{2}/u.test(label) || losesStage(removed, raw))
    return level === 'full' ? project(raw, context, 'context') : whole(raw);
  return { label, raw, shortened: true, kept, removed, rule: PRESENTATION_LABEL_RULE };
}

const compact = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
/** True when a removal other than shown context would take away a stage token. */
function losesStage(removed: PresentationLabel['removed'], raw: string) {
  const shown = new Set<RemovedKind>(['context-prefix', 'context-suffix', 'course-wrapper']);
  return [...raw.matchAll(STAGE_ALL)].some(m => {
    const from = m.index! + (/^[\s(]/u.test(m[0]) ? 1 : 0), to = m.index! + m[0].length;
    return removed.some(r => !shown.has(r.kind) && r.start < to && from < r.end);
  });
}

// Separators observed after a repeated course prefix. Whitespace must be exact.
const SEPARATORS = [': ', ' - ', ' – ', ' | ', ' · '];

export function presentationLabel(raw: string, context: PresentationContext = {}): PresentationLabel {
  return project(raw, context, 'full');
}

/**
 * Labels for items shown together. Distinct raw titles that would read the same step
 * back to context-only cleanup, then to the actual whole raw title. Even a title with
 * a calendar wrapper is not assumed to name the same resource. Exact identical titles
 * stay identical: the consumer must supply visible course/source context where needed.
 * Never use these strings as route, resource or state identity.
 */
export function presentationLabels(raws: readonly string[], context: PresentationContext | readonly PresentationContext[] = {}): PresentationLabel[] {
  const ctx = (i: number): PresentationContext => (Array.isArray(context) ? (context as readonly PresentationContext[])[i] ?? {} : context as PresentationContext);
  const levels: Level[] = raws.map(() => 'full');
  const labels = raws.map((raw, i) => project(raw, ctx(i), 'full'));
  // At most two monotonic fallback steps per item. Recalculate after every pass since
  // a fallback can collide with a previously distinct label.
  for (let changed = true; changed;) {
    changed = false;
    const owners = new Map<string, Set<string>>();
    labels.forEach((l, i) => owners.set(l.label, (owners.get(l.label) ?? new Set()).add(raws[i]!)));
    const collisions = labels.map(l => owners.get(l.label)!.size > 1);
    labels.forEach((l, i) => {
      if (!collisions[i] || !l.shortened) return;
      levels[i] = levels[i] === 'full' ? 'context' : 'whole';
      labels[i] = project(raws[i]!, ctx(i), levels[i]!);
      changed = true;
    });
  }
  return labels;
}

/** Structural subset of the work-set item contract; the UI package stays contract-free. */
export interface DestinationItem {
  role: 'instructions' | 'material';
  target: { kind: 'web' | 'file' };
}

export interface DestinationAction {
  /** Verb + actual destination. Null when nothing verified would open. */
  label: string | null;
  /** True only when more than one verified destination opens together. */
  multiple: boolean;
}

/**
 * Name the command after what actually opens. One assignment page is "Open assignment";
 * "Start work" is reserved for a verified set of two or more destinations.
 */
export function destinationAction(items: readonly DestinationItem[]): DestinationAction {
  if (!items.length) return { label: null, multiple: false };
  if (items.length > 1) return { label: 'Start work', multiple: true };
  const [only] = items as [DestinationItem];
  if (only.role === 'instructions') return { label: 'Open assignment', multiple: false };
  return { label: only.target.kind === 'file' ? 'Open document' : 'Open course page', multiple: false };
}
