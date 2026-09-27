import ical, { type VEvent } from "node-ical";
import {
  captureBatchSchema,
  resourceInputSchema,
  type CaptureBatch,
  type Connector,
  type ResourceInput,
} from "@magic/contracts";
import { contentHash } from "./external.ts";
import { MaterialReadError, publicUrl, type PublicClient } from "./network.ts";

/**
 * Bounds for RRULE/RDATE expansion. Every limit that omits an occurrence emits a
 * diagnostic, so the batch is partial and storage never reads an omission as a removal.
 */
export interface RecurrenceLimits {
  /** A series is expanded from its first occurrence through now + horizonDays. */
  horizonDays: number;
  /** A larger series keeps the occurrences nearest now and is flagged. */
  maxOccurrencesPerSeries: number;
  /** How far before now a capped series is searched. */
  cappedLookbackDays: number;
}
export const DEFAULT_RECURRENCE_LIMITS: Readonly<RecurrenceLimits> = {
  horizonDays: 184,
  maxOccurrencesPerSeries: 250,
  cappedLookbackDays: 92,
};

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
  recurrence?: Partial<RecurrenceLimits>;
}
type Diagnostics = NonNullable<CaptureBatch["diagnostics"]>;
type ParseOptions = Omit<CalendarConnectorOptions, "client" | "feedUrl">;
type ZonedDate = Date & { tz?: string; dateOnly?: true };
/** captureBatchSchema accepts at most this many resources in one batch. */
const MAX_BATCH_RESOURCES = 2000;
const DAY_MS = 86_400_000;

function value(input: unknown): string {
  return typeof input === "string"
    ? input
    : input && typeof input === "object" && "val" in input
      ? String(input.val)
      : "";
}
/** node-ical represents DATE values as local midnight, so the calendar day comes from local fields. */
function dayKey(input: Date): string {
  return `${input.getFullYear()}-${String(input.getMonth() + 1).padStart(2, "0")}-${String(input.getDate()).padStart(2, "0")}`;
}
function date(input: Date | undefined, allDay = false): string | undefined {
  return input && Number.isFinite(input.getTime())
    ? allDay
      ? dayKey(input)
      : input.toISOString()
    : undefined;
}

const WEEKDAY = /^(MO|TU|WE|TH|FR|SA|SU)$/;
const BYDAY_ITEM = /^([+-]?)(\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/;
const POSITIVE = /^[1-9]\d{0,3}$/;
function numberList(input: string, max: number, signed: boolean): boolean {
  return input
    .split(",")
    .every((item) => {
      const match = item.match(signed ? /^([+-]?)(\d{1,2})$/ : /^()(\d{1,2})$/);
      const n = Number(match?.[2]);
      return Boolean(match) && n >= 1 && n <= max;
    });
}
/**
 * RRULE parts covered by tests against RFC 5545 semantics. Anything else is returned by
 * name so the caller reports it instead of guessing occurrences.
 */
export function unsupportedRecurrenceParts(
  rules: string[],
  hasExrule = false,
): string[] {
  const issues = new Set<string>();
  if (hasExrule) issues.add("EXRULE");
  if (rules.length > 1) issues.add("RRULE_MULTIPLE");
  for (const rule of rules) {
    const parts = new Map<string, string>();
    for (const segment of rule.split(";")) {
      if (!segment.trim()) continue;
      const eq = segment.indexOf("=");
      const key = (eq < 0 ? segment : segment.slice(0, eq)).trim().toUpperCase();
      if (parts.has(key)) issues.add(`${key.slice(0, 80)}_REPEATED`);
      parts.set(key, eq < 0 ? "" : segment.slice(eq + 1).trim().toUpperCase());
    }
    const freq = parts.get("FREQ") ?? "";
    if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq))
      issues.add(`FREQ=${freq || "MISSING"}`.slice(0, 100));
    for (const [key, part] of parts) {
      switch (key) {
        case "FREQ":
          break;
        case "INTERVAL":
        case "COUNT":
          if (!POSITIVE.test(part)) issues.add(`${key}_INVALID`);
          break;
        case "UNTIL":
          if (!/^\d{8}(T\d{6}Z?)?$/.test(part)) issues.add("UNTIL_INVALID");
          break;
        case "WKST":
          if (!WEEKDAY.test(part)) issues.add("WKST_INVALID");
          break;
        case "BYMONTH":
          if (!numberList(part, 12, false)) issues.add("BYMONTH_INVALID");
          break;
        case "BYMONTHDAY":
          if (!numberList(part, 31, true)) issues.add("BYMONTHDAY_INVALID");
          // RFC 5545: BYMONTHDAY MUST NOT be used with WEEKLY.
          if (freq === "WEEKLY") issues.add("BYMONTHDAY_WITH_WEEKLY");
          break;
        case "BYDAY":
          for (const item of part.split(",")) {
            const match = item.match(BYDAY_ITEM);
            if (!match) {
              issues.add("BYDAY_INVALID");
              continue;
            }
            if (match[2] === undefined) continue;
            const ordinal = Number(match[2]);
            // RFC 5545: numeric BYDAY is only meaningful for MONTHLY and YEARLY.
            if (freq !== "MONTHLY" && freq !== "YEARLY")
              issues.add("BYDAY_ORDINAL_WITH_" + (freq || "MISSING"));
            else if (ordinal < 1 || ordinal > (freq === "MONTHLY" ? 5 : 53))
              issues.add("BYDAY_ORDINAL_INVALID");
          }
          break;
        default:
          issues.add(key.replace(/[^A-Z0-9_-]/g, "").slice(0, 100) || "RRULE_PART_INVALID");
      }
    }
    if (parts.has("COUNT") && parts.has("UNTIL")) issues.add("COUNT_WITH_UNTIL");
  }
  return [...issues].sort();
}

/** Wall-clock time in an IANA zone to an instant (two-pass offset resolution). */
function zonedInstant(stamp: string, zone: string): Date {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const offsetAt = (ms: number) => {
    const p = Object.fromEntries(
      formatter.formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
    );
    return (
      Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - ms
    );
  };
  const wall = Date.UTC(
    +stamp.slice(0, 4),
    +stamp.slice(4, 6) - 1,
    +stamp.slice(6, 8),
    +stamp.slice(9, 11),
    +stamp.slice(11, 13),
    +stamp.slice(13, 15),
  );
  const first = wall - offsetAt(wall);
  return new Date(wall - offsetAt(first));
}
interface RawSeries {
  rules: string[];
  exrule: boolean;
  rdates: { params: Map<string, string>; values: string[] }[];
}
function readRaw(raw: string): RawSeries {
  return {
    rules: [...raw.matchAll(/^RRULE(?:;[^:\r\n]*)?:(.*)$/gm)].map((m) => m[1]!.trim()),
    exrule: /^EXRULE[;:]/m.test(raw),
    rdates: [...raw.matchAll(/^RDATE((?:;[^:\r\n]*)?):(.*)$/gm)].map((m) => ({
      params: new Map(
        m[1]!
          .split(";")
          .filter(Boolean)
          .map((p) => {
            const eq = p.indexOf("=");
            return [p.slice(0, eq).toUpperCase(), p.slice(eq + 1).replace(/"/g, "")];
          }),
      ),
      values: m[2]!.trim().split(",").filter(Boolean),
    })),
  };
}
/** node-ical does not read RDATE; exact values are resolved here or reported. */
function readRdates(
  lines: RawSeries["rdates"],
  allDay: boolean,
): { dates: ZonedDate[]; issues: string[] } {
  const dates: ZonedDate[] = [];
  const issues = new Set<string>();
  for (const { params, values } of lines) {
    if (params.get("VALUE") === "PERIOD") {
      issues.add("RDATE_PERIOD");
      continue;
    }
    const zone = params.get("TZID");
    for (const raw of values) {
      const stamp = raw.trim();
      if (/^\d{8}$/.test(stamp)) {
        if (!allDay) issues.add("RDATE_VALUE_MISMATCH");
        else {
          const day: ZonedDate = new Date(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8));
          day.dateOnly = true;
          dates.push(day);
        }
      } else if (/^\d{8}T\d{6}Z?$/.test(stamp)) {
        if (allDay) issues.add("RDATE_VALUE_MISMATCH");
        else if (stamp.endsWith("Z"))
          dates.push(new Date(zonedInstant(stamp, "UTC")));
        else if (!zone) issues.add("RDATE_FLOATING_TIME");
        else {
          try {
            new Intl.DateTimeFormat("en", { timeZone: zone });
            const at: ZonedDate = zonedInstant(stamp, zone);
            at.tz = zone;
            dates.push(at);
          } catch {
            issues.add("RDATE_TIMEZONE_UNRESOLVED");
          }
        }
      } else issues.add("RDATE_INVALID");
    }
  }
  return { dates: dates.filter((d) => Number.isFinite(d.getTime())), issues: [...issues] };
}

interface Occurrence {
  /** Original start of the occurrence: stable identity across moves and edits. */
  key: string;
  start: ZonedDate;
  end: Date | null;
  source: VEvent;
  origin: "rrule" | "rdate" | "override";
}
function uniqueOverrides(event: VEvent): VEvent[] {
  return [...new Set(Object.values(event.recurrences ?? {}))] as VEvent[];
}
/** Expand one supported series between its first occurrence and the horizon. */
function expandSeries(
  event: VEvent,
  rdates: ZonedDate[],
  now: Date,
  limits: RecurrenceLimits,
): { occurrences: Occurrence[]; capped: boolean } {
  const allDay = event.datetype === "date";
  const keyOf = (d: Date) => (allDay ? dayKey(d) : d.toISOString());
  const horizon = new Date(now.getTime() + limits.horizonDays * DAY_MS);
  const max = limits.maxOccurrencesPerSeries;
  // Count before expanding so an unbounded rule never generates more than max + 1 dates.
  let generated = rdates.filter((d) => d <= horizon).length;
  if (event.rrule)
    event.rrule.all((d) => {
      if (d > horizon || generated > max) return false;
      generated++;
      return true;
    });
  const capped = generated > max;
  const overrides = uniqueOverrides(event);
  const from = capped
    ? new Date(now.getTime() - limits.cappedLookbackDays * DAY_MS)
    : new Date(
        Math.min(
          event.start.getTime(),
          ...rdates.map((d) => d.getTime()),
          ...overrides.map((o) => o.start?.getTime() ?? Infinity),
        ),
      );
  const inWindow = (d: Date) => d >= from && d <= horizon;
  const excluded = (key: string) =>
    Boolean(event.exdate) &&
    (allDay
      ? Object.values(event.exdate!).some((d) => dayKey(d) === key)
      : Object.hasOwn(event.exdate!, key));
  const baseSpan =
    event.end && Number.isFinite(event.end.getTime())
      ? event.end.getTime() - event.start.getTime()
      : undefined;
  const endFor = (start: Date, source: VEvent): Date | null => {
    if (source.end && source !== event) return source.end;
    if (baseSpan === undefined) return null;
    if (!allDay) return new Date(start.getTime() + baseSpan);
    const days = Math.max(1, Math.round(baseSpan / DAY_MS));
    return new Date(start.getFullYear(), start.getMonth(), start.getDate() + days);
  };
  const byKey = new Map<string, Occurrence>();
  const addOverride = (override: VEvent, key: string) => {
    if (!override.start) return;
    byKey.set(key, {
      key,
      start: override.start,
      end: endFor(override.start, override),
      source: override,
      origin: "override",
    });
  };
  for (const instance of ical.expandRecurringEvent(event, { from, to: horizon })) {
    const key = instance.isOverride
      ? keyOf(instance.event.recurrenceid!)
      : keyOf(instance.start);
    if (byKey.has(key)) continue;
    const override = event.recurrences?.[key];
    if (override) addOverride(override as VEvent, key);
    else if (!excluded(key))
      byKey.set(key, {
        key,
        start: instance.start,
        end: endFor(instance.start, event),
        source: event,
        origin: "rrule",
      });
  }
  // An override keeps its original identity even when moved outside the window.
  for (const override of overrides) {
    const original = override.recurrenceid;
    if (!original || !inWindow(original)) continue;
    const key = keyOf(original);
    if (!byKey.has(key)) addOverride(override, key);
  }
  for (const rdate of rdates) {
    const key = keyOf(rdate);
    if (!inWindow(rdate) || byKey.has(key) || excluded(key)) continue;
    const start: ZonedDate = new Date(rdate.getTime());
    if (rdate.dateOnly) start.dateOnly = true;
    const zone = rdate.tz ?? event.start.tz;
    if (zone && !allDay) start.tz = zone;
    byKey.set(key, { key, start, end: endFor(start, event), source: event, origin: "rdate" });
  }
  let occurrences = [...byKey.values()];
  if (capped) occurrences = nearest(occurrences, now, max);
  return {
    occurrences: occurrences.sort((a, b) => a.start.getTime() - b.start.getTime()),
    capped,
  };
}
function nearest(items: Occurrence[], now: Date, keep: number): Occurrence[] {
  return [...items]
    .sort(
      (a, b) =>
        Math.abs(a.start.getTime() - now.getTime()) -
        Math.abs(b.start.getTime() - now.getTime()),
    )
    .slice(0, Math.max(0, keep));
}

/** RFC parser is invoked on a string only; its fromURL helper is intentionally never used. */
export async function parseCalendar(
  text: string,
  options: ParseOptions,
): Promise<{
  resources: ResourceInput[];
  diagnostics: Diagnostics;
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
  const diagnostics: Diagnostics = [];
  const noted = new Set<string>();
  const note = (code: string, path: string[] = []) => {
    const key = `${code}\u0000${path.join("\u0000")}`;
    if (noted.has(key)) return;
    noted.add(key);
    diagnostics.push({ code, path: path.slice(0, 20), severity: "warning" });
  };
  const limits: RecurrenceLimits = { ...DEFAULT_RECURRENCE_LIMITS, ...options.recurrence };
  const now = (options.now ?? (() => new Date()))();
  const rawEvents = [
    ...unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g),
  ].map((match) => match[1]!);
  const badTimeUids = new Set<string>();
  const baseRaw = new Map<string, RawSeries>();
  const overrideUids = new Set<string>();
  let baseCount = 0;
  for (const raw of rawEvents) {
    const uid = raw.match(/^UID:(.*)$/m)?.[1]?.trim();
    const start = raw.match(/^DTSTART([^:]*):(.*)$/m);
    if (uid && /^RECURRENCE-ID[;:]/m.test(raw)) overrideUids.add(uid);
    else {
      baseCount++;
      if (uid) baseRaw.set(uid, readRaw(raw));
    }
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
  // node-ical folds RECURRENCE-ID components into their series; only orphans stand alone.
  const orphanOverrides = [...overrideUids].filter((uid) => !baseRaw.has(uid)).length;
  if (events.length !== baseCount + orphanOverrides)
    diagnostics.push({
      code: "event_count_mismatch",
      path: [],
      severity: "warning",
    });
  const build = (
    source: VEvent,
    series: VEvent,
    start: string,
    end: string | null,
    allDay: boolean,
    timezone: string | undefined,
    quote: string,
    recurrenceId?: string,
  ): ResourceInput => {
    const rawUrl = value(source.url) || value(series.url);
    let url = `${options.canvasOrigin}/courses/${encodeURIComponent(options.courseId)}`;
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
    const cancelled = source.status === "CANCELLED";
    const modified = source.lastmodified ?? series.lastmodified;
    return resourceInputSchema.parse({
      externalId: `calendar:${contentHash(
        recurrenceId === undefined ? series.uid : `${series.uid}\u0000${recurrenceId}`,
      )}`,
      kind: "event",
      courseId: options.courseId,
      courseName: options.courseName,
      title: value(source.summary) || value(series.summary) || "Calendar event",
      url,
      text: "",
      updatedAt: date(modified),
      workflowState: source.status,
      calendar: {
        uid: series.uid,
        start,
        end,
        allDay,
        ...(timezone ? { timezone } : {}),
        lastModified: date(modified) ?? null,
        ...(exact ? { assignmentExternalId: exact } : {}),
        ...(recurrenceId !== undefined ? { recurrenceId } : {}),
      },
      // DATE has no time or zone. Keep the date, without manufacturing a midnight deadline.
      deadlines:
        allDay || cancelled
          ? []
          : [
              {
                value: start,
                kind: exact ? "due" : "event",
                quote,
                authority: "structured",
                scopeConfirmed: Boolean(exact),
              },
            ],
    });
  };
  const single = (event: VEvent) => {
    const allDay = event.datetype === "date";
    const start = date(event.start, allDay)!;
    resources.push(
      build(
        event,
        event,
        start,
        date(event.end, allDay) ?? null,
        allDay,
        (event.start as ZonedDate).tz,
        `Calendar DTSTART: ${start}`,
      ),
    );
  };
  const series: { event: VEvent; rdates: ZonedDate[] }[] = [];
  for (const event of events) {
    try {
      if (badTimeUids.has(event.uid))
        throw new MaterialReadError("calendar_timezone_unresolved");
      const allDay = event.datetype === "date";
      const start = date(event.start, allDay);
      if (!event.uid || !start)
        throw new MaterialReadError("calendar_event_invalid");
      const raw = baseRaw.get(event.uid) ?? { rules: [], exrule: false, rdates: [] };
      if (!raw.rules.length && !raw.rdates.length && !event.rrule && !raw.exrule) {
        // RECURRENCE-ID without RRULE/RDATE cannot be placed in a series.
        if (event.recurrences) note("recurrence_override_without_series");
        single(event);
        continue;
      }
      const rdates = readRdates(raw.rdates, allDay);
      const issues = [
        ...unsupportedRecurrenceParts(raw.rules, raw.exrule),
        ...rdates.issues,
        ...(raw.rules.length && !event.rrule ? ["RRULE_UNPARSED"] : []),
      ];
      if (issues.length) {
        // Keep the series' first occurrence as evidence, flagged; never guess the rest.
        note("recurrence_rule_unsupported", issues);
        single(event);
        continue;
      }
      series.push({ event, rdates: rdates.dates });
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
  // Standalone events are placed first so occurrences can never crowd them out of the batch.
  for (const { event, rdates } of series) {
    const allDay = event.datetype === "date";
    if (resources.length >= MAX_BATCH_RESOURCES) {
      note("recurrence_occurrence_cap", ["batch"]);
      continue;
    }
    let expanded: ReturnType<typeof expandSeries>;
    try {
      expanded = expandSeries(event, rdates, now, limits);
    } catch {
      note("recurrence_expansion_failed");
      if (resources.length < MAX_BATCH_RESOURCES) single(event);
      continue;
    }
    let { occurrences } = expanded;
    if (expanded.capped) note("recurrence_occurrence_cap", ["series"]);
    const room = MAX_BATCH_RESOURCES - resources.length;
    if (occurrences.length > room) {
      note("recurrence_occurrence_cap", ["batch"]);
      occurrences = nearest(occurrences, now, room).sort(
        (a, b) => a.start.getTime() - b.start.getTime(),
      );
    }
    for (const occurrence of occurrences) {
      try {
        const start = date(occurrence.start, allDay)!;
        const label =
          occurrence.origin === "override"
            ? `Calendar RECURRENCE-ID ${occurrence.key} DTSTART`
            : occurrence.origin === "rdate"
              ? "Calendar RDATE"
              : "Calendar RRULE occurrence";
        resources.push(
          build(
            occurrence.source,
            event,
            start,
            (occurrence.end && date(occurrence.end, allDay)) ?? null,
            allDay,
            allDay ? undefined : (occurrence.start.tz ?? (event.start as ZonedDate).tz),
            `${label}: ${start}`,
            occurrence.key,
          ),
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
