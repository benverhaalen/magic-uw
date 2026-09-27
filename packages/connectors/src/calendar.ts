import ical, { type VEvent } from "node-ical";
import {
  captureBatchSchema,
  resourceInputSchema,
  type CaptureBatch,
  type Connector,
  type ResourceInput,
  OUTLOOK_CALENDAR_COURSE_ID,
} from "@magic/contracts";
import { contentHash } from "./external.ts";
import { MaterialReadError, publicUrl, type PublicClient } from "./network.ts";

export interface CalendarConnectorOptions {
  /** Capability from the encrypted vault. Never placed in a record, diagnostic, or source id. */
  feedUrl: string;
  canvasOrigin: string;
  accountScope: string;
  courseId: string;
  courseName: string;
  client: PublicClient;
  assignmentUrls?: Map<string, string>;
  now?: () => Date;
  /** Evidence link when an event has none. Defaults to the Canvas course page. */
  defaultUrl?: string;
  /**
   * Expand repeating events into one event per meeting. Only the Outlook feed does this.
   * Canvas feeds keep one event per series and an incomplete read, so they never delete events.
   */
  expandRecurrence?: boolean;
}
function value(input: unknown): string {
  return typeof input === "string"
    ? input
    : input && typeof input === "object" && "val" in input
      ? String(input.val)
      : "";
}
function date(input: Date | undefined, allDay = false): string | undefined {
  return input && Number.isFinite(input.getTime())
    ? allDay
      ? input.toISOString().slice(0, 10)
      : input.toISOString()
    : undefined;
}
/** RFC parser is invoked on a string only; its fromURL helper is intentionally never used. */
export async function parseCalendar(
  text: string,
  options: Omit<CalendarConnectorOptions, "client" | "feedUrl">,
): Promise<{
  resources: ResourceInput[];
  diagnostics: NonNullable<CaptureBatch["diagnostics"]>;
}> {
  if (
    !/^\s*BEGIN:VCALENDAR\r?\n/i.test(text) ||
    !/END:VCALENDAR\s*$/i.test(text)
  )
    throw new MaterialReadError("invalid_calendar");
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const count = (unfolded.match(/^BEGIN:VEVENT\s*$/gm) ?? []).length;
  if (count > 2000) throw new MaterialReadError("event_limit");
  const parsed = await ical.async.parseICS(text);
  const resources: ResourceInput[] = [];
  const diagnostics: NonNullable<CaptureBatch["diagnostics"]> = [];
  const rawEvents = [
    ...unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g),
  ].map((match) => match[1]!);
  const badTimeUids = new Set<string>();
  // Outlook names zones the Windows way ("Central Standard Time") and defines them in a
  // VTIMEZONE block, which the parser uses. Only undefined, unknown zones are unresolved.
  const definedZones = new Set(
    [...unfolded.matchAll(/BEGIN:VTIMEZONE\r?\n[\s\S]*?^TZID:([^\r\n]+)[\s\S]*?END:VTIMEZONE/gm)].map((m) => m[1]!.trim()),
  );
  for (const raw of rawEvents) {
    const uid = raw.match(/^UID:(.*)$/m)?.[1]?.trim();
    const start = raw.match(/^DTSTART([^:]*):(.*)$/m);
    if (!uid || !start) continue;
    if (
      !/VALUE=DATE(?:;|$)/i.test(start[1]!) &&
      !start[2]!.trim().endsWith("Z")
    ) {
      const zone = start[1]!.match(/TZID="?([^;"]+)/)?.[1];
      try {
        if (!zone) throw new Error();
        if (!definedZones.has(zone)) new Intl.DateTimeFormat("en", { timeZone: zone });
      } catch {
        badTimeUids.add(uid);
      }
    }
  }
  const events = Object.values(parsed).filter(
    (item): item is VEvent => item?.type === "VEVENT",
  );
  const movedMeetings = rawEvents.filter((raw) => /^RECURRENCE-ID[;:]/m.test(raw)).length;
  if (events.length !== count - movedMeetings)
    diagnostics.push({
      code: "event_count_mismatch",
      path: [],
      severity: "warning",
    });
  const nowMs = (options.now?.() ?? new Date()).getTime();
  // Repeating classes are expanded for the near term only; the rail and week views read this window.
  const windowStart = new Date(nowMs - RECURRENCE_PAST_MS);
  const windowEnd = new Date(nowMs + RECURRENCE_AHEAD_MS);
  const build = (
    source: VEvent,
    startDate: Date,
    endDate: Date | undefined,
    allDay: boolean,
    recurrenceId?: string,
  ) => {
    const start = date(startDate, allDay);
    if (!source.uid || !start) throw new MaterialReadError("calendar_event_invalid");
    const rawUrl = value(source.url);
    let url =
      options.defaultUrl ??
      `${options.canvasOrigin}/courses/${encodeURIComponent(options.courseId)}`;
    if (rawUrl) url = publicUrl(rawUrl).href;
    const parsedUrl = new URL(url);
    const assignmentPath = parsedUrl.pathname.match(
      /^\/courses\/([^/]+)\/assignments\/(\d+)\/?$/,
    );
    const exact =
      options.assignmentUrls?.get(url) ??
      (parsedUrl.origin === options.canvasOrigin &&
      assignmentPath?.[1] === options.courseId
        ? assignmentPath[2]
        : undefined);
    const timezone = (startDate as Date & { tz?: string }).tz;
    const location = value(source.location).trim().slice(0, 500);
    // Teams meetings are labeled in location or title; a published calendar omits the join link.
    const teams = /microsoft teams/i.test(`${location} ${value(source.summary)}`);
    const cancelled = source.status === "CANCELLED";
    resources.push(
      resourceInputSchema.parse({
        externalId: recurrenceId
          ? `calendar:${contentHash(`${source.uid}:${recurrenceId}`)}`
          : `calendar:${contentHash(source.uid)}`,
        kind: "event",
        courseId: options.courseId,
        courseName: options.courseName,
        title: value(source.summary) || "Calendar event",
        url,
        text: "",
        updatedAt: date(source.lastmodified),
        workflowState: source.status,
        calendar: {
          uid: source.uid,
          start,
          end: date(endDate, allDay) ?? null,
          allDay,
          ...(timezone ? { timezone } : {}),
          lastModified: date(source.lastmodified) ?? null,
          ...(exact ? { assignmentExternalId: exact } : {}),
          ...(recurrenceId ? { recurrenceId } : {}),
          ...(location ? { location } : {}),
          ...(teams ? { onlineMeeting: "teams" as const } : {}),
        },
        // DATE has no time or zone. Keep the date, without manufacturing a midnight deadline.
        deadlines:
          allDay || cancelled
            ? []
            : [
                {
                  value: start,
                  kind: exact ? "due" : "event",
                  quote: `Calendar DTSTART: ${start}`,
                  authority: "structured",
                  scopeConfirmed: Boolean(exact),
                },
              ],
      }),
    );
  };
  for (const event of events) {
    try {
      if (badTimeUids.has(event.uid))
        throw new MaterialReadError("calendar_timezone_unresolved");
      const allDay = event.datetype === "date";
      if (!event.uid || !date(event.start, allDay))
        throw new MaterialReadError("calendar_event_invalid");
      if (!options.expandRecurrence || !event.rrule) {
        if (!options.expandRecurrence && (event.rrule || event.recurrences))
          diagnostics.push({ code: "recurrence_not_expanded", path: [], severity: "warning" });
        build(event, event.start, event.end, allDay);
        continue;
      }
      // One event per meeting. The library returns canceled dates too, and moved
      // meetings arrive separately keyed by their original time; apply both here.
      const durationMs =
        event.end && event.start ? event.end.getTime() - event.start.getTime() : 0;
      const exdates = new Set(Object.keys(event.exdate ?? {}));
      const room = Math.max(0, MAX_EXPANDED_TOTAL - resources.length);
      if (!room) {
        // The feed-wide cap is full: skip the date computation entirely and record the gap.
        diagnostics.push({ code: "recurrence_truncated", path: [], severity: "warning" });
        continue;
      }
      const occurrences = event.rrule.between(windowStart, windowEnd, true);
      const limit = Math.min(MAX_OCCURRENCES, room);
      if (occurrences.length > limit)
        diagnostics.push({ code: "recurrence_truncated", path: [], severity: "warning" });
      for (const occurrence of occurrences.slice(0, limit)) {
        // The parser keys all-day exceptions by calendar date (occurrences are local midnight)
        // and timed ones by instant.
        const key = allDay
          ? `${occurrence.getFullYear()}-${String(occurrence.getMonth() + 1).padStart(2, "0")}-${String(occurrence.getDate()).padStart(2, "0")}`
          : occurrence.toISOString();
        if (exdates.has(key)) continue;
        const moved = event.recurrences?.[key] as VEvent | undefined;
        if (moved) {
          if (moved.status === "CANCELLED") continue;
          build({ ...event, ...moved, uid: event.uid } as VEvent, moved.start, moved.end, allDay, key);
        } else {
          const at = Object.assign(new Date(occurrence), {
            tz: (event.start as Date & { tz?: string }).tz,
          });
          build(event, at, durationMs ? new Date(occurrence.getTime() + durationMs) : undefined, allDay, key);
        }
      }
    } catch (error) {
      diagnostics.push({
        code:
          error instanceof MaterialReadError
            ? error.code
            : "calendar_event_invalid",
        path: [],
        severity: "warning",
      });
    }
  }
  return { resources, diagnostics };
}
export function calendarConnector(
  options: CalendarConnectorOptions,
): Connector {
  const source: CaptureBatch["source"] = {
    id: `calendar:${contentHash(`${options.accountScope}:${options.courseId}`).slice(0, 24)}`,
    label: `${options.courseName} calendar feed`,
    kind: "calendar",
    accountScope: options.accountScope,
    courseId: options.courseId,
    scope: "calendar_feed",
  };
  return {
    id: source.id,
    async *pull(signal) {
      const observedAt = (options.now ?? (() => new Date()))().toISOString();
      const started = Date.now();
      try {
        const text = await options.client.feed(
          options.feedUrl,
          options.canvasOrigin,
          signal,
        );
        const { resources, diagnostics } = await parseCalendar(text, options);
        yield captureBatchSchema.parse({
          source,
          observedAt,
          resources,
          diagnostics,
          complete: !diagnostics.length,
          status: diagnostics.length ? "partial" : "ok",
          stats: {
            durationMs: Date.now() - started,
            records: resources.length,
            bytes: Buffer.byteLength(text),
          },
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        yield captureBatchSchema.parse({
          source,
          observedAt,
          resources: [],
          complete: false,
          status:
            error instanceof MaterialReadError && error.code === "inaccessible"
              ? "inaccessible"
              : "error",
          diagnostics: [
            {
              code:
                error instanceof MaterialReadError
                  ? error.code
                  : "calendar_parse_failed",
              path: [],
              severity: "error",
            },
          ],
        });
      }
    },
  };
}

const RECURRENCE_PAST_MS = 86400000;
const RECURRENCE_AHEAD_MS = 21 * 86400000;
const MAX_OCCURRENCES = 400;
// Feed-wide bound on expanded meetings, so a huge feed cannot produce hundreds of thousands of records.
const MAX_EXPANDED_TOTAL = 3000;
export const OUTLOOK_CALENDAR_URL = "https://outlook.office.com/calendar/view/day";
/** The student's own published Outlook calendar: meetings and appointments, not coursework. */
export function outlookCalendarConnector(options: {
  feedUrl: string;
  accountScope: string;
  client: PublicClient;
  now?: () => Date;
}): Connector {
  const source: CaptureBatch["source"] = {
    id: `calendar:outlook:${contentHash(options.accountScope).slice(0, 16)}`,
    label: "Outlook calendar",
    kind: "calendar",
    accountScope: options.accountScope,
    courseId: OUTLOOK_CALENDAR_COURSE_ID,
    scope: "outlook_calendar",
  };
  return {
    id: source.id,
    async *pull(signal) {
      const observedAt = (options.now ?? (() => new Date()))().toISOString();
      const started = Date.now();
      try {
        if (!options.client.outlookFeed) throw new MaterialReadError("invalid_feed");
        const text = await options.client.outlookFeed(options.feedUrl, signal);
        const { resources, diagnostics } = await parseCalendar(text, {
          // Outlook links never reach Canvas; no assignment matching applies.
          canvasOrigin: "https://outlook.office.com",
          accountScope: options.accountScope,
          courseId: OUTLOOK_CALENDAR_COURSE_ID,
          courseName: "Outlook calendar",
          defaultUrl: OUTLOOK_CALENDAR_URL,
          expandRecurrence: true,
          now: options.now,
        });
        yield captureBatchSchema.parse({
          source,
          observedAt,
          resources,
          diagnostics,
          complete: !diagnostics.length,
          status: diagnostics.length ? "partial" : "ok",
          stats: { durationMs: Date.now() - started, records: resources.length, bytes: Buffer.byteLength(text) },
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        yield captureBatchSchema.parse({
          source,
          observedAt,
          resources: [],
          complete: false,
          status: "error",
          diagnostics: [
            { code: error instanceof MaterialReadError ? error.code : "outlook_calendar_unavailable", path: [], severity: "error" },
          ],
        });
      }
    },
  };
}
