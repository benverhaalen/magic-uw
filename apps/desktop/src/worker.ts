import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema } from "@magic/contracts";
import fixture from "../../../fixtures/course.json";
import { randomUUID } from "node:crypto";
import { createLocalService } from "./local-service";
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
const tick = setInterval(() => core.wake(), 30000);
tick.unref();
port.on("message", async ({ data }: { data: any }) => {
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
  if (["import", "fixture", "privacy", "purge"].includes(data.command?.type))
    local.cancel();
  try {
    port.postMessage({
      kind: "response",
      id: data.id,
      result: await core.execute(data.command),
    });
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
