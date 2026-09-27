import type { DeadlineEvidenceClaim } from '@magic/contracts';

export interface DateChoiceOption {
  key: string;
  value: string;
  precision: 'minute' | 'day';
  dateLabel: string;
  timeLabel: string;
  sources: Array<{ label: string; resourceId?: string; quote: string }>;
}
export interface CanonicalDateOption {
  id: string;
  value: string;
  precision: 'minute' | 'day';
  claims: DeadlineEvidenceClaim[];
}
/** The core decides eligibility and IDs; the renderer only labels its actual options. */
export function presentDateChoices(options: readonly CanonicalDateOption[], timeZone: string, locale='en-US'): DateChoiceOption[] {
  return options.map(option => {
    const sources = option.claims.map(claim => ({label:claim.origin ? originLabels[claim.origin] : 'Saved source', resourceId:claim.span?.resourceId, quote:claim.quote}));
    return {key:option.id,value:option.value,precision:option.precision,...labels(option.value,option.precision,timeZone,locale),sources};
  });
}
const originLabels = {
  canvas: 'Canvas', announcement: 'Announcement', assignment_text: 'Assignment description',
  syllabus: 'Syllabus', page: 'Course page', calendar: 'Calendar feed', title: 'Title',
};
function labels(value:string,precision:'minute'|'day',timeZone:string,locale:string) {
  const zone=precision==='day'?'America/Chicago':timeZone;
  return {
    dateLabel:new Intl.DateTimeFormat(locale,{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:zone}).format(new Date(value)),
    timeLabel:precision==='day'?'Time not stated':new Intl.DateTimeFormat(locale,{hour:'numeric',minute:'2-digit',timeZoneName:'short',timeZone:zone}).format(new Date(value)),
  };
}
/** Date-only evidence is anchored to the academic timezone by the extractor. Never
 * render its synthetic midnight in the viewer timezone or describe it as a known time. */
export function dateChoiceOptions(claims: readonly DeadlineEvidenceClaim[], timeZone: string, locale = 'en-US'): DateChoiceOption[] {
  const options = new Map<string, DateChoiceOption>();
  for (const claim of claims) {
    if (claim.kind !== 'due' || !claim.scopeConfirmed || claim.authority === 'title' || claim.origin === 'title') continue;
    const epoch = Date.parse(claim.value);
    if (!Number.isFinite(epoch)) continue;
    const precision = claim.precision ?? 'minute';
    const value = new Date(epoch).toISOString();
    const key = `${precision}:${value}`;
    let option = options.get(key);
    if (!option) {
      option = {key, value, precision,
        ...labels(value,precision,timeZone,locale),
        sources:[],
      };
      options.set(key, option);
    }
    const source = {label:claim.origin ? originLabels[claim.origin] : 'Saved source', resourceId:claim.span?.resourceId, quote:claim.quote};
    if (!option.sources.some(item => item.label === source.label && item.resourceId === source.resourceId && item.quote === source.quote)) option.sources.push(source);
  }
  return [...options.values()].sort((a,b) => Date.parse(a.value)-Date.parse(b.value) || a.key.localeCompare(b.key));
}
