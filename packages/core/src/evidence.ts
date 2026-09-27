import { createHash } from "node:crypto";
import type {
  Store,
  Resource,
  DeadlineEvidenceClaim,
  UnresolvedDeadlineMention,
} from "@magic/contracts";
import { proseDeadlines } from "./deadline-evidence";
import { localTime } from "@magic/domain";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function normalized(url: string, courseId: string) {
  try {
    const u = new URL(url);
    u.hash = "";
    const scopedCourse = /^\/courses\/(\d+)\/files\//.exec(u.pathname)?.[1];
    if (scopedCourse && scopedCourse !== courseId) return u.href;
    if (
      u.origin === "https://canvas.wisc.edu" &&
      /^\/(courses\/\d+\/)?files\/\d+(\/(?:download|preview))?$/.test(u.pathname)
    ) {
      u.search = "";
      u.pathname = u.pathname.replace(/\/(?:download|preview)$/, "").replace(/^\/courses\/\d+/, "");
    }
    return u.href;
  } catch {
    return url;
  }
}
/** Exact, same-account/course evidence only. Student rejections survive later re-reads. */
export function linkExactEvidence(store: Store) {
  const resources = store.resources().filter((r) => !r.deleted),
    sources = new Map(store.sources().map((s) => [s.id, s]));
  const key = (r: Resource, url = r.url) =>
    `${sources.get(r.sourceId)?.accountScope}:${r.courseId}:${normalized(url, r.courseId)}`;
  const byUrl = new Map<string, Resource[]>();
  for (const r of resources) {
    const k = key(r);
    byUrl.set(k, [...(byUrl.get(k) ?? []), r]);
  }
  function link(
    from: Resource,
    to: Resource,
    type: "specifies" | "same_as",
    reason: string,
  ) {
    if (from.id === to.id) return;
    const id = `exact:${hash(`${from.id}:${to.id}:${type}`)}`;
    if (store.links().some((l) => l.id === id && l.status === "rejected"))
      return;
    store.putLink({
      id,
      fromId: from.id,
      toId: to.id,
      type,
      reason,
      status: "accepted",
      inputHash: from.contentHash,
    });
  }
  for (const resource of resources) {
    if (resource.calendar?.assignmentExternalId) {
      const target = resources.find(
        (r) =>
          r.kind === "assignment" &&
          r.externalId === resource.calendar?.assignmentExternalId &&
          r.courseId === resource.courseId &&
          sources.get(r.sourceId)?.accountScope ===
            sources.get(resource.sourceId)?.accountScope &&
          sources.get(r.sourceId)?.scope === "assignments",
      );
      if (target)
        link(
          resource,
          target,
          "same_as",
          "Calendar URL contains this exact Canvas course and assignment ID; independent date claims are preserved.",
        );
    }
    for (const pointer of resource.links ?? [])
      for (const target of byUrl.get(
        key(resource, typeof pointer === "string" ? pointer : pointer.url),
      ) ?? []) {
        if (target.kind === "material" && target.text)
          link(
            target,
            resource,
            "specifies",
            "The saved source directly links this material URL in the same course and account.",
          );
      }
  }
}
export function evidenceFor(store: Store, permitted: (resource: Resource) => boolean = () => true, allResources: Resource[] = store.resources()) {
  const resources = allResources.filter((r) => !r.deleted && permitted(r)),
    byId = new Map(resources.map((r) => [r.id, r]));
  const sources = new Map(store.sources().map((source) => [source.id, source]));
  const allLinks = store.links();
  const blocked = new Set<string>();
  for (const link of allLinks) if (link.type === "same_as" && (link.status !== "accepted" || byId.get(link.fromId)?.contentHash !== link.inputHash)) {
    blocked.add(link.fromId); blocked.add(link.toId);
  }
  const assignmentKey = (resource: Resource, providerId: string): string | null => {
    const account = sources.get(resource.sourceId)?.accountScope;
    return account && resource.courseId && providerId ? JSON.stringify([account, resource.courseId, providerId]) : null;
  };
  const canvasUrl = (value: string) => {
    try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "canvas.wisc.edu"; }
    catch { return false; }
  };
  const assignments = new Map<string, Resource>();
  for (const resource of resources) {
    const source = sources.get(resource.sourceId);
    if (blocked.has(resource.id) || resource.kind !== "assignment" || source?.scope !== "assignments" ||
        !["canvas", "fixture"].includes(source.kind) || !canvasUrl(resource.url)) continue;
    try {
      const match = /^\/courses\/([^/]+)\/assignments\/([^/]+)\/?$/.exec(new URL(resource.url).pathname);
      const key = match && decodeURIComponent(match[1]!) === resource.courseId && assignmentKey(resource, decodeURIComponent(match[2]!));
      if (key) assignments.set(key, resource);
    } catch { /* An invalid URL cannot establish provider identity. */ }
  }
  const exactContributors = new Map<string, Resource[]>();
  for (const resource of resources) {
    if (blocked.has(resource.id)) continue;
    const source = sources.get(resource.sourceId);
    const scope = source?.scope;
    if (!source || !canvasUrl(resource.url) ||
        !(resource.kind === "event" && scope === "calendar_feed" && ["calendar", "fixture"].includes(source.kind)) &&
        !(scope?.split(":")[0] === "module-items" && ["canvas", "fixture"].includes(source.kind))) continue;
    let providerId: string | null = null;
    if (resource.kind === "event" && scope === "calendar_feed" && resource.calendar) {
      const explicit = resource.calendar.assignmentExternalId;
      const uid = /^event-assignment-(\d+)$/.exec(resource.calendar.uid)?.[1];
      if (explicit && uid && explicit !== uid) continue;
      providerId = explicit ?? uid ?? null;
    } else if (scope?.split(":")[0] === "module-items" && resource.moduleItem?.type === "Assignment") {
      providerId = resource.moduleItem.contentId ?? null;
    }
    if (!providerId) continue;
    const key = assignmentKey(resource, providerId);
    const target = key && assignments.get(key);
    if (target && target.id !== resource.id) exactContributors.set(target.id, [...(exactContributors.get(target.id) ?? []), resource]);
  }
  const links = allLinks
    .filter(
      (l) => l.status === "accepted" && byId.has(l.fromId) && byId.has(l.toId),
    );
  const prose = proseDeadlines(
    resources,
    sources,
  );
  const feedClaim = (resource: Resource): DeadlineEvidenceClaim[] => {
    const calendar = resource.calendar;
    if (!calendar?.start || resource.kind !== "event" || !Number.isFinite(Date.parse(calendar.start))) return [];
    const day = calendar.allDay || /^\d{4}-\d{2}-\d{2}$/.test(calendar.start);
    let value = calendar.start;
    if (day) {
      const date = calendar.start.slice(0, 10);
      let lo = Date.parse(`${date}T12:00:00Z`) - 36 * 3600000, hi = lo + 72 * 3600000;
      while (hi - lo > 1) {
        const mid = Math.floor((hi + lo) / 2);
        if (localTime(new Date(mid).toISOString(), "America/Chicago").date < date) lo = mid; else hi = mid;
      }
      value = new Date(hi).toISOString();
    }
    return [{ kind: "due", value, precision: day ? "day" : "minute", authority: "structured", origin: "calendar", scopeConfirmed: true,
      quote: `Calendar DTSTART: ${calendar.start}`, note: `Saved calendar record ${resource.id}. Assignment association uses its provider identifier.` }];
  };
  return {
    contributors(resource: Resource): Resource[] {
      const ids = new Set([resource.id, ...(exactContributors.get(resource.id) ?? []).map(r => r.id), ...links.filter((l) => l.type === "same_as" && l.toId === resource.id).map((l) => l.fromId), ...prose(resource).claims.flatMap((c) => c.span ? [c.span.resourceId] : []), ...prose(resource).unresolved.map((c) => c.span.resourceId)]);
      return resources.filter((r) => ids.has(r.id));
    },
    deadlines(resource: Resource): DeadlineEvidenceClaim[] {
      return [
        ...resource.deadlines.map((c) => ({
          ...c,
          origin: resource.calendar ? ("calendar" as const) : ("canvas" as const),
        })),
        ...(exactContributors.get(resource.id) ?? []).flatMap(contributor => contributor.kind === "event"
          ? feedClaim(contributor)
          : contributor.deadlines.map(claim => ({ ...claim, origin: "canvas" as const }))),
        ...links
          .filter((l) => l.type === "same_as" && l.toId === resource.id)
          .flatMap((l) =>
            byId.get(l.fromId)?.calendar ? byId.get(l.fromId)!.deadlines : [],
          )
          .map((c) => ({ ...c, origin: "calendar" as const })),
        ...prose(resource).claims,
      ];
    },
    /** Deadline phrases in scoped prose that could not be pinned to a date. */
    unresolvedDeadlines(resource: Resource): UnresolvedDeadlineMention[] {
      return prose(resource).unresolved;
    },
    supporting(resource: Resource) {
      const seen = new Set([resource.id]),
        found: Resource[] = [];
      let frontier = [resource.id];
      for (let depth = 0; depth < 2; depth++) {
        const next: string[] = [];
        for (const id of frontier)
          for (const link of links.filter(
            (l) => l.toId === id && l.type === "specifies",
          )) {
            const r = byId.get(link.fromId)!;
            if (!seen.has(r.id)) {
              seen.add(r.id);
              found.push(r);
              next.push(r.id);
            }
          }
        frontier = next;
      }
      return found;
    },
  };
}
