import { createHash } from "node:crypto";
import type {
  CourseCoreStore,
  CourseSpaceInput,
  Store,
} from "@magic/contracts";
import type { CourseSpace } from "../../../packages/connectors/src/canvas-inventory";

import { canvasFileId } from "../../../packages/connectors/src/canvas-references";

const routes: Record<CourseSpace["route"], CourseSpaceInput["route"]> = {
  public: "public",
  uw_session: "uw-session",
  canvas_session: "canvas-session",
  own_login: "own-login",
  lti_launch: "lti",
};
function safeUrl(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol))
    throw new Error("Invalid space URL.");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}
export function courseSpaceId(
  account: string,
  course: string,
  url: string,
): string {
  return `space:${createHash("sha256")
    .update(JSON.stringify([account, course, safeUrl(url)]))
    .digest("hex")}`;
}
/** Merge observations; a partial inventory never establishes that an earlier space disappeared.
 * Complete is deliberately not deletion authority: this inventory combines several independently
 * observed lists and bodies, so complete route membership needs a narrower producer contract. */
export function persistCourseSpaces(
  store: Store & CourseCoreStore,
  accountScope: string,
  courseId: string,
  spaces: CourseSpace[],
  _complete = false,
): void {
  const sources = store
    .sources()
    .filter((s) => s.accountScope === accountScope && s.courseId === courseId);
  if (!sources.length) return;
  const sourceIds = new Set(sources.map((s) => s.id));
  const resources = store
    .resources()
    .filter((r) => sourceIds.has(r.sourceId) && !r.deleted);
  const previous = new Map(
    store.courseSpaces({ accountScope, courseId }).map((s) => [s.id, s]),
  );
  for (const space of spaces) {
    if (space.courseId !== courseId)
      throw new Error("Inventory belongs to another course.");
    const url = safeUrl(space.url);
    const id = courseSpaceId(accountScope, courseId, url);
    const old = previous.get(id);
    const origins = resources.filter(
      (r) =>
        r.externalId === space.foundAt &&
        (space.foundIn !== "module_item" || r.moduleItem),
    );
    const found = origins.length === 1 ? origins[0] : undefined;
    const fileId = canvasFileId(url, "https://canvas.wisc.edu", courseId);
    const read = resources.find(
      (r) =>
        (safeUrl(r.url) === url ||
          (fileId !== undefined &&
            canvasFileId(r.url, "https://canvas.wisc.edu", courseId) ===
              fileId)) &&
        (r.text.length > 0 || r.document),
    );
    const checkedAt = space.access.checkedAt;
    // An unchecked discovery cannot overwrite a real prior observation.
    const newer =
      checkedAt !== null && (!old?.checkedAt || checkedAt >= old.checkedAt);
    store.putCourseSpace({
      id,
      sourceId: old?.sourceId ?? found?.sourceId ?? sources[0]!.id,
      kind: space.kind,
      host: new URL(url).hostname,
      url,
      title: space.label,
      foundInResourceId: found?.id ?? old?.foundInResourceId ?? null,
      route: routes[space.route],
      readState:
        read || old?.lastReadAt
          ? "read"
          : space.readState === "linked"
            ? "skipped"
            : "found",
      readSourceId: read?.sourceId ?? old?.readSourceId ?? null,
      lastReadAt: read
        ? (read.fieldLastSeen?.text ?? read.capturedAt)
        : (old?.lastReadAt ?? null),
      recipeId: old?.recipeId ?? null,
      accessState: newer ? space.access.state : (old?.accessState ?? "unknown"),
      accessReason: newer
        ? (space.access.reason ?? null)
        : (old?.accessReason ?? null),
      checkedAt: newer ? checkedAt : (old?.checkedAt ?? null),
      storeOrLink: space.treatment,
    });
  }
}
/** Restore access evidence without replacing freshly observed identity/provenance. */
export function hydrateCourseSpaces(
  store: CourseCoreStore,
  accountScope: string,
  courseId: string,
  spaces: CourseSpace[],
): CourseSpace[] {
  const saved = new Map(
    store.courseSpaces({ accountScope, courseId }).map((s) => [s.id, s]),
  );
  return spaces.map((space) => {
    const row = saved.get(courseSpaceId(accountScope, courseId, space.url));
    if (
      !row ||
      (space.access.checkedAt &&
        (!row.checkedAt || space.access.checkedAt >= row.checkedAt))
    )
      return space;
    return {
      ...space,
      readState: row.lastReadAt ? "read" : space.readState,
      access: {
        ...space.access,
        state: row.accessState,
        checkedAt: row.checkedAt,
        reason: row.accessReason ?? undefined,
        action:
          row.accessState === "needs-uw-signin"
            ? "sign_in_app_window"
            : row.accessState === "needs-own-login"
              ? "open_in_browser"
              : "none",
      },
    };
  });
}
