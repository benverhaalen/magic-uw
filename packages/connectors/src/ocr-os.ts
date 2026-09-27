// owner: acquisition. Background OCR for documents marked `needs_ocr`, with the OS's own engine:
// Windows.Media.Ocr through Windows PowerShell 5.1's WinRT bridge (checked unpackaged on Windows 11,
// 2026-09-27: 0.6 s per page image), and Apple Vision through `swift` on macOS (not run here; no
// Mac in this checkout). The configured Tesseract adapter (documents.ts) is the fallback. PDF pages
// are rendered with pdfjs's own Node canvas factory, which loads @napi-rs/canvas (MIT, N-API, so no
// Electron rebuild), already installed as pdfjs-dist's optional dependency.
// Presence-gated (no engine: nothing runs), bounded per run, and never awaited by a sync.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { ResourceInput } from "@magic/contracts";
import type { LocalOcrAdapter } from "./documents.ts";

export interface OcrEngine {
  readonly name: "windows-media-ocr" | "macos-vision" | "tesseract";
  /** One text per image path, in order. */
  recognize(images: string[], signal?: AbortSignal): Promise<string[]>;
}
const MAX_OUTPUT = 4 * 1024 * 1024;
function run(
  binary: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT) child.kill();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
  });
}
const WINDOWS_SCRIPT = String.raw`param([switch]$Probe, [string[]]$Paths)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + String.raw`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { exit 3 }
if ($Probe) { exit 0 }
$out = @()
foreach ($path in $Paths) {
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $out += ,((@($result.Lines | ForEach-Object { $_.Text })) -join "` + "`n" + String.raw`")
    $stream.Dispose()
  } catch { $out += ,"" }
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
ConvertTo-Json -Compress -InputObject @($out)
`;
const MAC_SCRIPT = `import Foundation
import Vision
import AppKit
let args = Array(CommandLine.arguments.dropFirst())
if args.first == "--probe" { exit(0) }
var out: [String] = []
for path in args {
  guard let image = NSImage(contentsOfFile: path),
        let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { out.append(""); continue }
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
  out.append((request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\\n"))
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out))
`;
let scriptDirectory: Promise<string> | undefined;
async function script(name: string, body: string): Promise<string> {
  const directory = await (scriptDirectory ??= mkdtemp(join(tmpdir(), "magic-ocr-engine-")));
  const path = join(directory, name);
  await writeFile(path, body, { mode: 0o600 });
  return path;
}
function parseTexts(stdout: string, count: number): string[] {
  const value: unknown = JSON.parse(stdout.replace(/^\uFEFF/, "").trim() || "[]");
  const list = Array.isArray(value) ? value : [value];
  return Array.from({ length: count }, (_, i) =>
    typeof list[i] === "string" ? (list[i] as string).trim() : "",
  );
}
export function windowsOcrEngine(options: { powershell?: string } = {}): OcrEngine & {
  probe(signal?: AbortSignal): Promise<boolean>;
} {
  const binary =
    options.powershell ??
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const base = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
  return {
    name: "windows-media-ocr",
    async probe(signal) {
      const path = await script("ocr.ps1", WINDOWS_SCRIPT);
      return (await run(binary, [...base, path, "-Probe"], signal, 30_000).catch(() => ({ code: 1 }))).code === 0;
    },
    async recognize(images, signal) {
      if (!images.length) return [];
      const path = await script("ocr.ps1", WINDOWS_SCRIPT);
      const result = await run(binary, [...base, path, "-Paths", ...images], signal);
      if (result.code !== 0) throw new Error("ocr_failed");
      return parseTexts(result.stdout, images.length);
    },
  };
}
export function macosVisionEngine(options: { swift?: string } = {}): OcrEngine & {
  probe(signal?: AbortSignal): Promise<boolean>;
} {
  const binary = options.swift ?? "/usr/bin/swift";
  return {
    name: "macos-vision",
    async probe(signal) {
      const path = await script("ocr.swift", MAC_SCRIPT);
      return (await run(binary, [path, "--probe"], signal, 60_000).catch(() => ({ code: 1 }))).code === 0;
    },
    async recognize(images, signal) {
      if (!images.length) return [];
      const path = await script("ocr.swift", MAC_SCRIPT);
      const result = await run(binary, [path, ...images], signal);
      if (result.code !== 0) throw new Error("ocr_failed");
      return parseTexts(result.stdout, images.length);
    },
  };
}
let detected: Promise<OcrEngine | undefined> | undefined;
/** The OS engine if it answers a probe; checked once per process. */
export function detectOsOcrEngine(platform: NodeJS.Platform = process.platform): Promise<OcrEngine | undefined> {
  return (detected ??= (async () => {
    const engine =
      platform === "win32" ? windowsOcrEngine() : platform === "darwin" ? macosVisionEngine() : undefined;
    return engine && (await engine.probe().catch(() => false)) ? engine : undefined;
  })());
}
/** Renders PDF pages to PNG files with pdfjs's Node canvas (scale 2, about 144 dpi). */
export async function renderPdfPages(
  file: string,
  pages: number[],
  directory: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(await readFile(file)),
    useWorkerFetch: false,
    disableFontFace: true,
    enableXfa: false,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    const factory = (pdf as unknown as {
      canvasFactory: {
        create(w: number, h: number): { canvas: { toBuffer(type: "image/png"): Uint8Array }; context: unknown };
      };
    }).canvasFactory;
    const out: string[] = [];
    for (const number of pages) {
      signal?.throwIfAborted();
      if (number < 1 || number > pdf.numPages) continue;
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: Math.min(2, 4000 / Math.max(1, page.view[2] ?? 612)) });
      const { canvas, context } = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: context, canvas, viewport } as unknown as Parameters<typeof page.render>[0]).promise;
      const path = join(directory, `page-${number}.png`);
      await writeFile(path, canvas.toBuffer("image/png"), { mode: 0o600 });
      out.push(path);
      page.cleanup();
    }
    return out;
  } finally {
    await task.destroy();
  }
}
type DocumentPages = NonNullable<ResourceInput["document"]>["pages"];
export interface OcrInput {
  localPath: string;
  filename?: string;
  contentType?: string;
  pages: DocumentPages;
}
export interface OcrOutput {
  status: "ok" | "needs_ocr";
  text: string;
  parts: NonNullable<ResourceInput["parts"]>;
  pages: DocumentPages;
  recognized: number;
  remaining: number;
  engine?: OcrEngine["name"];
}
const IMAGE = /\.(?:png|jpe?g|gif|bmp|tiff?)$/i;
export function isOcrImage(filename = "", contentType = "") {
  return IMAGE.test(filename) || /^image\/(?:png|jpe?g|gif|bmp|tiff)$/i.test(contentType);
}
/**
 * OCRs up to `maxPages` text-less pages of one stored document (a PDF's empty pages, or an image).
 * Pages that already have text are kept as they are.
 */
export async function ocrDocument(
  input: OcrInput,
  deps: { engine?: OcrEngine; tesseract?: LocalOcrAdapter; maxPages: number; signal?: AbortSignal },
): Promise<OcrOutput> {
  const image = isOcrImage(input.filename ?? input.localPath, input.contentType);
  let pages: DocumentPages = image
    ? input.pages.length
      ? input.pages
      : [{ page: 1, text: "", anchor: "#page=1" }]
    : [...input.pages];
  const empty = pages.filter((p) => !p.text.trim()).slice(0, Math.max(0, deps.maxPages));
  const texts = new Map<number, string>();
  let engine: OcrEngine["name"] | undefined;
  if (empty.length && deps.engine) {
    const directory = await mkdtemp(join(tmpdir(), "magic-ocr-"));
    try {
      const images = image
        ? [input.localPath]
        : await renderPdfPages(input.localPath, empty.map((p) => p.page), directory, deps.signal);
      const found = await deps.engine.recognize(images, deps.signal);
      empty.forEach((p, i) => found[i] && texts.set(p.page, found[i]!));
      engine = deps.engine.name;
    } catch (error) {
      if (deps.signal?.aborted) throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (!image && deps.tesseract)
    for (const p of empty.filter((p) => !texts.has(p.page))) {
      const text = await deps.tesseract.page(input.localPath, p.page, deps.signal).catch(() => "");
      if (text) {
        texts.set(p.page, text);
        engine ??= "tesseract";
      }
    }
  pages = pages.map((p) => (texts.has(p.page) ? { ...p, text: texts.get(p.page)! } : p));
  const remaining = pages.filter((p) => !p.text.trim()).length;
  const text = pages.map((p) => p.text).filter(Boolean).join("\n\n").slice(0, 200_000);
  return {
    status: remaining ? "needs_ocr" : "ok",
    text,
    parts: pages.map((p) => ({ page: p.page, text: p.text })),
    pages,
    recognized: texts.size,
    remaining,
    ...(engine ? { engine } : {}),
  };
}
export interface OcrCandidate extends OcrInput {
  key: string;
}
/**
 * The background job: at most one run at a time, `maxPagesPerRun` pages per run, oldest first.
 * The caller starts it after a sync and does not await it.
 */
export function createOcrBackfill(deps: {
  engine: () => Promise<OcrEngine | undefined>;
  tesseract?: LocalOcrAdapter;
  candidates(): OcrCandidate[];
  save(candidate: OcrCandidate, result: OcrOutput): void;
  maxPagesPerRun?: number;
}) {
  let running: Promise<{ documents: number; pages: number }> | undefined;
  async function once(signal?: AbortSignal) {
    const engine = await deps.engine();
    if (!engine && !deps.tesseract) return { documents: 0, pages: 0 };
    let budget = deps.maxPagesPerRun ?? 30,
      documents = 0,
      pages = 0;
    for (const candidate of deps.candidates()) {
      if (budget <= 0) break;
      signal?.throwIfAborted();
      const ext = extname(candidate.filename ?? candidate.localPath);
      if (!ext && !candidate.contentType && !candidate.pages.length) continue;
      const result = await ocrDocument(candidate, {
        ...(engine ? { engine } : {}),
        ...(deps.tesseract ? { tesseract: deps.tesseract } : {}),
        maxPages: budget,
        ...(signal ? { signal } : {}),
      });
      budget -= Math.max(1, result.recognized + (result.remaining ? 1 : 0));
      if (result.recognized) {
        deps.save(candidate, result);
        documents++;
        pages += result.recognized;
      }
    }
    return { documents, pages };
  }
  return {
    run(signal?: AbortSignal) {
      return (running ??= once(signal).finally(() => {
        running = undefined;
      }));
    },
    get running() {
      return !!running;
    },
  };
}
