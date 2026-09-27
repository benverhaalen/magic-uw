import type { QueryRequest } from "@magic/contracts";

/**
 * Optional seam to Nate's `assignment.workspace` page view (branch feat/page-views,
 * packages/contracts/src/page-views.ts `AssignmentWorkspace.tools`). That contract is
 * not in this build, so it is read structurally and validated here; when the query
 * is unknown to the running app the task workspace simply offers no course tools.
 * Only browser-openable https tools become choices. A Canvas (LTI) tool is only ever
 * pointed at in Canvas; Magic never launches it.
 */
export interface CourseTool { name: string; host: string; url: string; reason: string; evidence: { quote: string; source: string } | null }
export interface CanvasOnlyTool { name: string; note: string; url: string | null }
export type CourseToolsState =
  | { kind: "loading" }
  /** The running app has no assignment.workspace query. Not an error the student can fix. */
  | { kind: "unsupported" }
  | { kind: "error"; message: string }
  | { kind: "ready"; tools: CourseTool[]; canvasOnly: CanvasOnlyTool[] };

type QueryBridge = { query?: (request: QueryRequest) => Promise<unknown> };

const str = (value: unknown, max = 2000) => typeof value === "string" && value.length <= max ? value : null;
function https(value: unknown) {
  const text = str(value);
  if (!text) return null;
  try { const url = new URL(text); return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null; } catch { return null; }
}

/** Validate the page-view result shape; anything unexpected is dropped rather than trusted. */
export function toolsFromPageView(value: unknown): Extract<CourseToolsState, { kind: "ready" }> | null {
  if (!value || typeof value !== "object" || (value as { view?: unknown }).view !== "assignment.workspace") return null;
  const raw = (value as { tools?: unknown }).tools;
  if (!Array.isArray(raw)) return null;
  const tools: CourseTool[] = [];
  const canvasOnly: CanvasOnlyTool[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, 30)) {
    if (!entry || typeof entry !== "object") continue;
    const tool = entry as Record<string, unknown>;
    const name = str(tool.name, 300);
    const action = tool.action as Record<string, unknown> | undefined;
    if (!name || !action) continue;
    const first = Array.isArray(tool.evidence) ? tool.evidence[0] as Record<string, unknown> | undefined : undefined;
    const quote = first && str(first.quote, 2000), source = first && str(first.source, 400);
    if (action.kind === "open_in_browser") {
      const url = https(action.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      tools.push({ name, host: str(tool.host, 300) ?? new URL(url).host, url, reason: str(tool.reason, 600) ?? "Found in this course's saved material.", evidence: quote && source ? { quote, source } : null });
    } else if (action.kind === "open_from_canvas") {
      canvasOnly.push({ name, note: str(action.note, 400) ?? "Open it from Canvas.", url: https(action.url) });
    }
  }
  return { kind: "ready", tools, canvasOnly };
}

/** An unknown view is rejected by main's schema: this build does not have the page view. */
export function isUnsupported(cause: unknown) {
  const text = cause instanceof Error ? cause.message : String(cause);
  return /Scoped queries aren't available|invalid_union|discriminator|Invalid input/i.test(text);
}

const cache = new Map<string, Promise<CourseToolsState>>();
let unsupported = false;
/** One read per resource version per session; an unsupported build is not asked again. */
export function readCourseTools(resourceId: string, version: string, bridge: QueryBridge | undefined = typeof window === "undefined" ? undefined : window.magic): Promise<CourseToolsState> {
  if (unsupported || !bridge?.query) return Promise.resolve({ kind: "unsupported" });
  const key = `${resourceId}\u0000${version}`;
  const cached = cache.get(key);
  if (cached) return cached;
  // The request shape is Nate's; this build's QueryRequest does not list it yet.
  const request = { view: "assignment.workspace", resourceId } as unknown as QueryRequest;
  const pending = bridge.query(request).then(result => toolsFromPageView(result) ?? { kind: "unsupported" as const }, cause => {
    cache.delete(key);
    if (isUnsupported(cause)) { unsupported = true; return { kind: "unsupported" as const }; }
    return { kind: "error" as const, message: "Course tools couldn't be read just now." };
  });
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  cache.set(key, pending);
  return pending;
}
/** Test seam only. */
export function resetCourseToolsCache() { cache.clear(); unsupported = false; }
