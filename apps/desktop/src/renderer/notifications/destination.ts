import type { AppNotification } from "@magic/contracts";

/** Where a notification row leads. Chosen by reason and stable IDs, never by title or position. */
export type NotificationDestination =
  | { kind: "resource"; id: string }
  | { kind: "course"; key: string }
  | { kind: "outlook"; url: string }
  | { kind: "sources" };

export interface DestinationContext {
  /** The saved item as the workspace can show it; undefined when removed, excluded or unknown. */
  resource: (id: string) => { url?: string } | undefined;
  /** The course page key for a source's course, or null when no course page exists for it. */
  courseKey: (sourceId: string, courseId: string) => string | null;
}

/**
 * Sign-in and stale sources go to Connected sources. Email opens its Outlook message (the
 * resource's webLink) and falls back to the saved copy. Coursework opens its detail; an item
 * whose resource is gone (removed, or a grouped drop) opens its course page. Otherwise null:
 * the row stays readable and dismissable but does not pretend to lead anywhere.
 */
export function notificationDestination(item: AppNotification, context: DestinationContext): NotificationDestination | null {
  if (item.reason === "sign_in" || item.reason === "source_stale") return { kind: "sources" };
  const resource = item.resourceId ? context.resource(item.resourceId) : undefined;
  if (item.reason === "email") {
    const url = resource?.url;
    if (url && isHttps(url)) return { kind: "outlook", url };
  }
  if (item.resourceId && resource) return { kind: "resource", id: item.resourceId };
  if (item.sourceId && item.courseId) {
    const key = context.courseKey(item.sourceId, item.courseId);
    if (key) return { kind: "course", key };
  }
  return null;
}

/** Words for assistive technology and the row's trailing hint. */
export function destinationLabel(destination: NotificationDestination | null): string | null {
  switch (destination?.kind) {
    case "outlook": return "Opens in Outlook";
    case "sources": return "Opens Connected sources";
    case "course": return "Opens the course";
    default: return null;
  }
}

function isHttps(url: string): boolean {
  try { return new URL(url).protocol === "https:"; } catch { return false; }
}
