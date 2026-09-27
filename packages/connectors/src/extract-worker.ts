// owner: acquisition. One extraction thread of extract-pool.ts: pdfjs and the Office unzip run
// here, off the utility process's event loop. It reads a local file the manager already hashed
// and returns only the extracted text; it makes no network request.
import { parentPort } from "node:worker_threads";
import { createLocalDocumentExtractor, type ExtractionOptions } from "./documents.ts";

interface Job {
  kind: "extract";
  id: number;
  file: string;
  options: Omit<ExtractionOptions, "signal">;
}
interface Cancel {
  kind: "cancel";
  id: number;
}
const extractor = createLocalDocumentExtractor();
const running = new Map<number, AbortController>();
parentPort?.on("message", (message: Job | Cancel) => {
  if (message.kind === "cancel") {
    running.get(message.id)?.abort();
    return;
  }
  const controller = new AbortController();
  running.set(message.id, controller);
  extractor
    .extract(message.file, { ...message.options, signal: controller.signal })
    .then(
      (result) => parentPort?.postMessage({ id: message.id, result }),
      () => parentPort?.postMessage({ id: message.id, aborted: controller.signal.aborted }),
    )
    .finally(() => running.delete(message.id));
});
