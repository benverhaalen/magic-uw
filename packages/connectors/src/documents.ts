import { createHash, randomUUID } from "node:crypto";
import {
  open,
  mkdir,
  rename,
  rm,
  stat,
  readFile,
  mkdtemp,
} from "node:fs/promises";
import { join, extname, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Parser } from "htmlparser2";
import { unzipSync } from "fflate";
import type { ResourceInput } from "@magic/contracts";
import { contentHash, extractLinkedText, isLoginHtml } from "./external.ts";
import {
  MaterialReadError,
  publicUrl,
  type PublicClient,
  type PublicResponse,
} from "./network.ts";

export interface ExtractedDocument {
  text: string;
  parts: NonNullable<ResourceInput["parts"]>;
  pages: NonNullable<ResourceInput["document"]>["pages"];
  status: "ok" | "partial" | "unsupported" | "error" | "needs_ocr";
  diagnostics: string[];
}
export interface LocalOcrAdapter {
  page(file: string, page: number, signal?: AbortSignal): Promise<string>;
}
export interface ExtractionOptions {
  contentType?: string;
  filename?: string;
  dueSoon?: boolean;
  opened?: boolean;
  signal?: AbortSignal;
}
export interface DocumentExtractor {
  extract(file: string, options: ExtractionOptions): Promise<ExtractedDocument>;
}
const MAX_TEXT = 200000;
const MAX_PAGES = 500;
function xmlText(xml: string): string {
  const parts: string[] = [];
  new Parser(
    {
      ontext: (text) => parts.push(text),
      onclosetag: (name) => {
        if (/(?:^|:)(?:p|tr|row|t)$/.test(name)) parts.push("\n");
      },
    },
    { xmlMode: true, decodeEntities: true },
  ).end(xml);
  return parts
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function officeParts(
  buffer: Uint8Array,
  extension: string,
): NonNullable<ResourceInput["parts"]> {
  let total = 0;
  const files = unzipSync(buffer, {
    filter: (entry) => {
      const relevant =
        /^(?:word\/document\.xml|ppt\/slides\/slide\d+\.xml|xl\/(?:sharedStrings\.xml|worksheets\/sheet\d+\.xml)|content\.xml)$/.test(
          entry.name,
        );
      if (!relevant) return false;
      total += entry.originalSize;
      if (entry.originalSize > 20 * 1024 * 1024 || total > 50 * 1024 * 1024)
        throw new MaterialReadError("office_expansion_limit");
      return true;
    },
  });
  const decode = (name: string) => new TextDecoder().decode(files[name]);
  if (files["word/document.xml"])
    return [
      {
        section: "Document text (pagination depends on layout)",
        text: xmlText(decode("word/document.xml")),
      },
    ];
  const slides = Object.keys(files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(
      (a, b) =>
        Number(a.match(/slide(\d+)/)![1]) - Number(b.match(/slide(\d+)/)![1]),
    );
  if (slides.length)
    return slides.map((name) => ({
      slide: Number(name.match(/slide(\d+)/)![1]),
      text: xmlText(decode(name)),
    }));
  const sheets = Object.keys(files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (sheets.length) {
    const shared: string[] = [];
    let inItem = false;
    let item = "";
    if (files["xl/sharedStrings.xml"])
      new Parser(
        {
          onopentag: (name) => {
            if (name === "si") {
              inItem = true;
              item = "";
            }
          },
          ontext: (text) => {
            if (inItem) item += text;
          },
          onclosetag: (name) => {
            if (name === "si") {
              shared.push(item);
              inItem = false;
            }
          },
        },
        { xmlMode: true, decodeEntities: true },
      ).end(decode("xl/sharedStrings.xml"));
    return sheets.map((name, index) => {
      const cells: string[] = [];
      let type = "";
      let ref = "";
      let value = "";
      let inside = false;
      new Parser(
        {
          onopentag: (tag, attrs) => {
            if (tag === "c") {
              type = attrs.t ?? "";
              ref = attrs.r ?? "";
              value = "";
            }
            if (tag === "v" || tag === "t") inside = true;
          },
          ontext: (text) => {
            if (inside) value += text;
          },
          onclosetag: (tag) => {
            if (tag === "v" || tag === "t") inside = false;
            if (tag === "c")
              cells.push(
                `${ref}: ${type === "s" ? (shared[Number(value)] ?? "") : value}`,
              );
          },
        },
        { xmlMode: true, decodeEntities: true },
      ).end(decode(name));
      return { section: `Worksheet ${index + 1}`, text: cells.join("\n") };
    });
  }
  if (files["content.xml"]) {
    const xml = decode("content.xml");
    if (extension === ".odp") {
      const pages = [
        ...xml.matchAll(/<draw:page\b[^>]*>([\s\S]*?)<\/draw:page>/g),
      ];
      if (pages.length)
        return pages.map((page, index) => ({
          slide: index + 1,
          text: xmlText(page[1]!),
        }));
    }
    return [{ section: "Document text", text: xmlText(xml) }];
  }
  throw new MaterialReadError("office_format_unsupported");
}
export function createLocalDocumentExtractor(
  options: { ocr?: LocalOcrAdapter } = {},
): DocumentExtractor {
  return {
    async extract(file, settings) {
      const result: ExtractedDocument = {
        text: "",
        parts: [],
        pages: [],
        status: "ok",
        diagnostics: [],
      };
      try {
        settings.signal?.throwIfAborted();
        const info = await stat(file);
        if (info.size > 100 * 1024 * 1024)
          throw new MaterialReadError("byte_limit");
        const extension = extname(settings.filename ?? file).toLowerCase();
        const buffer = new Uint8Array(await readFile(file));
        if (Buffer.from(buffer.subarray(0, 5)).toString() === "%PDF-") {
          const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
          const task = pdfjs.getDocument({
            data: buffer,
            useWorkerFetch: false,
            disableFontFace: true,
            enableXfa: false,
            verbosity: 0,
          });
          const abort = () => {
            void task.destroy();
          };
          settings.signal?.addEventListener("abort", abort, { once: true });
          try {
            const pdf = await task.promise;
            if (pdf.numPages > MAX_PAGES) {
              result.status = "partial";
              result.diagnostics.push("page_limit");
            }
            for (
              let pageNumber = 1;
              pageNumber <= Math.min(pdf.numPages, MAX_PAGES);
              pageNumber++
            ) {
              settings.signal?.throwIfAborted();
              const page = await pdf.getPage(pageNumber);
              const content = await page.getTextContent();
              let text = content.items
                .map((item) =>
                  "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "",
                )
                .join("")
                .trim();
              if (!text) {
                if ((settings.dueSoon || settings.opened) && options.ocr)
                  text = await options.ocr.page(
                    file,
                    pageNumber,
                    settings.signal,
                  );
                if (!text) {
                  result.status =
                    result.status === "partial" ? "partial" : "needs_ocr";
                  result.diagnostics.push("textless_page");
                }
              }
              if (result.text.length + text.length > MAX_TEXT) {
                result.status = "partial";
                result.diagnostics.push("text_limit");
                break;
              }
              result.pages.push({
                page: pageNumber,
                text,
                anchor: `#page=${pageNumber}`,
              });
              result.parts.push({ page: pageNumber, text });
              result.text += (result.text ? "\n\n" : "") + text;
              page.cleanup();
            }
          } finally {
            settings.signal?.removeEventListener("abort", abort);
            await task.destroy();
          }
          return result;
        }
        if (
          [".docx", ".pptx", ".xlsx", ".odt", ".odp", ".ods"].includes(
            extension,
          )
        )
          result.parts = officeParts(buffer, extension);
        else if (
          /^(?:text\/|application\/(?:json|xml|x-ipynb\+json))/i.test(
            settings.contentType ?? "",
          ) ||
          [".html", ".htm", ".txt", ".md", ".csv", ".json", ".ipynb"].includes(
            extension,
          )
        ) {
          const text = new TextDecoder().decode(buffer);
          const html =
            /html/i.test(settings.contentType ?? "") ||
            [".html", ".htm"].includes(extension);
          result.parts = [
            {
              section: html ? "HTML document" : "Text document",
              text: extractLinkedText(
                text,
                "https://local-document.invalid/",
                html,
              ).text,
            },
          ];
        } else
          return {
            ...result,
            status: "unsupported",
            diagnostics: ["format_unsupported"],
          };
        const bounded: typeof result.parts = [];
        for (const part of result.parts) {
          if (
            bounded.length >= MAX_PAGES ||
            result.text.length + part.text.length > MAX_TEXT
          ) {
            result.status = "partial";
            result.diagnostics.push("text_limit");
            break;
          }
          bounded.push(part);
          result.text += (result.text ? "\n\n" : "") + part.text;
        }
        result.parts = bounded;
        return result;
      } catch (error) {
        if (settings.signal?.aborted) throw error;
        return {
          ...result,
          status: "error",
          diagnostics: [
            error instanceof MaterialReadError
              ? error.code
              : "extraction_failed",
          ],
        };
      }
    },
  };
}
async function runLocal(
  binary: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "ignore"],
      signal: AbortSignal.any([
        AbortSignal.timeout(60000),
        ...(signal ? [signal] : []),
      ]),
    });
    let text = "";
    let failed = false;
    child.stdout.on("data", (chunk) => {
      text += chunk.toString();
      if (text.length > MAX_TEXT) {
        failed = true;
        child.kill();
      }
    });
    child.on("error", () =>
      reject(new MaterialReadError("ocr_tool_unavailable")),
    );
    child.on("close", (code) =>
      code === 0 && !failed
        ? resolveResult(text.trim())
        : reject(new MaterialReadError("ocr_failed")),
    );
  });
}
/** Uses explicitly configured local executables and local traineddata; no downloads or hosted OCR. */
export function createLocalOcrAdapter(options: {
  pdftoppmPath: string;
  tesseractPath: string;
  tessdataDirectory: string;
  language?: string;
}): LocalOcrAdapter {
  const language = options.language ?? "eng";
  if (!/^[a-zA-Z0-9_+]+$/.test(language))
    throw new MaterialReadError("invalid_ocr_language");
  for (const path of [
    options.pdftoppmPath,
    options.tesseractPath,
    options.tessdataDirectory,
  ])
    if (!isAbsolute(path))
      throw new MaterialReadError("ocr_absolute_paths_required");
  return {
    async page(file, page, signal) {
      if (!Number.isInteger(page) || page < 1 || page > MAX_PAGES)
        throw new MaterialReadError("invalid_page");
      for (const lang of language.split("+"))
        await stat(join(options.tessdataDirectory, `${lang}.traineddata`));
      const directory = await mkdtemp(join(tmpdir(), "magic-ocr-"));
      try {
        const prefix = join(directory, "page");
        await runLocal(
          options.pdftoppmPath,
          [
            "-f",
            String(page),
            "-l",
            String(page),
            "-r",
            "150",
            "-singlefile",
            "-png",
            file,
            prefix,
          ],
          signal,
        );
        return await runLocal(
          options.tesseractPath,
          [
            `${prefix}.png`,
            "stdout",
            "--tessdata-dir",
            options.tessdataDirectory,
            "-l",
            language,
          ],
          signal,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
export interface DocumentCaptureInput extends ExtractionOptions {
  id: string;
  sourceUrl: string;
  downloadUrl?: string;
  allowedDownloadOrigins?: string[];
  updatedAt?: string | null;
  previous?: NonNullable<ResourceInput["document"]>;
  /** The complete local extraction paired with previous; avoids reparsing unchanged files. */
  cached?: Pick<ExtractedDocument, "text" | "parts" | "pages" | "status">;
  response?: PublicResponse;
  /** owner: acquisition. Fetches the bytes only when the stored copy cannot be reused. */
  download?: () => Promise<PublicResponse>;
}
export interface CapturedDocument extends ExtractedDocument {
  document: NonNullable<ResourceInput["document"]>;
  skipped: boolean;
  contentType: string;
}
// owner: acquisition. Windows refuses a rename onto a file another reader holds open (EPERM,
// EBUSY, EACCES), which parallel downloads of one file hit. The target name is content-addressed
// (`<id hash>-<sha256>`), so an existing target already holds these exact bytes: keep it.
const RENAME_RETRY = new Set(["EPERM", "EBUSY", "EACCES"]);
async function placeDownload(temporary: string, path: string) {
  for (let attempt = 0; ; attempt++) {
    const existing = await stat(path).catch(() => null);
    if (existing?.isFile()) {
      await rm(temporary, { force: true });
      return;
    }
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!RENAME_RETRY.has(code) || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
}
// One capture per file id at a time, across managers (a sync and a drain can overlap).
const fileLocks = new Map<string, Promise<void>>();
async function withFileLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const before = fileLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const chained = before.then(() => mine);
  fileLocks.set(key, chained);
  await before;
  try {
    return await task();
  } finally {
    release();
    if (fileLocks.get(key) === chained) fileLocks.delete(key);
  }
}
// end owner: acquisition
export function createDocumentManager(options: {
  directory: string;
  client: PublicClient;
  downloadConcurrency?: number;
  maxBytes?: number;
  extractor?: DocumentExtractor;
  /**
   * owner: acquisition. "all" keeps every downloaded file (the default). "ocr-pending" keeps the
   * bytes only while the document waits for OCR; text, pages, hash and metadata are what is stored
   * (docs/pipeline-details.md, storage policy).
   */
  retainBytes?: "all" | "ocr-pending";
}) {
  const directory = resolve(options.directory);
  const extractor = options.extractor ?? createLocalDocumentExtractor();
  let active = 0;
  const waiting: (() => void)[] = [];
  const concurrency = Math.max(
    1,
    Math.min(options.downloadConcurrency ?? 4, 8),
  );
  const maxBytes = Math.min(
    options.maxBytes ?? 100 * 1024 * 1024,
    100 * 1024 * 1024,
  );
  function capture(input: DocumentCaptureInput): Promise<CapturedDocument> {
    return withFileLock(`${directory}|${input.id}`, () => captureOnce(input)); // owner: acquisition
  }
  async function captureOnce(
    input: DocumentCaptureInput,
  ): Promise<CapturedDocument> {
    if (active >= concurrency)
      await new Promise<void>((resolveWait) => waiting.push(resolveWait));
    else active++;
    try {
      input.signal?.throwIfAborted();
      publicUrl(input.sourceUrl);
      const previous = input.previous;
      const rel = previous?.localPath
        ? relative(directory, resolve(previous.localPath))
        : "";
      // owner: acquisition: unchanged and fully read before; the stored text is enough, with or
      // without the bytes.
      if (
        input.updatedAt &&
        previous?.updatedAt === input.updatedAt &&
        previous.extractionStatus === "ok" &&
        input.cached?.status === "ok" &&
        (!previous.localPath || options.retainBytes === "ocr-pending")
      )
        return {
          ...input.cached,
          diagnostics: [],
          document: { ...previous, extractionStatus: "ok", pages: input.cached.pages },
          skipped: true,
          contentType: input.contentType ?? "application/octet-stream",
        };
      if (
        input.updatedAt &&
        previous?.updatedAt === input.updatedAt &&
        previous.localPath &&
        rel &&
        !rel.startsWith("..") &&
        !isAbsolute(rel)
      ) {
        const existing = await stat(previous.localPath).catch(() => null);
        if (existing?.isFile()) {
          const extracted: ExtractedDocument =
            previous.extractionStatus === "ok" && input.cached?.status === "ok"
              ? { ...input.cached, diagnostics: [] }
              : await extractor.extract(previous.localPath, {
                  ...input,
                  filename: input.filename ?? new URL(input.sourceUrl).pathname,
                });
          return {
            ...extracted,
            document: {
              ...previous,
              extractionStatus: extracted.status,
              pages: extracted.pages,
            },
            skipped: true,
            contentType: input.contentType ?? "application/octet-stream",
          };
        }
      }
      const fetched =
        input.response ??
        (input.download
          ? await input.download()
          : input.downloadUrl
          ? await options.client.signedDownload(
              input.downloadUrl,
              input.allowedDownloadOrigins ?? [],
              input.signal,
            )
          : await options.client.get(input.sourceUrl, {
              signal: input.signal,
            }));
      const contentType = (
        fetched.response.headers.get("content-type") ??
        input.contentType ??
        "application/octet-stream"
      ).split(";")[0]!;
      if (Number(fetched.response.headers.get("content-length")) > maxBytes) {
        await fetched.response.body?.cancel();
        throw new MaterialReadError("byte_limit");
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `.download-${randomUUID()}`);
      const file = await open(temporary, "wx", 0o600);
      const hash = createHash("sha256");
      let sizeBytes = 0;
      const reader = fetched.response.body?.getReader();
      let prefix = "";
      try {
        if (!reader) throw new MaterialReadError("empty_download");
        while (true) {
          input.signal?.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          sizeBytes += next.value.byteLength;
          if (sizeBytes > maxBytes) throw new MaterialReadError("byte_limit");
          if (prefix.length < 65536)
            prefix += new TextDecoder().decode(
              next.value.subarray(0, 65536 - prefix.length),
            );
          hash.update(next.value);
          let offset = 0;
          while (offset < next.value.byteLength) {
            const written = await file.write(
              next.value,
              offset,
              next.value.byteLength - offset,
            );
            if (!written.bytesWritten)
              throw new MaterialReadError("disk_write_failed");
            offset += written.bytesWritten;
          }
        }
        if (isLoginHtml(prefix)) throw new MaterialReadError("login_page");
        await file.close();
        const sha256 = hash.digest("hex");
        const path = join(
          directory,
          `${contentHash(input.id).slice(0, 20)}-${sha256}`,
        );
        await placeDownload(temporary, path);
        const extracted = await extractor.extract(path, {
          ...input,
          filename: input.filename ?? new URL(input.sourceUrl).pathname,
          contentType,
        });
        // owner: acquisition: a public document without an API date keeps its Last-Modified, which
        // the crawler sends back as If-Modified-Since.
        const lastModified = fetched.response.headers.get("last-modified");
        const modifiedAt =
          lastModified && !Number.isNaN(Date.parse(lastModified))
            ? new Date(lastModified).toISOString()
            : undefined;
        // owner: acquisition: drop the bytes once read, unless OCR still needs them.
        const keep = options.retainBytes !== "ocr-pending" || extracted.status === "needs_ocr";
        if (!keep) await rm(path, { force: true }).catch(() => {});
        return {
          ...extracted,
          document: {
            fileId: input.id,
            ...(keep ? { localPath: path } : {}),
            sha256,
            sizeBytes,
            updatedAt: input.updatedAt ?? modifiedAt,
            extractionStatus: extracted.status,
            pages: extracted.pages,
          },
          skipped: false,
          contentType,
        };
      } catch (error) {
        await file.close().catch(() => {});
        await rm(temporary, { force: true });
        throw error;
      } finally {
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }
  return { capture };
}
