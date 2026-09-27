/**
 * Which dates may appear as time tags in a date-disagreement sentence: only due dates a
 * source actually states for this item. Title-derived and unconfirmed-scope claims are
 * left out, and no claim is promoted to "the" date. Structural types keep the UI package
 * free of contracts; DeadlineEvidenceClaim satisfies this shape.
 */
export interface SourceDateInput {
  value: string;
  kind: 'due' | 'lock' | 'event';
  authority: 'explicit_change' | 'structured' | 'document' | 'title';
  scopeConfirmed: boolean;
  origin?: 'canvas' | 'announcement' | 'assignment_text' | 'syllabus' | 'page' | 'calendar' | 'title';
  precision?: 'minute' | 'day';
}

export interface SourceDate {
  value: string;
  /** "day": the source names a day without a time; show the date only. */
  precision: 'minute' | 'day';
  /** Named sources stating this same date, in first-seen order. Empty when no source origin is known. */
  sources: string[];
}

const SOURCE: Record<NonNullable<SourceDateInput['origin']>, string> = {
  canvas: 'Canvas', announcement: 'an announcement', assignment_text: 'the assignment description',
  syllabus: 'the syllabus', page: 'a course page', calendar: 'the calendar feed', title: 'the title',
};

export function sourceDates(claims: readonly SourceDateInput[]): SourceDate[] {
  const out: SourceDate[] = [];
  for (const c of claims) {
    if (c.kind !== 'due' || !c.scopeConfirmed || c.authority === 'title' || c.origin === 'title') continue;
    const precision = c.precision ?? 'minute';
    const at = Date.parse(c.value);
    if (Number.isNaN(at)) continue;
    const source = c.authority === 'explicit_change' ? 'an announced change' : c.origin ? SOURCE[c.origin] : null;
    const same = out.find(d => d.precision === precision && Date.parse(d.value) === at);
    if (same) { if (source && !same.sources.includes(source)) same.sources.push(source); }
    else out.push({ value: c.value, precision, sources: source ? [source] : [] });
  }
  return out;
}
