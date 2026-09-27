/**
 * The course space inventory (plan D32, spec A5) and its access check (D41).
 *
 * Inventory, by code, 0 tokens: per course, every place content lives, from
 * - the navigation tabs (`/courses/:id/tabs`: students can list them; hidden tabs are omitted)
 * - the installed external tools (`/courses/:id/external_tools`: course `:read` suffices)
 * - module items by type (`modules?include[]=items&include[]=content_details`)
 * - the syllabus and the links in stored page, assignment, announcement and syllabus bodies
 *
 * Guards (D32): the app never requests an LTI launch. A tab's `url` (a `sessionless_launch`),
 * a tool's `url`, a module ExternalTool item and an assignment-level tool are recorded as link
 * cards and never fetched. Only the three list endpoints above are requested.
 *
 * Access (D41): one plain GET per checkable space, redirects not followed, never a launch.
 */
import { z } from "zod";
import type { Resource } from "@magic/contracts";
import {
  CanvasFailure,
  canvasNextPage,
  type CanvasHttp,
} from "./canvas-http";
import { canvasId, hashCanvas, itemSchema, moduleSchema } from "./canvas-models";
import { isLoginHtml } from "./external";
import { MaterialReadError, type PublicClient } from "./network";
import {
  CANVAS_HOST,
  classifyHost,
  isLaunchUrl,
  isSignInTarget,
  type AccessRoute,
  type SpaceKind,
  type SpaceTreatment,
} from "./space-hosts";

export type SpaceFoundIn =
  | "tab"
  | "external_tool"
  | "module_item"
  | "syllabus"
  | "body";
/** D41: the stored access state of one space. */
export type SpaceAccessState =
  | "readable"
  | "needs-uw-signin"
  | "needs-own-login"
  | "link-only"
  | "blocked";
export type SpaceAction = "sign_in_app_window" | "open_in_browser" | "none";
export interface SpaceAccess {
  state: SpaceAccessState;
  reason?: string;
  /** When the state was last established; null before the first check. */
  checkedAt: string | null;
  action: SpaceAction;
}
export interface CourseSpace {
  /** Stable per course and URL. */
  id: string;
  courseId: string;
  kind: SpaceKind;
  host: string;
  /** Origin plus path only: a query or fragment can carry a capability, so neither is kept. */
  url: string;
  foundIn: SpaceFoundIn;
  /** Where it was found: a tab id, a tool id, a module item id or a resource's external id. */
  foundAt: string;
  route: AccessRoute;
  /** D40: store (text becomes passages) or link (a click-to-open card). */
  treatment: SpaceTreatment;
  label: string;
  /** read: its text is stored; unread: to be read; linked: a link card, never read. */
  readState: "read" | "unread" | "linked";
  /** The host is unknown to code; Jev picks the kind from the closed set (D32 step 2). */
  jev: boolean;
  /** The platform's name from the host table, when known. */
  platform?: string;
  /** What opening it does (UW's words), for the link card. */
  launchEffect?: string;
  /** From Canvas, for link cards (D40): due date and points. */
  dueAt?: string | null;
  points?: number | null;
  access: SpaceAccess;
}

const MAX_PAGES = 20;
export const tabSchema = z.object({
  id: z.string().max(200),
  html_url: z.string().max(4000).optional(),
  full_url: z.string().max(4000).optional(),
  position: z.number().int().optional(),
  hidden: z.boolean().optional(),
  unused: z.boolean().optional(),
  label: z.string().max(500),
  type: z.enum(["internal", "external"]),
  /** An LTI tab's sessionless launch URL. Parsed only to be ignored: it is never requested. */
  url: z.string().max(4000).optional(),
});
export const externalToolSchema = z.object({
  id: canvasId,
  name: z.string().max(500),
  domain: z.string().max(500).nullable().optional(),
  /** The tool's launch endpoint. Only its host is read; it is never requested. */
  url: z.string().max(4000).nullable().optional(),
  course_navigation: z.unknown().optional(),
});
export const moduleWithItemsSchema = moduleSchema.extend({
  items: z.array(itemSchema).max(2000).optional(),
  items_url: z.string().max(4000).optional(),
});
export type CanvasTab = z.infer<typeof tabSchema>;
export type CanvasExternalTool = z.infer<typeof externalToolSchema>;
export type CanvasModuleWithItems = z.infer<typeof moduleWithItemsSchema>;

/** Origin plus path, lowercased host; undefined for anything but http(s). */
export function spaceUrl(input: string, base?: string): string | undefined {
  try {
    const url = new URL(input, base);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      return undefined;
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname}`;
  } catch {
    return undefined;
  }
}
/**
 * D37's module signal: a hash of the course's module items (Canvas documents no `updated_at`
 * on modules or module items). Order-independent; moves when an item is added, removed,
 * retitled, re-pointed or re-dated.
 */
export function moduleItemsHash(modules: CanvasModuleWithItems[]): string {
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
  return hashCanvas(rows.sort().join("\n"));
}

const internalTabs: Record<string, { kind: SpaceKind; scope: string }> = {
  home: { kind: "canvas_tab", scope: "course" },
  announcements: { kind: "canvas_discussion", scope: "announcements" },
  assignments: { kind: "canvas_assignment", scope: "assignments" },
  discussions: { kind: "canvas_discussion", scope: "discussions" },
  pages: { kind: "canvas_page", scope: "pages" },
  files: { kind: "canvas_file", scope: "files" },
  syllabus: { kind: "syllabus", scope: "syllabus" },
  quizzes: { kind: "canvas_quiz", scope: "quizzes" },
  modules: { kind: "canvas_tab", scope: "modules" },
};
const itemKinds: Record<string, SpaceKind> = {
  Page: "canvas_page",
  File: "canvas_file",
  Assignment: "canvas_assignment",
  Quiz: "canvas_quiz",
  Discussion: "canvas_discussion",
};
export interface InventoryParts {
  origin: string;
  courseId: string;
  tabs: CanvasTab[];
  tools: CanvasExternalTool[];
  modules: CanvasModuleWithItems[];
  /** Stored resources of this course (syllabus, pages, assignments, announcements, discussions). */
  resources: Pick<Resource, "externalId" | "kind" | "url" | "links" | "title" | "text" | "deleted" | "document">[];
}
const pending: SpaceAccess = { state: "readable", checkedAt: null, action: "none" };
/** Builds the inventory from what Canvas returned. Pure; the access state is set by the check. */
export function buildInventory(parts: InventoryParts): CourseSpace[] {
  const { origin, courseId } = parts;
  const canvasHost = new URL(origin).host.toLowerCase();
  const spaces = new Map<string, CourseSpace>();
  const stored = new Map<string, (typeof parts.resources)[number]>();
  for (const r of parts.resources) {
    const key = r.deleted ? undefined : spaceUrl(r.url);
    if (key && (r.text.trim() || r.document) && !stored.has(key)) stored.set(key, r);
  }
  const toolHost = new Map<string, string>();
  for (const tool of parts.tools) {
    const host = (() => {
      try {
        return new URL(tool.url ?? "").hostname.toLowerCase();
      } catch {
        return (tool.domain ?? "").toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
      }
    })();
    if (host) toolHost.set(tool.id, host);
  }
  function add(
    space: Omit<CourseSpace, "id" | "courseId" | "access" | "readState" | "jev" | "route" | "treatment" | "host"> &
      Partial<Pick<CourseSpace, "route" | "treatment" | "jev" | "host">>,
  ) {
    const url = spaceUrl(space.url);
    if (!url || spaces.has(url)) return;
    const host = space.host ?? new URL(url).host.toLowerCase();
    const onCanvas = host === canvasHost || host === CANVAS_HOST;
    const hostClass = classifyHost(host);
    const route = space.route ?? (onCanvas ? "canvas_session" : hostClass.rule.route);
    const treatment = space.treatment ?? (onCanvas ? "store" : hostClass.rule.treatment);
    spaces.set(url, {
      ...space,
      id: hashCanvas(`${courseId}\n${url}`).slice(0, 24),
      courseId,
      host,
      url,
      route,
      treatment,
      jev: space.jev ?? (!onCanvas && hostClass.jev),
      ...(onCanvas || hostClass.jev ? {} : { platform: hostClass.rule.name }),
      ...(!space.launchEffect && hostClass.rule.launchEffect && !onCanvas
        ? { launchEffect: hostClass.rule.launchEffect }
        : {}),
      readState: treatment === "link" ? "linked" : stored.has(url) ? "read" : "unread",
      access: { ...pending },
    });
  }
  function tool(toolId: string | undefined, fallbackHost?: string) {
    const host = (toolId && toolHost.get(toolId)) || fallbackHost || "";
    const known = host ? classifyHost(host) : undefined;
    return {
      kind: known && !known.jev ? known.rule.kind : ("lti_tool" as SpaceKind),
      ...(known && !known.jev ? { platform: known.rule.name } : {}),
      ...(known?.rule.launchEffect ? { launchEffect: known.rule.launchEffect } : {}),
      jev: !known || known.jev,
    };
  }
  // 1. Navigation tabs. An LTI tab is a link card to its Canvas tab page; its `url` is never used.
  for (const tab of [...parts.tabs].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    if (tab.hidden || tab.unused) continue;
    const page = tab.html_url ?? tab.full_url;
    if (!page) continue;
    if (tab.type === "external") {
      const toolId = tab.id.match(/^context_external_tool_(\d+)$/)?.[1];
      const t = tool(toolId);
      add({
        ...t,
        host: canvasHost,
        url: new URL(page, origin).href,
        foundIn: "tab",
        foundAt: tab.id,
        label: tab.label,
        route: "lti_launch",
        treatment: "link",
      });
      continue;
    }
    const internal = internalTabs[tab.id];
    if (!internal) continue;
    add({
      kind: internal.kind,
      url: new URL(page, origin).href,
      foundIn: "tab",
      foundAt: tab.id,
      label: tab.label,
    });
  }
  // 2. Installed tools not already reached through a tab (for example, assignment-level tools).
  for (const t of parts.tools) {
    const url = `${origin}/courses/${courseId}/external_tools/${t.id}`;
    add({
      ...tool(t.id),
      host: canvasHost,
      url,
      foundIn: "external_tool",
      foundAt: t.id,
      label: t.name,
      route: "lti_launch",
      treatment: "link",
    });
  }
  // 3. Module items by type.
  for (const module of parts.modules) {
    for (const item of module.items ?? []) {
      const details = item.content_details;
      const dated = {
        ...(details?.due_at !== undefined ? { dueAt: details.due_at } : {}),
        ...(details?.points_possible !== undefined ? { points: details.points_possible } : {}),
      };
      if (item.type === "SubHeader") continue;
      if (item.type === "ExternalTool") {
        // The item's html_url redirects into the launch; it is a link card, never requested.
        let host: string | undefined;
        try {
          host = new URL(item.external_url ?? "").hostname.toLowerCase();
        } catch {}
        add({
          ...tool(undefined, host),
          host: canvasHost,
          url: `${origin}/courses/${courseId}/modules/items/${item.id}`,
          foundIn: "module_item",
          foundAt: item.id,
          label: item.title,
          route: "lti_launch",
          treatment: "link",
          ...dated,
        });
        continue;
      }
      if (item.type === "ExternalUrl") {
        if (!item.external_url) continue;
        const url = spaceUrl(item.external_url);
        if (!url) continue;
        const host = new URL(url).host.toLowerCase();
        const onCanvas = host === canvasHost;
        const known = classifyHost(host);
        add({
          kind: onCanvas ? "canvas_page" : known.rule.kind,
          url,
          foundIn: "module_item",
          foundAt: item.id,
          label: item.title,
          ...(isLaunchUrl(url) ? { route: "lti_launch" as const, treatment: "link" as const, kind: "lti_tool" as const } : {}),
          ...dated,
        });
        continue;
      }
      const kind = itemKinds[item.type];
      if (!kind) continue;
      const url =
        item.type === "Page" && item.page_url
          ? `${origin}/courses/${courseId}/pages/${item.page_url}`
          : item.type === "File" && item.content_id
            ? `${origin}/courses/${courseId}/files/${item.content_id}`
            : item.type === "Assignment" && item.content_id
              ? `${origin}/courses/${courseId}/assignments/${item.content_id}`
              : item.type === "Quiz" && item.content_id
                ? `${origin}/courses/${courseId}/quizzes/${item.content_id}`
                : item.type === "Discussion" && item.content_id
                  ? `${origin}/courses/${courseId}/discussion_topics/${item.content_id}`
                  : undefined;
      if (!url) continue;
      add({ kind, url, foundIn: "module_item", foundAt: item.id, label: item.title, ...dated });
    }
  }
  // 4. The syllabus, then links found in stored bodies.
  const bodies = [...parts.resources].sort(
    (a, b) => Number(b.externalId === "syllabus") - Number(a.externalId === "syllabus"),
  );
  for (const r of bodies) {
    if (r.deleted) continue;
    const foundIn: SpaceFoundIn = r.externalId === "syllabus" ? "syllabus" : "body";
    for (const link of r.links ?? []) {
      const raw = typeof link === "string" ? link : link.url;
      const url = spaceUrl(raw);
      if (!url) continue;
      const parsed = new URL(url);
      const host = parsed.host.toLowerCase();
      if (host === canvasHost) {
        const path = parsed.pathname;
        if (isLaunchUrl(url)) {
          add({ kind: "lti_tool", url, foundIn, foundAt: r.externalId, label: "Course tool", route: "lti_launch", treatment: "link", jev: true });
          continue;
        }
        const own = new RegExp(`^/courses/${courseId}/(pages|files|assignments|quizzes|discussion_topics)/[^/]+$`).exec(path);
        const file = /^\/files\/\d+$/.test(path);
        if (!own && !file) continue;
        const kinds: Record<string, SpaceKind> = {
          pages: "canvas_page",
          files: "canvas_file",
          assignments: "canvas_assignment",
          quizzes: "canvas_quiz",
          discussion_topics: "canvas_discussion",
        };
        add({ kind: own ? kinds[own[1]!]! : "canvas_file", url, foundIn, foundAt: r.externalId, label: r.title });
        continue;
      }
      const known = classifyHost(host);
      add({
        kind: known.rule.kind,
        url,
        foundIn,
        foundAt: r.externalId,
        label: known.jev ? host : `${known.rule.name}`,
      });
    }
  }
  return [...spaces.values()];
}
async function list<T>(
  http: CanvasHttp,
  url: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T[]> {
  const items: T[] = [];
  const initial = url,
    seen = new Set<string>();
  let next: string | null = url;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    if (seen.has(next)) throw new CanvasFailure("partial", "pagination_cycle");
    seen.add(next);
    const response = await http.request(next, signal);
    if (!Array.isArray(response.data)) throw new CanvasFailure("partial", "expected_array");
    for (const row of response.data) {
      const parsed = schema.safeParse(row);
      if (parsed.success) items.push(parsed.data);
    }
    next = canvasNextPage(response.link, next, initial, http.origin);
  }
  if (next) throw new CanvasFailure("partial", "page_limit");
  return items;
}
export interface InventoryRead {
  spaces: CourseSpace[];
  /** ok: every list read; partial: some list failed (its spaces are missing, not deleted). */
  status: "ok" | "partial" | "needs_sign_in";
  /** D37: the module-items hash from the same read, so the probe's baseline costs nothing extra. */
  moduleHash?: string;
  /** Per list: why it failed, for coverage. */
  failures: Record<string, string>;
}
/**
 * Reads one course's inventory: tabs, installed tools and modules with items (3 requests,
 * plus pagination and any module whose items Canvas omitted). GET only, through the reader.
 */
export async function readCanvasInventory(
  http: CanvasHttp,
  course: { id: string },
  resources: InventoryParts["resources"],
  signal?: AbortSignal,
): Promise<InventoryRead> {
  const prefix = `${http.origin}/api/v1/courses/${course.id}`;
  const failures: Record<string, string> = {};
  async function attempt<T>(name: string, read: () => Promise<T[]>): Promise<T[]> {
    try {
      return await read();
    } catch (error) {
      signal?.throwIfAborted();
      failures[name] =
        error instanceof CanvasFailure ? `${error.status}:${error.code}` : "request_failed";
      return [];
    }
  }
  const [tabs, tools, modules] = await Promise.all([
    attempt("tabs", () => list(http, `${prefix}/tabs`, tabSchema, signal)),
    attempt("external_tools", () =>
      list(http, `${prefix}/external_tools?per_page=100`, externalToolSchema, signal),
    ),
    attempt("modules", () =>
      list(
        http,
        `${prefix}/modules?per_page=100&include[]=items&include[]=content_details`,
        moduleWithItemsSchema,
        signal,
      ),
    ),
  ]);
  // Canvas omits `items` for a module with many items; read those modules' items directly.
  for (const module of modules) {
    if (module.items || http.needsSignIn) continue;
    module.items = await attempt(`module:${module.id}`, () =>
      list(
        http,
        `${prefix}/modules/${module.id}/items?per_page=100&include[]=content_details`,
        itemSchema,
        signal,
      ),
    );
  }
  return {
    spaces: buildInventory({ origin: http.origin, courseId: course.id, tabs, tools, modules, resources }),
    status: http.needsSignIn ? "needs_sign_in" : Object.keys(failures).length ? "partial" : "ok",
    ...(failures.modules ? {} : { moduleHash: moduleItemsHash(modules) }),
    failures,
  };
}

/** One access check's transport result: status, the redirect target (origin and path) and a bounded body. */
export interface AccessResponse {
  status: number;
  location?: string | null;
  body?: string;
}
export type AccessTransport = (url: string, signal?: AbortSignal) => Promise<AccessResponse>;
export interface AccessDeps {
  /** One GET in the app's UW session: main's `source-fetch` service "space", redirects not followed. */
  session?: AccessTransport;
  /** One GET with no credentials: the worker's public client, redirects not followed. */
  public?: AccessTransport;
  /** A Canvas space's state from what the Canvas reader already knows (no request). */
  canvas(space: CourseSpace): Pick<SpaceAccess, "state" | "reason">;
  now(): Date;
  signal?: AbortSignal;
  /** Which spaces to (re)check; the rest keep their state. Default: all. */
  only?(space: CourseSpace): boolean;
  concurrency?: number;
}
function actionFor(space: CourseSpace, state: SpaceAccessState): SpaceAction {
  const rule = classifyHost(space.host).rule;
  if (state === "readable" || state === "blocked") return "none";
  // Honorlock gets no button: its launch starts proctoring (the host table marks it unopenable).
  if (space.route === "lti_launch" || space.route === "own_login")
    return space.kind === "proctoring" || rule.openable === false
      ? "none"
      : "open_in_browser";
  if (state === "needs-uw-signin")
    return rule.signIn === "app_window" || space.route === "canvas_session"
      ? "sign_in_app_window"
      : "open_in_browser";
  if (state === "link-only") return rule.openable === false ? "none" : "open_in_browser";
  return "open_in_browser";
}
function classifyResponse(
  space: CourseSpace,
  response: AccessResponse,
): Pick<SpaceAccess, "state" | "reason"> {
  const { status } = response;
  const uw = space.route === "uw_session" || /(?:^|\.)wisc\.edu$/.test(space.host);
  if (status >= 300 && status < 400)
    return isSignInTarget(response.location, space.url)
      ? { state: "needs-uw-signin", reason: "redirected_to_sign_in" }
      : { state: "readable", reason: "redirects" };
  if (status >= 200 && status < 300)
    return response.body && isLoginHtml(response.body)
      ? { state: "needs-uw-signin", reason: "sign_in_page" }
      : { state: "readable" };
  if (status === 401 || status === 403)
    return uw
      ? { state: "needs-uw-signin", reason: `http_${status}` }
      : { state: "blocked", reason: `http_${status}` };
  if (status === 404 || status === 410) return { state: "blocked", reason: "not_found" };
  return { state: "blocked", reason: `http_${status}` };
}
/** Decides a space's state with no request where the host table already knows the answer. */
function staticAccess(space: CourseSpace): Pick<SpaceAccess, "state" | "reason"> | undefined {
  if (space.route === "lti_launch" || space.kind === "lti_tool" || isLaunchUrl(space.url))
    return { state: "link-only", reason: "lti_tool_never_launched" };
  if (space.route === "own_login") return { state: "needs-own-login", reason: "own_account" };
  const rule = classifyHost(space.host).rule;
  if (space.route !== "canvas_session" && rule.check === "none")
    return { state: "link-only", reason: "opens_in_browser" };
  return undefined;
}
/**
 * D41: sets each space's access state. LTI tools, own-login platforms and link-only hosts are
 * decided from the host table with no request; Canvas spaces from the reader's own results;
 * the rest with one plain GET (redirects not followed). A failed check is `blocked`, never
 * a silent "readable".
 */
export async function checkSpaceAccess(
  spaces: CourseSpace[],
  deps: AccessDeps,
): Promise<CourseSpace[]> {
  const out = spaces.map((space) => ({ ...space, access: { ...space.access } }));
  const queue = out.filter((space) => deps.only?.(space) ?? true);
  let index = 0;
  async function worker() {
    for (;;) {
      const space = queue[index++];
      if (!space) return;
      deps.signal?.throwIfAborted();
      let decided = staticAccess(space);
      if (!decided && space.route === "canvas_session") decided = deps.canvas(space);
      if (!decided) {
        const rule = classifyHost(space.host).rule;
        const transport = rule.check === "session" ? deps.session : deps.public;
        if (!transport) decided = { state: "blocked", reason: "no_route_to_check" };
        else
          try {
            decided = classifyResponse(space, await transport(space.url, deps.signal));
          } catch (error) {
            deps.signal?.throwIfAborted();
            decided = {
              state: "blocked",
              reason: error instanceof MaterialReadError ? error.code : "unreachable",
            };
          }
      }
      space.access = {
        state: decided.state,
        ...(decided.reason ? { reason: decided.reason } : {}),
        checkedAt: deps.now().toISOString(),
        action: actionFor(space, decided.state),
      };
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(deps.concurrency ?? 4, queue.length)) }, worker),
  );
  return out;
}
/** Adapts the worker's public client: one GET, the redirect reported instead of followed. */
export function publicAccessTransport(client: PublicClient): AccessTransport {
  return async (url, signal) => {
    let moved: string | undefined;
    try {
      const read = await client.text(url, {
        ...(signal ? { signal } : {}),
        maxBytes: 256 * 1024,
        onRedirect: (target) => {
          moved = target;
          return false;
        },
      });
      return { status: read.response.status, body: read.text };
    } catch (error) {
      if (moved) return { status: 302, location: moved };
      if (error instanceof MaterialReadError && error.code === "inaccessible")
        return { status: 403 };
      if (error instanceof MaterialReadError && error.code === "not_found")
        return { status: 404 };
      throw error;
    }
  };
}
export interface CourseAccessSummary {
  courseId: string;
  counts: Record<SpaceAccessState, number>;
  /** Spaces that need the student's sign-in: UW sign-in plus their own logins. */
  needSignIn: number;
  /** The indicator chip, or null when nothing needs attention. */
  chip: string | null;
  /** The actionable list for "Connect this course": what needs a sign-in, then link-only tools. */
  actions: {
    spaceId: string;
    label: string;
    host: string;
    url: string;
    state: SpaceAccessState;
    action: SpaceAction;
    reason?: string;
    launchEffect?: string;
  }[];
}
/** D41's indicator, per course. Pure: counts and the actionable list from stored states. */
export function accessSummary(spaces: CourseSpace[]): CourseAccessSummary[] {
  const byCourse = new Map<string, CourseSpace[]>();
  for (const space of spaces) {
    const list = byCourse.get(space.courseId) ?? [];
    list.push(space);
    byCourse.set(space.courseId, list);
  }
  const order: SpaceAccessState[] = ["needs-uw-signin", "needs-own-login", "link-only", "blocked"];
  return [...byCourse.entries()].map(([courseId, list]) => {
    const counts: Record<SpaceAccessState, number> = {
      readable: 0,
      "needs-uw-signin": 0,
      "needs-own-login": 0,
      "link-only": 0,
      blocked: 0,
    };
    for (const space of list) counts[space.access.state]++;
    const needSignIn = counts["needs-uw-signin"] + counts["needs-own-login"];
    const chip = needSignIn
      ? `${needSignIn} source${needSignIn === 1 ? " needs" : "s need"} a sign-in`
      : counts.blocked
        ? `${counts.blocked} source${counts.blocked === 1 ? "" : "s"} couldn't be read`
        : null;
    const actions = list
      .filter((space) => space.access.state !== "readable")
      .sort(
        (a, b) =>
          order.indexOf(a.access.state) - order.indexOf(b.access.state) ||
          a.label.localeCompare(b.label),
      )
      .map((space) => ({
        spaceId: space.id,
        label: space.label,
        host: space.host,
        url: space.url,
        state: space.access.state,
        action: space.access.action,
        ...(space.access.reason ? { reason: space.access.reason } : {}),
        ...(space.launchEffect ? { launchEffect: space.launchEffect } : {}),
      }));
    return { courseId, counts, needSignIn, chip, actions };
  });
}
