// owner: acquisition. RC1–RC3 end to end on the synthetic term (Files tab hidden, module File
// items and page-body links, downloads redirected to inst-fs), plus cheap skips, syllabus-first
// order, the needs_ocr status and the Windows rename race.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "@magic/storage";
import {
  ACQUISITION_APP,
  ACQUISITION_BEFORE,
  createIngestion,
  type AcquisitionOptions,
} from "../apps/desktop/src/ingestion";
import { syntheticDocumentTerm, type CourseOptions } from "../evals/perf/documents";
import { createDocumentManager } from "../packages/connectors/src/documents";

const workerScript = fileURLToPath(new URL("./fix-acq-extract-worker.mjs", import.meta.url));

async function sync(acquisition: Partial<AcquisitionOptions>, options: CourseOptions, ticks = 1) {
  const directory = mkdtempSync(join(tmpdir(), "magic-fix-acq-"));
  const store = createStore(":memory:");
  const term = syntheticDocumentTerm({ latencyMs: 2, bandwidth: 1e9, ...options });
  let at = new Date("2026-09-26T17:00:00Z");
  const ingestion = createIngestion(store, {
    directory,
    now: () => at,
    secrets: async () => ({}),
    client: term.client,
    canvasFetch: term.canvasFetch,
    acquisition: { ...acquisition, ocrPagesPerRun: 0 },
    extractWorkerScript: workerScript,
  });
  const snapshots: { metadata: number; downloads: number }[] = [];
  for (let i = 0; i < ticks; i++) {
    const before = { metadata: term.counts.metadata, downloads: term.counts.downloads };
    await ingestion.tick("manual");
    snapshots.push({
      metadata: term.counts.metadata - before.metadata,
      downloads: term.counts.downloads - before.downloads,
    });
    at = new Date(at.getTime() + 3600_000);
  }
  const documents = store.resources().filter((r) => r.document && !r.deleted);
  const causes: Record<string, number> = {};
  const hosts = new Set<string>();
  for (const s of store.sources())
    if (s.id.startsWith("documents:"))
      for (const d of s.diagnostics ?? []) {
        causes[d.code] = (causes[d.code] ?? 0) + 1;
        if (d.path[0] === "host") hosts.add(d.path[1]!);
      }
  const result = { store, term, documents, causes, hosts, snapshots, run: ingestion.documentRun() };
  return {
    ...result,
    async close() {
      await ingestion.closeExtraction();
      await ingestion.stop();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("RC1–RC3: module File items and body links get text through the session route, once each", async () => {
  const run = await sync(ACQUISITION_APP, { files: 20 }, 2);
  try {
    const withText = new Set(run.documents.filter((r) => r.text.trim()).map((r) => r.document!.fileId));
    const readable = run.term.files.filter((f) => !f.name.startsWith("scan-"));
    assert.equal(withText.size, readable.length, JSON.stringify(run.causes));
    assert.equal(run.snapshots[0]!.downloads, 20, "each referenced file is downloaded exactly once");
    assert.equal(run.snapshots[1]!.downloads, 0, "an unchanged file is not downloaded again");
    assert.ok(run.run.threaded, "extraction ran in the worker_threads pool");
    // Text-less PDFs are their own status, complete rather than partial.
    const scans = run.documents.filter((r) => r.document!.extractionStatus === "needs_ocr");
    assert.equal(scans.length, 1);
    assert.equal(run.store.sources().find((s) => s.id === scans[0]!.sourceId)?.status, "ok");
    assert.equal(run.causes.needs_ocr, 1);
    assert.equal(run.causes.document_read_incomplete, undefined);
    // Bytes are not kept after extraction, except while OCR is due.
    assert.ok(run.documents.filter((r) => r.text.trim()).every((r) => !r.document!.localPath));
    assert.ok(scans[0]!.document!.localPath);
  } finally {
    await run.close();
  }
});

test("RC3: the earlier signed download records secret_origin_blocked at the inst-fs host", async () => {
  const run = await sync(ACQUISITION_BEFORE, { files: 10 });
  try {
    assert.equal(run.documents.filter((r) => r.text.trim()).length, 0);
    assert.equal(run.causes.secret_origin_blocked, 10);
    assert.deepEqual([...run.hosts], ["inst-fs-iad-prod.inscloudgate.net"]);
  } finally {
    await run.close();
  }
});

test("RC3: an unlisted file host is refused with its host in the diagnostic", async () => {
  const run = await sync(ACQUISITION_APP, { files: 5, fileHost: "https://files.unlisted-cdn.example" });
  try {
    assert.equal(run.causes.redirect_blocked, 5);
    assert.deepEqual([...run.hosts], ["files.unlisted-cdn.example"]);
    assert.equal(run.term.counts.downloads, 0);
  } finally {
    await run.close();
  }
});

test("cheap skip: an unchanged Files-list row makes no metadata request and no download", async () => {
  const run = await sync(ACQUISITION_APP, { files: 10, filesList: true }, 2);
  try {
    assert.equal(run.snapshots[0]!.downloads, 10);
    assert.equal(run.snapshots[1]!.metadata, 0);
    assert.equal(run.snapshots[1]!.downloads, 0);
    assert.equal(run.run.skipped, 10);
  } finally {
    await run.close();
  }
});

test("order: syllabus first, then small text before large PDFs", async () => {
  const run = await sync(
    { ...ACQUISITION_APP, loops: 1 },
    { files: 20, names: { 13: "Course syllabus.pdf" }, filesList: true },
  );
  try {
    assert.equal(run.term.order[0], "Course syllabus.pdf");
    const rest = run.term.order.slice(1);
    const firstPdf = rest.findIndex((name) => name.endsWith(".pdf"));
    assert.ok(firstPdf > 0);
    assert.ok(rest.slice(firstPdf).every((name) => name.endsWith(".pdf")), rest.join(","));
  } finally {
    await run.close();
  }
});

test("reference-only: a video keeps its metadata and link and is never downloaded", async () => {
  const run = await sync(ACQUISITION_APP, { files: 5, names: { 0: "Lecture 1.mp4" } });
  try {
    assert.equal(run.term.counts.downloads, 4);
    assert.ok(!run.term.order.includes("Lecture 1.mp4"));
    assert.equal(run.causes.reference_only, 1);
  } finally {
    await run.close();
  }
});

test("Windows: parallel captures of one file id never fail on the rename", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-fix-acq-rename-"));
  try {
    const manager = () =>
      createDocumentManager({
        directory,
        client: {} as never,
        downloadConcurrency: 8,
      });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        manager().capture({
          id: "9",
          sourceUrl: "https://canvas.wisc.edu/courses/101/files/9",
          filename: "reading.txt",
          contentType: "text/plain",
          response: {
            url: "https://canvas.wisc.edu/courses/101/files/9",
            redirects: [],
            response: new Response(`Shared reading text ${i % 2}`, {
              headers: { "content-type": "text/plain" },
            }),
          },
        }),
      ),
    );
    assert.ok(results.every((r) => r.status === "ok"));
    assert.equal(new Set(results.map((r) => r.document.sha256)).size, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
