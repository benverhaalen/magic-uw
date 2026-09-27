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
        new Intl.DateTimeFormat("en", { timeZone: zone });
      } catch {
        badTimeUids.add(uid);
      }
    }
  }
  const events = Object.values(parsed).filter(
    (item): item is VEvent => item?.type === "VEVENT",
  );
  if (events.length !== count)
    diagnostics.push({
      code: "event_count_mismatch",
      path: [],
      severity: "warning",
    });
  for (const event of events) {
    try {
      if (badTimeUids.has(event.uid))
        throw new MaterialReadError("calendar_timezone_unresolved");
      const allDay = event.datetype === "date";
      const start = date(event.start, allDay);
      if (!event.uid || !start)
        throw new MaterialReadError("calendar_event_invalid");
      if (event.rrule || event.recurrences)
        diagnostics.push({
          code: "recurrence_not_expanded",
          path: [],
          severity: "warning",
        });
      const rawUrl = value(event.url);
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
      const timezone = (event.start as Date & { tz?: string }).tz;
      const location = value(event.location).trim().slice(0, 500);
      // Teams meetings are labeled in location or title; a published calendar omits the join link.
      const teams = /microsoft teams/i.test(`${location} ${value(event.summary)}`);
      const cancelled = event.status === "CANCELLED";
      resources.push(
        resourceInputSchema.parse({
          externalId: `calendar:${contentHash(event.uid)}`,
          kind: "event",
          courseId: options.courseId,
          courseName: options.courseName,
          title: value(event.summary) || "Calendar event",
          url,
          text: "",
          updatedAt: date(event.lastmodified),
          workflowState: event.status,
          calendar: {
            uid: event.uid,
            start,
            end: date(event.end, allDay) ?? null,
            allDay,
            ...(timezone ? { timezone } : {}),
            lastModified: date(event.lastmodified) ?? null,
            ...(exact ? { assignmentExternalId: exact } : {}),
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
