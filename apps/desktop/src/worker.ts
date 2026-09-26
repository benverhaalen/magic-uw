import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema } from "@magic/contracts";
import fixture from "../../../fixtures/course.json";
import { randomUUID } from "node:crypto";
import { createLocalService } from "./local-service";
import { createIngestion } from "./ingestion";
import { dirname } from "node:path";
import {
  createLocalDocumentExtractor,
  createLocalOcrAdapter,
} from "../../../packages/connectors/src/documents";
const port = process.parentPort;
if (!port) throw new Error("Workspace must be started by the desktop app.");
const pending = new Map<
  string,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
const store = createStore(process.env.MAGIC_DB_PATH!);
const core = createCore(store, {
  fixture: captureBatchSchema.parse(fixture),
  ...(process.env.MAGIC_GATEWAY_URL
    ? {
        gateway: {
          evaluate(payload: any, signal: AbortSignal) {
            const id = randomUUID();
            return new Promise<any>((resolve, reject) => {
              const cancel = () => {
                port.postMessage({ kind: "abort", id });
                pending.delete(id);
                reject(new Error("Cancelled"));
              };
              signal.addEventListener("abort", cancel, { once: true });
              pending.set(id, {
                resolve(value) {
                  signal.removeEventListener("abort", cancel);
                  resolve(value);
                },
                reject(error) {
                  signal.removeEventListener("abort", cancel);
                  reject(error);
                },
              });
              port.postMessage({ kind: "evaluate", id, payload });
            });
          },
        },
      }
    : {}),
});
const local = createLocalService(store, core);
const hostRequests = new Map<
  string,
  { resolve(value: any): void; reject(error: Error): void }
>();
function hostRead(
  kind: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<any> {
  signal?.throwIfAborted();
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const abort = () => {
      finish();
      hostRequests.delete(id);
      port.postMessage({ kind: "source-abort", id });
      reject(new Error("Read cancelled"));
    };
    const timer = setTimeout(abort, 60_000);
    signal?.addEventListener("abort", abort, { once: true });
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    hostRequests.set(id, {
      resolve(value) {
        finish();
        resolve(value);
      },
      reject(error) {
        finish();
        reject(error);
      },
    });
    port.postMessage({ kind, id, payload });
  });
}
function sourceFetch(service: string) {
  return async (url: string, init?: RequestInit) => {
    const value = await hostRead(
      "source-fetch",
      { service, url },
      init?.signal ?? undefined,
    );
    const response = new Response(
      [204, 205, 304].includes(value.status) ? null : value.body,
      { status: value.status, headers: value.headers },
    );
    Object.defineProperty(response, "url", { value: value.url });
    return response;
  };
}
const {
  MAGIC_PDFTOPPM_PATH: pdftoppmPath,
  MAGIC_TESSERACT_PATH: tesseractPath,
  MAGIC_TESSDATA_DIRECTORY: tessdataDirectory,
} = process.env;
const extractor = createLocalDocumentExtractor(
  pdftoppmPath && tesseractPath && tessdataDirectory
    ? {
        ocr: createLocalOcrAdapter({
          pdftoppmPath,
          tesseractPath,
          tessdataDirectory,
        }),
      }
    : {},
);
const ingestion = createIngestion(store, {
  directory: dirname(process.env.MAGIC_DB_PATH!),
  extractor,
  canvasFetch: sourceFetch("canvas"),
  gitlabFetch: sourceFetch("gitlab"),
  secrets: (operation, key, value) =>
    hostRead("source-secret", { operation, key, value }),
});
const refreshTimer = setInterval(() => {
  void ingestion.tick();
}, 30_000);
refreshTimer.unref();
const tick = setInterval(() => core.wake(), 30000);
tick.unref();
port.on("message", async ({ data }: { data: any }) => {
  if (data.kind === "source-response") {
    const request = hostRequests.get(data.id);
    hostRequests.delete(data.id);
    if (data.error) request?.reject(new Error("Source read unavailable"));
    else request?.resolve(data.result);
    return;
  }
  if (data.kind === "suspend") {
    ingestion.suspend();
    return;
  }
  if (data.kind === "resume") {
    ingestion.resume();
    return;
  }
  if (data.kind === "reconnected") {
    ingestion.reconnected();
    return;
  }
  if (data.kind === "refresh-cancel") {
    ingestion.cancel();
    return;
  }
  if (data.kind === "refresh") {
    try {
      await ingestion.tick("manual");
      port.postMessage({
        kind: "response",
        id: data.id,
        result: {
          ...(await core.execute({ type: "snapshot" })),
          message:
            "Refresh finished. Source status shows any incomplete reads.",
        },
      });
    } catch {
      port.postMessage({
        kind: "response",
        id: data.id,
        error: "Refresh interrupted. Saved coursework is still available.",
      });
    }
    return;
  }
  if (data.kind === "evaluation") {
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (p) {
      if (data.error) p.reject(new Error("Judgment unavailable"));
      else p.resolve(data.result);
    }
    return;
  }
  if (data.kind === "shutdown") {
    clearInterval(refreshTimer);
    await ingestion.stop();
    clearInterval(tick);
    local.cancel();
    await core.close();
    port.postMessage({ kind: "closed" });
    return;
  }
  if (data.kind === "local-cancel") {
    local.cancel(data.id);
    return;
  }
  if (data.kind === "local") {
    try {
      if (data.operation !== "status" && data.operation !== "ask")
        throw new Error("Invalid local operation");
      const result =
        data.operation === "status"
          ? await local.status(data.id)
          : await local.ask(data.id, data.request);
      port.postMessage({ kind: "local-response", id: data.id, result });
    } catch (error) {
      port.postMessage({
        kind: "local-response",
        id: data.id,
        error:
          error instanceof Error &&
          error.name !== "ZodError" &&
          error.name !== "AbortError"
            ? error.message
            : "Local AI was cancelled or the request was invalid.",
      });
    }
    return;
  }
  if (data.kind !== "command") return;
  if (data.command?.type === "purge") {
    ingestion.suspend();
    await ingestion.tick();
  }
  if (["import", "fixture", "privacy", "purge"].includes(data.command?.type))
    local.cancel();
  try {
    port.postMessage({
      kind: "response",
      id: data.id,
      result: await core.execute(data.command),
    });
    if (data.command?.type === "purge") ingestion.resume();
  } catch (error) {
    port.postMessage({
      kind: "response",
      id: data.id,
      error:
        error instanceof Error && error.name !== "ZodError"
          ? error.message
          : "The request did not match the workspace schema.",
    });
  }
});
core.wake();
port.postMessage({ kind: "ready" });
