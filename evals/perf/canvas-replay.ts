/**
 * Canvas sync through a replay transport. Responses are recorded once from the synthetic
 * university (packages/connectors/src/canvas-fixture.ts) and then served from the recording
 * through the connector's `fetch` seam (CanvasConnectorOptions.fetch), the same seam the
 * desktop worker fills with `host.canvasFetch`. No network access; no real course data.
 */
import { canvasConnector, type CanvasConnectorOptions } from "../../packages/connectors/src/canvas";
import type { CanvasFetch } from "../../packages/connectors/src/canvas-http";
import {
  createSyntheticCanvasUniversity,
  type SyntheticUniversityOptions,
} from "../../packages/connectors/src/canvas-fixture";
import type { CaptureBatch, Store } from "@magic/contracts";

export interface RecordedResponse {
  url: string;
  status: number;
  headers: Array<[string, string]>;
  body: string;
}
export interface Recording {
  origin: string;
  source: string;
  entries: RecordedResponse[];
}

const ACCOUNT = "account";
/** Attribute a request to a course id, or to account-level reads (profile, catalog, todo). */
export function courseOf(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname.match(/\/courses\/(\d+)/);
  if (path) return path[1]!;
  const context = parsed.searchParams.get("context_codes[]")?.match(/^course_(\d+)$/);
  return context ? context[1]! : ACCOUNT;
}

function headerPairs(headers: Headers): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  headers.forEach((value, name) => pairs.push([name, value]));
  return pairs;
}

export const syncNow = () => new Date("2026-09-26T15:00:00Z");

/** Records one full synthetic sync; the fixture's injected 429 is disabled so timings are transport-only. */
export async function recordSyntheticCanvas(
  shape: SyntheticUniversityOptions = {},
  connector: Partial<CanvasConnectorOptions> = {},
): Promise<Recording> {
  const university = createSyntheticCanvasUniversity({ ...shape, rateLimit: false });
  const entries: RecordedResponse[] = [];
  const fetch: CanvasFetch = async (url, init) => {
    const response = await university.fetch(url, init);
    const body = await response.text();
    entries.push({ url, status: response.status, headers: headerPairs(response.headers), body });
    return new Response(body, { status: response.status, headers: response.headers });
  };
  for await (const _ of canvasConnector({ fetch, origin: university.origin, now: syncNow, ...connector }).pull()) {
    // Drain: the recording is the side effect.
  }
  return {
    origin: university.origin,
    source: `createSyntheticCanvasUniversity(${JSON.stringify({ ...shape, rateLimit: false })}), revision 1`,
    entries,
  };
}

export interface CourseTraffic {
  requests: number;
  bytes: number;
  firstMs: number;
  lastMs: number;
}
export interface ReplayTransport {
  fetch: CanvasFetch;
  requests(): number;
  bytes(): number;
  misses(): number;
  byCourse(): Map<string, CourseTraffic>;
  /** Most requests that were in flight at once. */
  maxInFlight(): number;
}
export interface ReplayOptions {
  /**
   * A latency model: every response is held this long (ms) before it is returned, like a
   * network round trip plus Canvas's own processing. Without it the replay answers at once
   * and cannot show what concurrency buys.
   */
  latencyMs?: number;
}

/** Query parameters derived from the clock (announcement windows end at `now`); ignored when matching. */
const CLOCK_PARAMS = ["end_date"];
export function replayKey(url: string): string {
  const parsed = new URL(url);
  for (const name of CLOCK_PARAMS) parsed.searchParams.delete(name);
  return parsed.href;
}

/** Serves recorded responses by URL (repeat requests cycle through that URL's recordings). */
export function replayTransport(recording: Recording, options: ReplayOptions = {}): ReplayTransport {
  const byUrl = new Map<string, RecordedResponse[]>();
  for (const entry of recording.entries) {
    const key = replayKey(entry.url);
    const list = byUrl.get(key) ?? [];
    list.push(entry);
    byUrl.set(key, list);
  }
  const served = new Map<string, number>();
  const courses = new Map<string, CourseTraffic>();
  const start = performance.now();
  let requests = 0,
    bytes = 0,
    misses = 0,
    inFlight = 0,
    maxInFlight = 0;
  const fetch: CanvasFetch = async (url, init) => {
    requests++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (options.latencyMs)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.latencyMs);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(init.signal!.reason);
          }, { once: true });
        });
      return serve(url);
    } finally {
      inFlight--;
    }
  };
  const serve = (url: string): Response => {
    const course = courseOf(url);
    const traffic =
      courses.get(course) ??
      { requests: 0, bytes: 0, firstMs: performance.now() - start, lastMs: 0 };
    courses.set(course, traffic);
    traffic.requests++;
    const key = replayKey(url);
    const list = byUrl.get(key);
    let response: Response;
    if (!list) {
      misses++;
      response = new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    } else {
      const index = served.get(key) ?? 0;
      served.set(key, index + 1);
      const entry = list[index % list.length]!;
      const size = Buffer.byteLength(entry.body);
      bytes += size;
      traffic.bytes += size;
      response = new Response(entry.body, { status: entry.status, headers: entry.headers });
    }
    traffic.lastMs = performance.now() - start;
    return response;
  };
  return {
    fetch,
    requests: () => requests,
    bytes: () => bytes,
    misses: () => misses,
    byCourse: () => courses,
    maxInFlight: () => maxInFlight,
  };
}

/** The desktop `save()` rule (apps/desktop/src/ingestion.ts): never ingest an observation older than the stored one. */
export function save(store: Store, batch: CaptureBatch) {
  const previous = store.sources().find((s) => s.id === batch.source.id);
  if (previous && batch.observedAt <= previous.lastAttemptAt)
    batch = {
      ...batch,
      observedAt: new Date(Date.parse(previous.lastAttemptAt) + 1).toISOString(),
    };
  store.ingest(batch);
}

export interface SyncRun {
  wallMs: number;
  connectorMs: number;
  requests: number;
  bytes: number;
  misses: number;
  batches: number;
  byCourse: Map<string, CourseTraffic>;
  maxInFlight: number;
}

/** One sync the way the worker runs the Canvas phase: connector options from the store, then save() per batch. */
export async function replaySync(
  store: Store,
  recording: Recording,
  now: () => Date,
  extra: Partial<CanvasConnectorOptions> = {},
  replay: ReplayOptions = {},
): Promise<SyncRun> {
  const transport = replayTransport(recording, replay);
  const started = performance.now();
  let ingestMs = 0,
    batches = 0;
  const s = store.ingestionSettings();
  for await (const batch of canvasConnector({
    fetch: transport.fetch,
    origin: recording.origin,
    metadataConcurrency: s.metadataConcurrency,
    collectComments: s.collectComments,
    selectedTerm: s.selectedTerm,
    courseOverrides: store.courseOverrides(),
    knownResources: store.resources(),
    now,
    // Pacing jitter fixed at its mean so runs are comparable; the pacing itself stays the product's.
    random: () => 0.5,
    ...extra,
  }).pull()) {
    const t = performance.now();
    save(store, batch);
    ingestMs += performance.now() - t;
    batches++;
  }
  const wallMs = performance.now() - started;
  return {
    wallMs,
    connectorMs: wallMs - ingestMs,
    requests: transport.requests(),
    bytes: transport.bytes(),
    misses: transport.misses(),
    batches,
    byCourse: transport.byCourse(),
    maxInFlight: transport.maxInFlight(),
  };
}
