import { createHash } from "node:crypto";
import type { Store, Resource, DeadlineClaim } from "@magic/contracts";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function normalized(url: string) {
  try {
    const u = new URL(url);
    u.hash = "";
    if (
      u.origin === "https://canvas.wisc.edu" &&
      /^\/(courses\/\d+\/)?files\/\d+(\/download)?$/.test(u.pathname)
    ) {
      u.search = "";
      u.pathname = u.pathname.replace(/\/download$/, "");
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
    `${sources.get(r.sourceId)?.accountScope}:${r.courseId}:${normalized(url)}`;
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
export function evidenceFor(store: Store) {
  const resources = store.resources().filter((r) => !r.deleted),
    byId = new Map(resources.map((r) => [r.id, r]));
  const links = store
    .links()
    .filter(
      (l) => l.status === "accepted" && byId.has(l.fromId) && byId.has(l.toId),
    );
  return {
    deadlines(resource: Resource): DeadlineClaim[] {
      return [
        ...resource.deadlines,
        ...links
          .filter((l) => l.type === "same_as" && l.toId === resource.id)
          .flatMap((l) =>
            byId.get(l.fromId)?.calendar ? byId.get(l.fromId)!.deadlines : [],
          ),
      ];
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
