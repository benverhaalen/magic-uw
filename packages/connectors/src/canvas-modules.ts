import type { CaptureBatch } from "@magic/contracts";
import type { z } from "zod";
import { CanvasFailure, canvasNextPage, type CanvasHttp } from "./canvas-http";
import { itemSchema, moduleSchema, hashCanvas } from "./canvas-models";

type Item = z.infer<typeof itemSchema>;
type Module = z.infer<typeof moduleSchema>;
export interface ModuleObservation {
  module: Module;
  items: Item[];
  /** Actual network attempts charged to this module's fallback reads. */
  requests: number;
  complete: boolean;
  status: CaptureBatch["status"];
  diagnostics: string[];
}
export interface CanvasModuleResult {
  accountScope?: string;
  origin: string;
  courseId: string;
  observedAt: string;
  modules: ModuleObservation[];
  listComplete: boolean;
  complete: boolean;
  status: ModuleObservation["status"];
  diagnostics: string[];
  requests: number;
  listRequests: number;
}
/** Ephemeral, one authenticated run only; never persist or share across session generations. */
export interface CanvasModuleRun {
  readonly accountScope: string;
  readonly generation: object;
  readonly results: Map<string, Promise<CanvasModuleResult>>;
  invalidated: boolean;
}
export function createCanvasModuleRun(accountScope: string): CanvasModuleRun {
  return {
    accountScope,
    generation: {},
    results: new Map(),
    invalidated: false,
  };
}
function code(error: unknown): string {
  return error instanceof CanvasFailure ? error.code : "invalid_module_data";
}
function status(error: unknown): ModuleObservation["status"] {
  return error instanceof CanvasFailure ? error.status : "partial";
}
export async function readCanvasModules(
  http: CanvasHttp,
  courseId: string,
  signal?: AbortSignal,
  run?: CanvasModuleRun,
): Promise<CanvasModuleResult> {
  signal?.throwIfAborted();
  if (run?.invalidated)
    throw new CanvasFailure("partial", "module_run_invalidated");
  if (http.needsSignIn) throw new CanvasFailure("needs_sign_in");
  const key = `${http.origin}\n${courseId}`;
  if (run) {
    const existing = run.results.get(key);
    if (existing) return existing;
  }
  const invalidate = () => {
    if (run) {
      run.invalidated = true;
      run.results.clear();
    }
  };
  signal?.addEventListener("abort", invalidate, { once: true });
  const read = acquire(http, courseId, signal, run?.accountScope).finally(() =>
    signal?.removeEventListener("abort", invalidate),
  );
  run?.results.set(key, read);
  return read;
}
async function acquire(
  http: CanvasHttp,
  courseId: string,
  signal?: AbortSignal,
  accountScope?: string,
): Promise<CanvasModuleResult> {
  const result: CanvasModuleResult = {
    accountScope,
    origin: http.origin,
    courseId,
    observedAt: new Date().toISOString(),
    modules: [],
    listComplete: true,
    complete: true,
    status: "ok",
    diagnostics: [],
    requests: 0,
    listRequests: 0,
  };
  const prefix = `${http.origin}/api/v1/courses/${courseId}/modules`;
  const started = performance.now();
  let logicalRequests = 0;
  const listStats = { requests: 0 };
  async function list(url: string, accept: (raw: unknown) => void, scopeStats: { requests: number }) {
    const seen = new Set<string>();
    let next: string | null = url,
      count = 0;
    while (next && seen.size < 20) {
      if (logicalRequests >= 200 || performance.now() - started > 120_000)
        throw new CanvasFailure("partial", "module_request_budget");
      if (seen.has(next))
        throw new CanvasFailure("partial", "pagination_cycle");
      seen.add(next);
      logicalRequests++;
      const before = scopeStats.requests;
      const response = await http.request(next, signal, scopeStats).finally(() => {
        result.requests += scopeStats.requests - before;
      });
      if (!Array.isArray(response.data))
        throw new CanvasFailure("partial", "expected_array");
      for (const raw of response.data) {
        if (++count > 2000) throw new CanvasFailure("partial", "record_limit");
        accept(raw);
      }
      next = canvasNextPage(response.link, next, url, http.origin);
    }
    if (next) throw new CanvasFailure("partial", "page_limit");
  }
  const inline = new Map<string, unknown>(),
    ids = new Set<string>();
  try {
    await list(
      `${prefix}?per_page=100&include[]=items&include[]=content_details`,
      (raw) => {
        try {
          const module = moduleSchema.parse(raw);
          if (ids.has(module.id))
            throw new CanvasFailure("partial", "duplicate_identity");
          ids.add(module.id);
          inline.set(module.id, (raw as { items?: unknown }).items);
          result.modules.push({
            module,
            items: [],
            requests: 0,
            complete: true,
            status: "ok",
            diagnostics: [],
          });
        } catch (error) {
          result.listComplete = false;
          result.diagnostics.push(code(error));
        }
      },
      listStats,
    );
  } catch (error) {
    signal?.throwIfAborted();
    result.listComplete = false;
    result.status = status(error);
    result.diagnostics.push(code(error));
  }
  result.listRequests = listStats.requests;
  for (const observation of result.modules) {
    const { module } = observation;
    function validate(raw: unknown[], target: Item[]) {
      const seen = new Set<string>();
      for (const value of raw) {
        try {
          const item = itemSchema.parse(value);
          if (item.module_id && item.module_id !== module.id)
            throw new CanvasFailure("partial", "module_id_mismatch");
          if (seen.has(item.id))
            throw new CanvasFailure("partial", "duplicate_identity");
          seen.add(item.id);
          target.push(item);
        } catch (error) {
          observation.diagnostics.push(code(error));
        }
      }
      if (
        module.items_count !== undefined &&
        target.length !== module.items_count
      )
        observation.diagnostics.push("module_item_count_mismatch");
    }
    const raw = inline.get(module.id);
    if (Array.isArray(raw) && raw.length <= 2000)
      validate(raw, observation.items);
    if (
      !Array.isArray(raw) ||
      raw.length > 2000 ||
      observation.diagnostics.length
    ) {
      const validInline = observation.items;
      observation.items = [];
      observation.diagnostics = [];
      const rows: unknown[] = [];
      try {
        await list(
          `${prefix}/${module.id}/items?per_page=100&include[]=content_details`,
          (row) => rows.push(row),
          observation,
        );
      } catch (error) {
        signal?.throwIfAborted();
        observation.status = status(error);
        observation.diagnostics.push(code(error));
      }
      validate(rows, observation.items);
      if (observation.diagnostics.length) {
        const found = new Set(observation.items.map((item) => item.id));
        observation.items.push(
          ...validInline.filter((item) => !found.has(item.id)),
        );
      }
    }
    observation.complete = observation.diagnostics.length === 0;
    if (!observation.complete && observation.status === "ok")
      observation.status = "partial";
    if (http.needsSignIn) {
      for (const pending of result.modules.slice(
        result.modules.indexOf(observation) + 1,
      )) {
        pending.complete = false;
        pending.status = "needs_sign_in";
        pending.diagnostics.push("needs_sign_in");
      }
      break;
    }
  }
  const itemOwners = new Map<string, ModuleObservation>();
  for (const entry of result.modules)
    for (const item of entry.items) {
      const previous = itemOwners.get(item.id);
      if (previous)
        for (const duplicate of [previous, entry]) {
          duplicate.complete = false;
          duplicate.status = "partial";
          duplicate.diagnostics.push("duplicate_item_identity");
        }
      else itemOwners.set(item.id, entry);
    }
  result.complete =
    result.listComplete && result.modules.every((m) => m.complete);
  if (http.needsSignIn) {
    result.complete = false;
    result.status = "needs_sign_in";
  } else if (!result.complete && result.status === "ok")
    result.status = "partial";
  return result;
}

export function moduleItemsHash(
  modules: Array<Module & { items?: Item[] | null }>,
): string {
  const rows = modules.flatMap((module) =>
    module.items
      ? module.items.map((item) =>
          [
            module.id,
            item.id,
            item.type,
            item.title,
            item.content_id ?? "",
            item.page_url ?? "",
            item.external_url ?? "",
            item.content_details?.due_at ?? "",
            item.content_details?.points_possible ?? "",
          ].join("\u001f"),
        )
      : [[module.id, "items_count", module.items_count ?? ""].join("\u001f")],
  );
  rows.push(
    ...modules.map((module) =>
      ["module", module.id, module.name, module.position ?? ""].join("\u001f"),
    ),
  );
  return hashCanvas(rows.sort().join("\n"));
}
