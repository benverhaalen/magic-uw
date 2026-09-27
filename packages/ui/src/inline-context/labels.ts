/**
 * Literal presentation labels for inline object names. A display projection only:
 * never an identity, a source edit or a generated summary. The label is always a
 * contiguous slice of the raw title, so the raw title still contains what a person
 * sees (and says, for speech input). No ellipsis: a long title stays whole.
 */
export const PRESENTATION_LABEL_RULE = 'presentation-label.v1';

export interface PresentationLabel {
  label: string;
  raw: string;
  shortened: boolean;
  /** Half-open UTF-16 offsets into raw; raw.slice(start, end) === text. */
  removed: Array<{ kind: 'context-prefix' | 'context-suffix' | 'description-tail'; start: number; end: number; text: string }>;
  rule: typeof PRESENTATION_LABEL_RULE;
}

export interface PresentationContext {
  /**
   * Verified identifiers the surrounding text already shows, e.g. the course code
   * and title from projectCourseLabel. Only exact, case-sensitive matches are removed.
   * Pass nothing when the context is not visible beside the label.
   */
  shownPrefixes?: readonly string[];
  /** Verified exact trailing text already shown elsewhere, e.g. a section/term wrapper. */
  shownSuffixes?: readonly string[];
}

// A numbered stage token names which piece of work this is (Step 1, Part B, P1, HW 3, Week 5...).
const STAGE = /(?:^|[\s(])(?:step|part|phase|milestone|stage|project|assignment|homework|hw|lab|quiz|exam|week|module|unit|chapter|ch|problem set|pset|ps|p)\.? ?(?:\d+[a-z]?|[A-Z])(?=$|[\s),.:-])/iu;
const TAIL_MIN_WORDS = 6;

// Separators observed after a repeated course prefix. Whitespace must be exact.
const SEPARATORS = [': ', ' - ', ' – ', ' | ', ' · '];

/** A remainder must still name something: at least one letter, and not just a separator. */
const meaningful = (text: string) => /\p{L}/u.test(text) && text.trim() === text;

export function presentationLabel(raw: string, context: PresentationContext = {}): PresentationLabel {
  const whole: PresentationLabel = { label: raw, raw, shortened: false, removed: [], rule: PRESENTATION_LABEL_RULE };
  let start = 0, end = raw.length;
  const removed: PresentationLabel['removed'] = [];
  // Longest identifier first so "COMPSCI 574" wins over "COMPSCI".
  for (const prefix of [...(context.shownPrefixes ?? [])].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const separator = SEPARATORS.find(s => raw.startsWith(prefix + s));
    if (!separator) continue;
    start = prefix.length + separator.length;
    removed.push({ kind: 'context-prefix', start: 0, end: start, text: raw.slice(0, start) });
    break;
  }
  for (const suffix of [...(context.shownSuffixes ?? [])].filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (!suffix.startsWith(' ') || !raw.endsWith(suffix) || raw.length - suffix.length <= start) continue;
    end = raw.length - suffix.length;
    removed.push({ kind: 'context-suffix', start: end, end: raw.length, text: raw.slice(end) });
    break;
  }
  // Keep the identity head and drop a long instruction tail: "Cart request - Step 1: Draft the flow and
  // upload three screenshots" -> "Cart request - Step 1". Only when the head has a topic word plus a numbered
  // stage and the tail reads as a sentence, so short topics ("Quiz 3: Graphs") stay.
  const colon = raw.indexOf(': ', start);
  if (colon > start && colon < end) {
    const head = raw.slice(start, colon), tail = raw.slice(colon + 2, end);
    const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
    if (STAGE.test(head) && /\p{L}{3,}/u.test(head.replace(STAGE, ' ')) && words(tail) >= TAIL_MIN_WORDS && !head.includes('(') === !head.includes(')')) {
      removed.push({ kind: 'description-tail', start: colon, end, text: raw.slice(colon, end) });
      end = colon;
    }
  }
  const label = raw.slice(start, end);
  if (!removed.length || !meaningful(label)) return whole;
  return { label, raw, shortened: true, removed, rule: PRESENTATION_LABEL_RULE };
}

/**
 * Labels for items shown together. When shortening would make two different raw
 * titles look identical, those items keep their raw titles instead of guessing
 * a distinguishing word.
 */
export function presentationLabels(raws: readonly string[], context: PresentationContext = {}): PresentationLabel[] {
  const labels = raws.map(raw => presentationLabel(raw, context));
  const sources = new Map<string, Set<string>>();
  for (const l of labels) sources.set(l.label, (sources.get(l.label) ?? new Set()).add(l.raw));
  return labels.map(l => (sources.get(l.label)!.size > 1 && l.shortened ? presentationLabel(l.raw) : l));
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
