import type { ResourceView } from '@magic/contracts';
import { Action } from '../../../../packages/ui/src';
import { Glyph } from './DesktopShell';

const meetings = { teams: 'Microsoft Teams', zoom: 'Zoom', webex: 'Webex', meet: 'Google Meet' } as const;
const DAY = 86_400_000;

/** A calendar DATE has no zone; format it as that day, never as UTC midnight shifted locally. */
const dayOf = (value: string) => {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Saved calendar facts only. Missing fields stay missing; the text body is shown only when captured. */
export function eventPresentation(resource: ResourceView, timeZone?: string) {
  const c = resource.calendar;
  let when: string | null = null;
  if (c?.allDay) {
    const start = dayOf(c.start);
    // ICS DTEND for a DATE is exclusive: a one-day event ends the next day.
    const last = c.end && dayOf(c.end) ? new Date(dayOf(c.end)!.getTime() - DAY) : null;
    const format = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    if (start) when = last && last > start ? `${format.formatRange(start, last)} · all day` : `${format.format(start)} · all day`;
  } else if (c?.start) {
    const start = new Date(c.start), end = c.end ? new Date(c.end) : null;
    const format = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone });
    if (!Number.isNaN(start.getTime())) when = end && !Number.isNaN(end.getTime()) && end > start
      ? format.formatRange(start, end) : `${format.format(start)}${end ? '' : ' · end not provided'}`;
  }
  return {
    when,
    start: c?.start ?? null,
    location: c?.location?.trim() || null,
    meeting: c?.onlineMeeting ? meetings[c.onlineMeeting] : null,
    organizer: c?.organizer?.trim() || null,
    joinUrl: c?.joinUrl ?? null,
    cancelled: /^cancell?ed$/i.test(resource.workflowState ?? ''),
    description: resource.text.trim() || null,
  };
}

export function ResourceEvent({ resource, open }: { resource: ResourceView; open: (url: string) => void }) {
  const view = eventPresentation(resource);
  const facts = [
    view.location && ['Where', view.location],
    view.meeting && ['Meeting', view.meeting],
    view.organizer && ['Organizer', view.organizer],
  ].filter((fact): fact is [string, string] => Boolean(fact));
  return <div className="resource-event">
    {(facts.length > 0 || view.joinUrl) && <section className="detail-section resource-event__facts" aria-label="Event details">
      {facts.length > 0 && <dl className="resource-provenance">{facts.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}</dl>}
      {view.joinUrl && <Action tone="quiet" onClick={() => open(view.joinUrl!)}>Join meeting <Glyph name="external" /></Action>}
    </section>}
    <section className="detail-section" aria-labelledby={`event-details-${resource.id}`}>
      <h3 id={`event-details-${resource.id}`}>Details</h3>
      {view.description ? <p className="source-text">{view.description}</p>
        : <p className="muted small">No description was saved for this event.</p>}
    </section>
  </div>;
}
