// Shared synthetic fixtures for the learning tests (not a test file itself).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ValidateQuote } from "../packages/learning/src/quote-port";
import type { MapResource } from "../packages/learning/src/concepts";

/** A stand-in with T11a's contract: exact and unique, or not; no fuzzy repair. */
export const exactValidate: ValidateQuote = (text, quote) => {
  const start = text.indexOf(quote);
  if (start < 0) return { status: "missing" };
  if (text.indexOf(quote, start + 1) >= 0) return { status: "ambiguous" };
  return { status: "unique", start, end: start + quote.length };
};

const SMOKE = join(import.meta.dirname, "..", "evals", "cases", "smoke");

export function smoke<T>(file: string): T {
  return JSON.parse(readFileSync(join(SMOKE, file), "utf8")) as T;
}

interface SmokeResource {
  externalId: string;
  kind: string;
  title: string;
  text: string;
  dueAt?: string;
  lockAt?: string;
  submitted: boolean | null;
}

/** The smoke course as map resources: id = externalId, contentHash = "h1:" + id. */
export function smokeResources(): (MapResource & { dueAt?: string; lockAt?: string; submitted: boolean | null })[] {
  const course = smoke<{ resources: SmokeResource[] }>("course.json");
  return course.resources.map((r) => ({ ...r, id: r.externalId, contentHash: `h1:${r.externalId}` }));
}

export const COURSE = "synthetic:SYN101";
