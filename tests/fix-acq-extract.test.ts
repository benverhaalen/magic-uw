// owner: acquisition. The extraction pool, OS OCR, the crawler cache fix, conditional GET and the
// robots.txt 4xx rule.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resourceInputSchema, type ResourceInput } from "@magic/contracts";
import { createExtractPool } from "../packages/connectors/src/extract-pool";
import { detectOsOcrEngine, ocrDocument } from "../packages/connectors/src/ocr-os";
import { externalCourseConnector } from "../packages/connectors/src/external";
import { MaterialReadError, type PublicClient } from "../packages/connectors/src/network";
import { docx, scannedPdf, textPdf, textPng } from "./fix-acq-fixtures";

const workerScript = fileURLToPath(new URL("./fix-acq-extract-worker.mjs", import.meta.url));

test("the extraction pool reads PDF, DOCX and text in worker threads, in parallel", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-fix-acq-pool-"));
  const pool = createExtractPool({ workerScript, size: 3 });
  try {
    const files = {
      "a.pdf": textPdf(["Enzymes lower activation energy", "Second page"]),
      "b.docx": docx(["Cell membranes are selectively permeable"]),
      "c.txt": new TextEncoder().encode("Plain notes about osmosis"),
      "d.pdf": scannedPdf("Scanned only"),
    };
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(directory, name), bytes);
    assert.equal(pool.threaded, true);
    const results = await Promise.all(
      Object.keys(files).map((name) => pool.extract(join(directory, name), { filename: name })),
    );
    assert.deepEqual(
      results.map((r) => r.status),
      ["ok", "ok", "ok", "needs_ocr"],
    );
    assert.match(results[0]!.text, /Enzymes lower activation energy/);
    assert.deepEqual(results[0]!.pages.map((p) => p.page), [1, 2]);
    assert.match(results[1]!.text, /selectively permeable/);
    assert.match(results[2]!.text, /osmosis/);
    assert.ok(pool.stats().peakActive >= 2, "more than one file was extracted at a time");
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("without a worker script the pool extracts in-process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-fix-acq-pool-"));
  const pool = createExtractPool({ workerScript: join(directory, "missing.cjs") });
  try {
    writeFileSync(join(directory, "n.txt"), "Fallback text");
    assert.equal(pool.threaded, false);
    assert.equal((await pool.extract(join(directory, "n.txt"), { filename: "n.txt" })).text, "Fallback text");
  } finally {
    await pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "Windows.Media.Ocr reads a scanned PDF page and an image, unpackaged",
  { skip: process.platform !== "win32" && "the OS OCR engine checked here is Windows'" },
  async () => {
    const engine = await detectOsOcrEngine();
    assert.equal(engine?.name, "windows-media-ocr");
    const directory = mkdtempSync(join(tmpdir(), "magic-fix-acq-ocr-"));
    try {
      writeFileSync(join(directory, "scan.pdf"), scannedPdf("Mitochondria produce cellular energy"));
      writeFileSync(join(directory, "board.png"), textPng("Photosynthesis converts light energy"));
      const pdf = await ocrDocument(
        {
          localPath: join(directory, "scan.pdf"),
          filename: "scan.pdf",
          pages: [{ page: 1, text: "", anchor: "#page=1" }],
        },
        { engine: engine!, maxPages: 5 },
      );
      assert.equal(pdf.status, "ok");
      assert.match(pdf.text, /Mitochondria produce cellular energy/);
      const image = await ocrDocument(
        { localPath: join(directory, "board.png"), filename: "board.png", pages: [] },
        { engine: engine!, maxPages: 5 },
      );
      assert.match(image.text, /Photosynthesis converts light energy/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

function crawlClient(answers: {
  robots?: () => never | { text: string };
  document?: (conditional: boolean) => Response;
}) {
  const calls: { url: string; conditional: boolean }[] = [];
  const client: PublicClient = {
    isCanvas: (url) => new URL(url).origin === "https://canvas.wisc.edu",
    async text(url) {
      calls.push({ url, conditional: false });
      const robots = answers.robots ?? (() => ({ text: "" }));
      return { url, redirects: [], response: new Response(""), ...robots() };
    },
    async get(url, options) {
      const conditional = !!(options as { conditional?: unknown } | undefined)?.conditional;
      calls.push({ url, conditional });
      const response = answers.document?.(conditional) ?? new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } });
      return { url, redirects: [], response, ...(response.status === 304 ? { notModified: true } : {}) };
    },
    async feed() {
      return "";
    },
    async signedDownload() {
      throw new Error("unused");
    },
  };
  return { client, calls };
}
const pdfUrl = "https://courses.synthetic.test/101/notes.pdf";
function storedDocument(fetchedAt: string): ResourceInput {
  return resourceInputSchema.parse({
    externalId: "doc",
    kind: "material",
    courseId: "101",
    courseName: "Synthetic course",
    title: "notes.pdf",
    url: pdfUrl,
    text: "Stored text",
    document: {
      pages: [],
      extractionStatus: "ok",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    crawl: { depth: 0, discoveredFrom: pdfUrl, fetchedAt },
  });
}
async function crawl(client: PublicClient, previous: ResourceInput[], at: string) {
  let documents = 0;
  const batches = [];
  for await (const batch of externalCourseConnector({
    accountScope: "a",
    courseId: "101",
    courseName: "Synthetic course",
    seeds: [pdfUrl],
    client,
    previous,
    now: () => new Date(at),
    onDocument: async ({ url, response }) => {
      documents++;
      await response.response.body?.cancel();
      return { ...storedDocument(at), url, text: "Fresh text" };
    },
  }).pull(new AbortController().signal))
    batches.push(batch);
  return { batch: batches[0]!, documents };
}

test("the crawler reuses a course-site PDF fetched within six hours (fetchedAt, not only observedAt)", async () => {
  const { client, calls } = crawlClient({});
  const result = await crawl(client, [storedDocument("2026-09-26T12:00:00.000Z")], "2026-09-26T14:00:00.000Z");
  assert.equal(result.documents, 0);
  assert.equal(calls.filter((c) => c.url === pdfUrl).length, 0, "no re-download");
  assert.equal(result.batch.resources[0]?.text, "Stored text");
});

test("an older course-site PDF is asked for conditionally; a 304 keeps the stored text", async () => {
  const { client, calls } = crawlClient({
    document: (conditional) => (conditional ? new Response(null, { status: 304 }) : new Response("%PDF")),
  });
  const result = await crawl(client, [storedDocument("2026-09-20T12:00:00.000Z")], "2026-09-26T14:00:00.000Z");
  assert.deepEqual(calls.filter((c) => c.url === pdfUrl).map((c) => c.conditional), [true]);
  assert.equal(result.documents, 0);
  assert.equal(result.batch.resources[0]?.text, "Stored text");
  assert.equal(result.batch.resources[0]?.crawl?.fetchedAt, "2026-09-26T14:00:00.000Z");
});

test("robots.txt: a 4xx means no rules (RFC 9309 2.3.1.3); a 5xx stays disallowed", async () => {
  for (const [status, crawled] of [
    [401, true],
    [403, true],
    [404, true],
    [500, false],
    [503, false],
  ] as const) {
    const { client, calls } = crawlClient({
      robots: () => {
        throw new MaterialReadError(
          status === 404 ? "not_found" : status < 500 ? "inaccessible" : "http_error",
          { status },
        );
      },
    });
    await crawl(client, [], "2026-09-26T14:00:00.000Z");
    assert.equal(calls.some((c) => c.url === pdfUrl), crawled, `robots ${status}`);
  }
});
