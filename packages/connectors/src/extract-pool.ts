// owner: acquisition. Document extraction in a small worker_threads pool, separate from download
// slots: pdfjs and the Office unzip block a thread for seconds on a large file, and on the utility
// process's own loop they stalled every other read (audit item 3; documents.ts extract).
// The pool implements DocumentExtractor, so the document manager is unchanged. Without a worker
// script (a build that does not ship extract-worker.cjs) it extracts in-process, as before.
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  createLocalDocumentExtractor,
  type DocumentExtractor,
  type ExtractedDocument,
  type ExtractionOptions,
} from "./documents.ts";

export interface ExtractPoolOptions {
  /** extract-worker.ts (tests, tsx) or the built extract-worker.cjs beside the utility bundle. */
  workerScript?: string | URL;
  /** Threads; 2–3 by default (one core stays for the store and the download loop). */
  size?: number;
  /** Used when no worker script exists. OCR is not run in the pool; see ocr-os.ts. */
  fallback?: DocumentExtractor;
}
export interface ExtractPool extends DocumentExtractor {
  readonly threaded: boolean;
  readonly size: number;
  stats(): { completed: number; busyMs: number; peakActive: number };
  close(): Promise<void>;
}
interface Slot {
  worker: Worker;
  busy: boolean;
}
interface Pending {
  file: string;
  options: ExtractionOptions;
  resolve(value: ExtractedDocument): void;
  reject(error: unknown): void;
}
export function defaultExtractThreads() {
  return Math.max(2, Math.min(3, availableParallelism() - 1));
}
export function createExtractPool(options: ExtractPoolOptions = {}): ExtractPool {
  const fallback = options.fallback ?? createLocalDocumentExtractor();
  const script =
    options.workerScript instanceof URL ? fileURLToPath(options.workerScript) : options.workerScript;
  const size = Math.max(1, Math.min(4, options.size ?? defaultExtractThreads()));
  const threaded = !!script && existsSync(script);
  const slots: Slot[] = [];
  const queue: Pending[] = [];
  let nextId = 1,
    completed = 0,
    busyMs = 0,
    active = 0,
    peakActive = 0,
    closed = false;
  function spawn(): Slot {
    const worker = new Worker(script!);
    worker.unref();
    const slot = { worker, busy: false };
    worker.on("error", () => {
      // A crashed thread is replaced; its job is answered by the exit handler below.
    });
    slots.push(slot);
    return slot;
  }
  function run(slot: Slot, job: Pending) {
    const id = nextId++,
      started = performance.now();
    slot.busy = true;
    slot.worker.ref(); // an idle thread never holds the process open; a busy one does
    active++;
    peakActive = Math.max(peakActive, active);
    const finish = () => {
      slot.worker.off("message", onMessage);
      slot.worker.off("exit", onExit);
      job.options.signal?.removeEventListener("abort", onAbort);
      slot.busy = false;
      slot.worker.unref();
      active--;
      busyMs += performance.now() - started;
      completed++;
      pump();
    };
    const onMessage = (message: { id: number; result?: ExtractedDocument; aborted?: boolean }) => {
      if (message.id !== id) return;
      finish();
      if (message.result) job.resolve(message.result);
      else if (job.options.signal?.aborted) job.reject(job.options.signal.reason);
      else job.resolve({ text: "", parts: [], pages: [], status: "error", diagnostics: ["extraction_failed"] });
    };
    const onExit = () => {
      slots.splice(slots.indexOf(slot), 1);
      finish();
      job.resolve({ text: "", parts: [], pages: [], status: "error", diagnostics: ["extraction_failed"] });
    };
    const onAbort = () => slot.worker.postMessage({ kind: "cancel", id });
    slot.worker.on("message", onMessage);
    slot.worker.once("exit", onExit);
    job.options.signal?.addEventListener("abort", onAbort, { once: true });
    const { signal: _signal, ...plain } = job.options;
    slot.worker.postMessage({ kind: "extract", id, file: job.file, options: plain });
  }
  function pump() {
    while (queue.length && !closed) {
      const slot = slots.find((s) => !s.busy) ?? (slots.length < size ? spawn() : undefined);
      if (!slot) return;
      const job = queue.shift()!;
      if (job.options.signal?.aborted) {
        job.reject(job.options.signal.reason);
        continue;
      }
      run(slot, job);
    }
  }
  return {
    threaded,
    size: threaded ? size : 1,
    async extract(file, extraction) {
      extraction.signal?.throwIfAborted();
      if (!threaded || closed) {
        const started = performance.now();
        active++;
        peakActive = Math.max(peakActive, active);
        try {
          return await fallback.extract(file, extraction);
        } finally {
          active--;
          completed++;
          busyMs += performance.now() - started;
        }
      }
      return new Promise<ExtractedDocument>((resolve, reject) => {
        queue.push({ file, options: extraction, resolve, reject });
        pump();
      });
    },
    stats: () => ({ completed, busyMs: Math.round(busyMs), peakActive }),
    async close() {
      closed = true;
      for (const job of queue.splice(0)) job.reject(new Error("extract pool closed"));
      await Promise.all(slots.splice(0).map((slot) => slot.worker.terminate()));
    },
  };
}
