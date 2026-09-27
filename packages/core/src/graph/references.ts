/**
 * `references(assignmentId)`: exactly the materials an assignment points at, by deterministic
 * reasons. Recall first for what the assignment itself says: every body link and every course file
 * or page named in the body is always kept. Module siblings only when they're course material (not
 * admin, not another task). Nothing from another module unless the body links or names it.
 */
import type { Reference, ReferenceStrength } from "../../../contracts/src/course-core";
import { analyzeLinks, classifyRole } from "./analyze";
import { courseOfSource, graphCall, type CourseIndex, type GraphCall, type PipelineStore, type Res } from "./course-index";
import { hasLinks } from "./write";

export type { Reference };
export const strengthWeight: Record<ReferenceStrength, number> = { direct: 1, named: 0.8, module: 0.5, syllabus: 0.4, covers: 0.45 };
/** A covers fact read from structure (the same module), not quoted from a title or text: ranked last. */
export const STRUCTURE_COVERS_WEIGHT = 0.3;
const taskTypes = new Set(["Assignment", "Quiz", "Discussion", "SubHeader"]);

/** The assignment behind an ID: the canonical copy, whichever captured copy (or module item) was named. */
export function canonicalAssessment(index: CourseIndex, r: Res): Res {
  if (r.moduleItem && (r.moduleItem.type === "Assignment" || r.moduleItem.type === "Quiz")) return index.itemTarget(r) ?? r;
  return (r.kind === "assignment" ? index.assignmentById.get(r.externalId) : undefined) ?? r;
}

/** Name variants an instructor writes for the same assignment ("Homework 3", "HW 3", "HW3"). */
function namePatterns(title: string): RegExp[] {
  const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = [new RegExp(`(?<![a-z0-9])${escape(title.trim()).replace(/\s+/g, "\\s+")}(?![a-z0-9])`, "i")];
  const m = /^(.*?)(?:\s*#?\s*)(\d{1,3})\b/.exec(title.trim());
  if (m && m[1]) {
    const word = m[1].trim().toLowerCase();
    const n = m[2];
    const forms = new Set([escape(word)]);
    if (/^home\s*work$/.test(word)) forms.add("hw");
    if (/^problem\s*set$/.test(word)) ["ps", "pset"].forEach((f) => forms.add(f));
    if (/^lab(oratory)?$/.test(word)) forms.add("lab");
    if (/^project$/.test(word)) ["proj", "p"].forEach((f) => forms.add(f));
    if (/^quiz$/.test(word)) forms.add("quiz");
    if (/^(exam|midterm)$/.test(word)) forms.add(word);
    for (const f of forms) out.push(new RegExp(`(?<![a-z0-9])${f.replace(/\s+/g, "\\s*")}\\s*#?\\s*0?${n}(?![0-9])`, "i"));
  }
  return out;
}

const liveTitle = (ref: object): string | undefined =>
  "external" in ref ? ((ref as { external?: { title: string | null } }).external?.title ?? undefined) : undefined;

/** `call` shares the course's reads across one caller's many assignments (see `graphCall`). */
export function references(store: PipelineStore, assignmentId: string, call: GraphCall = graphCall(store)): Reference[] {
  const found = store.resource(assignmentId);
  if (!found || found.deleted) return [];
  const course = courseOfSource(store, found.sourceId);
  if (!course) return [];
  const index = call.index(course);
  const self = index.resources.get(assignmentId);
  if (!self) return [];
  const a = canonicalAssessment(index, self);
  const copies = [...index.resources.values()].filter(
    (r) => r.id === a.id || r.id === self.id || (r.kind === "assignment" && r.externalId === a.externalId),
  );
  const own = new Set(copies.map((r) => r.id));
  const out: Reference[] = [];
  const seen = new Set<string>();
  const externals = new Map(call.externalRefs(course).map((e) => [e.id, e]));
  const add = (ref: Omit<Reference, "weight">, weight = strengthWeight[ref.strength]) => {
    const key = ref.resourceId ?? ref.externalUrl ?? "";
    if (!key || seen.has(key) || (ref.resourceId && own.has(ref.resourceId))) return;
    seen.add(key);
    out.push({ ...ref, weight });
  };
  const moduleMaterial = (moduleId: string, why: string) => {
    const m = index.modules.get(moduleId);
    if (!m) return;
    for (const item of m.items) {
      const type = item.moduleItem?.type ?? "";
      if (taskTypes.has(type)) continue;
      const target = index.itemTarget(item);
      const role = classifyRole(index, target ?? item)?.role;
      if (role === "admin") continue;
      if (target) add({ resourceId: target.id, externalUrl: null, kind: index.contentType(target) ?? "page", title: target.title, reason: why, strength: "module" });
      else if (item.moduleItem?.externalUrl)
        add({ resourceId: null, externalUrl: item.moduleItem.externalUrl, kind: "external", title: item.moduleItem.title ?? item.title, reason: why, strength: "module" });
      else add({ resourceId: item.id, externalUrl: null, kind: type === "File" ? "file" : "page", title: item.title, reason: `${why}; content not captured`, strength: "module" });
    }
  };

  // 1-2. Direct links and named files/pages, from every captured copy of the assignment.
  const linkedModules: string[] = [];
  for (const copy of copies) {
    const stored = call.resourceRefs(copy.id);
    const refs = stored.length || !hasLinks(copy) ? stored : analyzeLinks(index, copy).refs;
    for (const ref of refs) {
      const target = ref.toResourceId ? index.resources.get(ref.toResourceId) : undefined;
      const external = ref.externalRefId ? externals.get(ref.externalRefId) : undefined;
      if (ref.kind === "module" && target?.module) linkedModules.push(target.module.id ?? target.externalId);
      add({
        resourceId: target?.id ?? null,
        externalUrl: target ? null : ref.target,
        kind: ref.kind,
        title: target?.title ?? external?.title ?? liveTitle(ref) ?? ref.target,
        reason: ref.reason,
        strength: ref.strength,
      });
    }
  }
  for (const id of linkedModules) moduleMaterial(id, `in the module "${index.modules.get(id)?.title ?? id}", linked from the body`);

  // 3. Module siblings that are course material.
  const modules = new Set(copies.flatMap((c) => index.modulesOf.get(c.id) ?? []));
  for (const item of index.moduleItemById.values())
    if (item.moduleItem?.contentId === a.externalId && item.moduleItem.type === "Assignment") modules.add(item.scope.slice("module-items:".length));
  for (const id of modules) moduleMaterial(id, `in the same module, "${index.modules.get(id)?.title || id}"`);

  // 4. Syllabus lines that name it.
  const syllabus = index.syllabus;
  if (syllabus?.text) {
    const patterns = namePatterns(a.title);
    const lines = syllabus.text.split("\n").filter((line) => patterns.some((p) => p.test(line)));
    if (lines.length) {
      const first = lines[0]!.trim();
      add({
        resourceId: syllabus.id,
        externalUrl: null,
        kind: "syllabus",
        title: syllabus.title,
        reason: `syllabus names it (${lines.length} line${lines.length > 1 ? "s" : ""}): "${first.length > 160 ? `${first.slice(0, 159)}…` : first}"`,
        strength: "syllabus",
      });
    }
  }
  // 5. Materials whose covers fact names this assessment: quoted (title or text) first, structural last.
  const covering = store
    .coveringFacts([...own])
    .filter((f) => index.resources.has(f.resourceId))
    .sort((x, y) => Number(x.basis === "structure") - Number(y.basis === "structure"));
  for (const f of covering) {
    const target = index.resources.get(f.resourceId)!;
    const quoted = f.basis !== "structure";
    add(
      {
        resourceId: target.id,
        externalUrl: null,
        kind: index.contentType(target) ?? "page",
        title: target.title,
        reason: quoted
          ? `covers it: "${(f.quote ?? "").slice(0, 120)}"`
          : `covers it by module, "${(f.quote ?? "").slice(0, 120)}" (structure, not quoted)`,
        strength: "covers",
      },
      quoted ? strengthWeight.covers : STRUCTURE_COVERS_WEIGHT,
    );
  }
  const rank: Record<ReferenceStrength, number> = { direct: 0, named: 1, module: 2, syllabus: 3, covers: 4 };
  return out
    .map((r, i) => ({ r, i }))
    .sort((x, y) => rank[x.r.strength] - rank[y.r.strength] || y.r.weight - x.r.weight || x.i - y.i)
    .map((x) => x.r);
}
