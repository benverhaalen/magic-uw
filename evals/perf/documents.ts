/**
 * owner: acquisition. The document stage: a synthetic term (5 courses, 300 mixed files) with the
 * Files tab hidden (403), files reachable only through module File items and page-body links, and
 * Canvas downloads that redirect to an Instructure file-service host (inst-fs), as UW's live
 * capture showed. Measured for the earlier loop (ACQUISITION_BEFORE) and the app's (ACQUISITION_APP).
 * No network: every answer is generated here, with a latency and bandwidth model.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import {
  ACQUISITION_APP,
  ACQUISITION_BEFORE,
  createIngestion,
  type AcquisitionOptions,
} from "../../apps/desktop/src/ingestion";
import { createSyntheticCanvasUniversity } from "../../packages/connectors/src/canvas-fixture";
import { fetchCanvasFile, causeHeaders, canvasFileDownloadUrl } from "../../packages/connectors/src/canvas-file-download";
import { createPublicClient, type PublicClient } from "../../packages/connectors/src/network";
import { docx, scannedPdf, textPdf } from "../../tests/fix-acq-fixtures";

const origin = "https://canvas.wisc.edu";
const INST_FS = "https://inst-fs-iad-prod.inscloudgate.net";
export interface CourseOptions {
  files?: number;
  latencyMs?: number;
  /** Bytes per second per download. */
  bandwidth?: number;
  /** Canvas answers the signed URL with the bytes itself (no inst-fs hop): isolates loop speed. */
  direct?: boolean;
  /** Where Canvas redirects downloads; a host outside the allowlist shows the refusal cause. */
  fileHost?: string;
  /** The Files list is open (default: hidden, 403). */
  filesList?: boolean;
  /** Display names by file index (for example a syllabus). */
  names?: Record<number, string>;
}
interface SyntheticFile {
  id: string;
  course: number;
  name: string;
  type: string;
  bytes: Uint8Array;
  updatedAt: string;
}
const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });
function makeFiles(count: number, names: Record<number, string> = {}): SyntheticFile[] {
  const files: SyntheticFile[] = [];
  for (let i = 0; i < count; i++) {
    const course = 101 + (i % 5),
      id = String(5000 + i),
      kind = i % 20;
    const topic = `Topic ${i}: synthetic lecture notes about concept ${i % 37}`;
    const updatedAt = "2026-09-20T12:00:00Z";
    if (kind < 8)
      files.push({ id, course, name: `notes-${i}.txt`, type: "text/plain", bytes: Buffer.from(`${topic}\n`.repeat(40 + (i % 200))), updatedAt });
    else if (kind < 12)
      files.push({
        id, course, name: `handout-${i}.docx`,
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: docx(Array.from({ length: 30 + (i % 50) }, (_, p) => `${topic} paragraph ${p}`)), updatedAt,
      });
    else if (kind < 19)
      files.push({
        id, course, name: `slides-${i}.pdf`, type: "application/pdf",
        bytes: textPdf(Array.from({ length: 8 + (i % 60) }, (_, p) => `${topic} page ${p + 1}`)), updatedAt,
      });
    else files.push({ id, course, name: `scan-${i}.pdf`, type: "application/pdf", bytes: scannedPdf(`Scanned ${i}`), updatedAt });
    if (names[i]) files[files.length - 1]!.name = names[i]!;
  }
  return files;
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

export function syntheticDocumentTerm(options: CourseOptions = {}) {
  const latency = options.latencyMs ?? 60,
    bandwidth = options.bandwidth ?? 8 * 1024 * 1024,
    fileHost = options.fileHost ?? INST_FS;
  const files = makeFiles(options.files ?? 300, options.names);
  const byId = new Map(files.map((f) => [f.id, f]));
  const university = createSyntheticCanvasUniversity({ origin, rateLimit: false });
  const counts = { metadata: 0, downloads: 0, bytes: 0, other: 0, inFlight: 0, peakInFlight: 0 };
  const order: string[] = [];
  const courseFiles = (course: number) => files.filter((f) => f.course === course);
  async function transfer(file: SyntheticFile, signal?: AbortSignal | null) {
    counts.inFlight++;
    counts.peakInFlight = Math.max(counts.peakInFlight, counts.inFlight);
    try {
      await sleep(latency + (file.bytes.byteLength / bandwidth) * 1000, signal);
      counts.downloads++;
      counts.bytes += file.bytes.byteLength;
      order.push(file.name);
      return new Response(new Uint8Array(file.bytes), {
        headers: { "content-type": file.type, "content-length": String(file.bytes.byteLength) },
      });
    } finally {
      counts.inFlight--;
    }
  }
  /** The file service: inst-fs serves bytes for a token URL. */
  async function fileService(url: string, signal?: AbortSignal | null): Promise<Response> {
    const match = /\/files\/([\w-]+)\/([^/?]+)/.exec(new URL(url).pathname);
    const file = match && byId.get(match[1]!.replace(/^u-/, ""));
    if (!file) return new Response("", { status: 404 });
    return transfer(file, signal);
  }
  const redirectTo = (file: SyntheticFile) =>
    new Response(null, {
      status: 302,
      headers: { location: `${fileHost}/files/u-${file.id}/${encodeURIComponent(file.name)}?download=1&token=SYNTHETIC_JWT` },
    });
  /** Canvas's own answer to a download (session or verifier): a redirect to the file service. */
  async function canvasDownload(fileId: string, signal?: AbortSignal | null) {
    const file = byId.get(fileId);
    if (!file) return new Response("", { status: 404 });
    await sleep(latency, signal);
    return options.direct ? transfer(file, signal) : redirectTo(file);
  }
  /** main's source-fetch: API reads as before; a file download goes through fetchCanvasFile. */
  async function canvasFetch(url: string, init?: RequestInit): Promise<Response> {
    const signal = init?.signal;
    if (canvasFileDownloadUrl(url, origin)) {
      try {
        const file = await fetchCanvasFile(url, {
          origin,
          signal: signal ?? undefined,
          session: async (target, requestInit) => {
            const id = /\/files\/(\d+)\/download$/.exec(new URL(target).pathname)?.[1];
            return canvasDownload(id ?? "", requestInit.signal);
          },
          plain: async (target, requestInit) => fileService(target, requestInit.signal),
        });
        const body = new Uint8Array(await file.response.arrayBuffer());
        return new Response(body, {
          headers: {
            "content-type": file.response.headers.get("content-type") ?? "application/octet-stream",
            "x-magic-host-class": file.hostClass,
          },
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        return new Response("", { status: 502, headers: causeHeaders(error) });
      }
    }
    const path = new URL(url).pathname;
    await sleep(latency, signal);
    const list = /^\/api\/v1\/courses\/(\d+)\/files$/.exec(path);
    if (list) {
      counts.other++;
      if (!options.filesList) return json({ status: "unauthorized" }, 403); // the Files tab is hidden
      return json(
        courseFiles(Number(list[1])).map((f) => ({
          id: f.id, folder_id: "1", display_name: f.name, filename: f.name, "content-type": f.type,
          size: f.bytes.byteLength, updated_at: f.updatedAt, created_at: f.updatedAt, locked_for_user: false,
        })),
      );
    }
    const modules = /^\/api\/v1\/courses\/(\d+)\/modules$/.exec(path);
    if (modules) {
      counts.other++;
      const list = courseFiles(Number(modules[1]));
      return json([{ id: "1", name: "Readings", position: 1, items_count: Math.ceil(list.length / 2) }]);
    }
    const items = /^\/api\/v1\/courses\/(\d+)\/modules\/1\/items$/.exec(path);
    if (items) {
      counts.other++;
      const list = courseFiles(Number(items[1]));
      // Half the files are module File items; the other half are linked from a page body.
      return json(
        list.slice(0, Math.ceil(list.length / 2)).map((f, i) => ({
          id: String(i + 1), module_id: "1", position: i + 1, type: "File", title: f.name, content_id: f.id,
        })),
      );
    }
    const pages = /^\/api\/v1\/courses\/(\d+)\/pages$/.exec(path);
    if (pages) {
      counts.other++;
      return json([{ page_id: 1, url: "readings", title: "More readings", updated_at: "2026-09-20T12:00:00Z" }]);
    }
    const page = /^\/api\/v1\/courses\/(\d+)\/pages\/readings$/.exec(path);
    if (page) {
      counts.other++;
      const course = Number(page[1]);
      const list = courseFiles(course);
      const links = list
        .slice(Math.ceil(list.length / 2))
        .map((f) => `<a href="${origin}/courses/${course}/files/${f.id}?verifier=SYNTHETIC">${f.name}</a>`)
        .join(" ");
      return json({ page_id: 1, url: "readings", title: "More readings", updated_at: "2026-09-20T12:00:00Z", body: `<p>Readings</p>${links}` });
    }
    const meta = /^\/api\/v1\/files\/(\d+)$/.exec(path);
    if (meta) {
      const file = byId.get(meta[1]!);
      if (!file) {
        counts.other++; // the base university's own references (file 9), not the term's files
        return json({}, 404);
      }
      counts.metadata++;
      return json({
        id: file.id, folder_id: "1", display_name: file.name, filename: file.name, "content-type": file.type,
        size: file.bytes.byteLength, updated_at: file.updatedAt, locked_for_user: false, hidden: false,
        context_type: "Course", context_id: String(file.course),
        url: `${origin}/files/${file.id}/download?download_frd=1&verifier=SYNTHETIC_VERIFIER`,
      });
    }
    counts.other++;
    return university.fetch(url, init);
  }
  /** The earlier path: the public client follows the signed URL without cookies. */
  const client: PublicClient = createPublicClient({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (request) => {
      const url = request.url;
      if (url.origin === origin) {
        const id = /^\/files\/(\d+)\/download$/.exec(url.pathname)?.[1];
        return canvasDownload(id ?? "", request.signal);
      }
      return fileService(url.href, request.signal);
    },
  });
  return { canvasFetch, client, counts, files, order };
}

export interface StageResult {
  label: string;
  syncs: number;
  instantTierMs: number;
  fullTextMs: number | null;
  totalMs: number;
  filesWithText: number;
  filesTotal: number;
  metadataRequests: number;
  downloads: number;
  bytes: number;
  peakDownloadsInFlight: number;
  extraction: { threaded: boolean; completed?: number; busyMs?: number; filesPerSecond?: number };
  causes: Record<string, number>;
  secondSync: { metadataRequests: number; downloads: number; ms: number };
}
export async function runDocumentStage(
  label: string,
  acquisition: AcquisitionOptions,
  options: CourseOptions & { maxSyncs?: number } = {},
): Promise<StageResult> {
  const directory = mkdtempSync(join(tmpdir(), "magic-perf-documents-"));
  const store = createStore(":memory:");
  const term = syntheticDocumentTerm(options);
  let at = new Date("2026-09-26T17:00:00Z");
  let firstDocumentAt: number | undefined, started = 0;
  const ingestion = createIngestion(store, {
    directory,
    now: () => at,
    secrets: async () => ({}),
    client: term.client,
    canvasFetch: term.canvasFetch,
    acquisition: { ...acquisition, ocrPagesPerRun: 0 },
    extractWorkerScript: new URL("../../tests/fix-acq-extract-worker.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    onSaved: (id) => {
      if (firstDocumentAt === undefined && /:file:\d+$/.test(id)) firstDocumentAt = performance.now() - started;
    },
  });
  const withText = () =>
    new Set(
      store
        .resources()
        .filter((r) => r.document && r.text.trim() && !r.deleted)
        .map((r) => `${r.courseId}:${r.document!.fileId}`),
    ).size;
  const readable = term.files.filter((f) => !f.name.startsWith("scan-")).length;
  let syncs = 0,
    fullTextMs: number | null = null;
  started = performance.now();
  try {
    for (; syncs < (options.maxSyncs ?? 4); ) {
      syncs++;
      await ingestion.tick("manual");
      if (withText() >= readable) {
        fullTextMs = performance.now() - started;
        break;
      }
      at = new Date(at.getTime() + 3600_000);
    }
    const totalMs = performance.now() - started;
    const run = ingestion.documentRun();
    const causes: Record<string, number> = {};
    for (const s of store.sources())
      if (/^documents:|:file:\d+$/.test(s.id))
        for (const d of s.diagnostics ?? []) causes[d.code] = (causes[d.code] ?? 0) + 1;
    const firstCounts = { ...term.counts };
    // A second sync with nothing changed: what the steady state costs.
    at = new Date(at.getTime() + 3600_000);
    const before = { metadata: term.counts.metadata, downloads: term.counts.downloads };
    const second = performance.now();
    await ingestion.tick("manual");
    const secondSync = {
      metadataRequests: term.counts.metadata - before.metadata,
      downloads: term.counts.downloads - before.downloads,
      ms: Math.round(performance.now() - second),
    };
    const pool = run.pool;
    return {
      label,
      syncs,
      instantTierMs: Math.round(firstDocumentAt ?? totalMs),
      fullTextMs: fullTextMs === null ? null : Math.round(fullTextMs),
      totalMs: Math.round(totalMs),
      filesWithText: withText(),
      filesTotal: term.files.length,
      metadataRequests: firstCounts.metadata,
      downloads: firstCounts.downloads,
      bytes: firstCounts.bytes,
      peakDownloadsInFlight: firstCounts.peakInFlight,
      extraction: {
        threaded: run.threaded,
        ...(pool
          ? { completed: pool.completed, busyMs: pool.busyMs, filesPerSecond: Number((pool.completed / (totalMs / 1000)).toFixed(1)) }
          : {}),
      },
      causes,
      secondSync,
    };
  } finally {
    await ingestion.closeExtraction();
    await ingestion.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
export async function documentStage() {
  const results = [
    await runDocumentStage("before (live-like: Canvas redirects to inst-fs)", ACQUISITION_BEFORE),
    await runDocumentStage("before, Canvas serves bytes directly (loop speed only)", ACQUISITION_BEFORE, { direct: true }),
    await runDocumentStage("after (ACQUISITION_APP)", ACQUISITION_APP),
    await runDocumentStage("after, unknown file host (refusal cause)", ACQUISITION_APP, {
      fileHost: "https://files.unlisted-cdn.example",
      files: 20,
      maxSyncs: 1,
    }),
  ];
  return results;
}
