import { captureBatchSchema, type CaptureBatch } from "@magic/contracts";

const DAY_MS = 86400000;
const INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function localDate(at: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * Moves the synthetic sample forward by whole days so its first day is the
 * student's local today. Wall-clock times are kept (except across a DST change,
 * where they can move by an hour). Quoted source times move with their values.
 * The batch stays labeled as a fixture; this never touches real captures.
 */
export function rebaseFixture(
  batch: CaptureBatch,
  now: Date,
  timeZone: string,
): CaptureBatch {
  const days = Math.round(
    (Date.parse(localDate(now, timeZone)) -
      Date.parse(localDate(new Date(batch.observedAt), timeZone))) /
      DAY_MS,
  );
  if (!days) return batch;
  const shiftInstant = (iso: string) =>
    new Date(Date.parse(iso) + days * DAY_MS).toISOString();
  const shiftDate = (date: string) =>
    new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
  const walk = (value: unknown): unknown => {
    if (typeof value === "string")
      return DATE_ONLY.test(value)
        ? shiftDate(value)
        : value.replace(INSTANT, shiftInstant);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, walk(v)]),
      );
    return value;
  };
  return captureBatchSchema.parse(walk(batch));
}
