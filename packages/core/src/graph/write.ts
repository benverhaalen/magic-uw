/**
 * The pipeline's writes: one resource's facts and references, or a whole course's. Code only;
 * nothing here is sent anywhere, so planning and coursework never reach Jev or a model from here.
 */
import type { CourseRef } from "../../../contracts/src/course-core";
import { analyzeLinks, analyzeResource, ANALYZER_VERSION, classifyRole, type Role } from "./analyze";
import { courseIndex, type CourseIndex, type PipelineStore, type Res } from "./course-index";

const structural = new Set(["modules", "folders", "assignment-groups", "course", "courses", "calendar_feed"]);

const imageFile = (r: Res) =>
  /^image\//i.test(r.file?.contentType ?? "") || /\.(png|jpe?g|gif|svg|webp|bmp|heic)$/i.test(r.file?.displayName ?? r.title);

/** A resource the categoriser reads: course content, and only the canonical copy of an assignment. */
export function isMaterial(index: CourseIndex, r: Res): boolean {
  const type = index.contentType(r);
  if (!type) return false;
  if (type === "assignment") return index.assignmentById.get(r.externalId)?.id === r.id;
  // An image file outside every module is a page asset (an embedded figure), not course material.
  if (type === "file" && imageFile(r) && !(index.modulesOf.get(r.id) ?? []).length) return false;
  return true;
}
/** A resource whose outgoing links are read. */
export function hasLinks(r: Res): boolean {
  if (structural.has(r.scope.split(":")[0]!) || r.kind === "event") return false;
  return !!(r.text || r.links?.length || r.moduleItem?.externalUrl);
}

export function assessmentsFor(index: CourseIndex, roleOf: Map<string, Role | undefined>): Res[] {
  const out: Res[] = [];
  for (const r of new Set([...index.assignmentById.values(), ...index.quizById.values()])) {
    if (!roleOf.has(r.id)) roleOf.set(r.id, classifyRole(index, r)?.role);
    if (roleOf.get(r.id) === "exam") out.push(r);
  }
  return out;
}

export interface WriteReport {
  facts: number;
  refs: number;
  externals: number;
  errors: string[];
}

export function writeResource(store: PipelineStore, index: CourseIndex, r: Res, assessments: Res[], now: string, report: WriteReport) {
  if (isMaterial(index, r)) {
    const textHash = store.resourceTextHash(r.id);
    if (textHash) {
      const { facts } = analyzeResource(index, r, assessments);
      const result = store.putMaterialFacts({ resourceId: r.id, textHash, analyzerVersion: ANALYZER_VERSION, facts });
      if (result.ok) report.facts += facts.length;
      else report.errors.push(...result.errors.slice(0, 3));
    }
  }
  if (hasLinks(r)) {
    const { refs } = analyzeLinks(index, r);
    const rows = refs.map(({ external, ...ref }) => {
      if (!external) return ref;
      report.externals++;
      const id = store.putExternalRef({ sourceId: r.sourceId, ...external, foundInResourceId: r.id }, now);
      return { ...ref, externalRefId: id };
    });
    const result = store.putResourceRefs(r.id, r.contentHash, rows);
    if (result.ok) report.refs += rows.length;
    else report.errors.push(...result.errors.slice(0, 3));
  }
}

/** The link job: one resource against its course's current index. */
export function linkResource(store: PipelineStore, course: CourseRef, resourceId: string, now: string): WriteReport {
  const report: WriteReport = { facts: 0, refs: 0, externals: 0, errors: [] };
  const index = courseIndex(store, course);
  const r = index.resources.get(resourceId);
  if (!r) return report;
  writeResource(store, index, r, assessmentsFor(index, new Map()), now, report);
  return report;
}

const yieldToEvents = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The course pass: every resource of the course, so links to targets captured later resolve.
 * Yields to the event loop every `chunk` resources, so a large course never blocks the worker.
 */
export async function compileCourse(store: PipelineStore, course: CourseRef, now: string, chunk = 50): Promise<WriteReport> {
  const report: WriteReport = { facts: 0, refs: 0, externals: 0, errors: [] };
  const index = courseIndex(store, course);
  const roleOf = new Map<string, Role | undefined>();
  const assessments = assessmentsFor(index, roleOf);
  let n = 0;
  for (const r of index.resources.values()) {
    if (!store.resource(r.id)) continue; // deleted while the pass yielded
    writeResource(store, index, r, assessments, now, report);
    if (++n % chunk === 0) await yieldToEvents();
  }
  return report;
}
