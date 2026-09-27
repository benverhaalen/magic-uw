// A cross-request memo of the references port for course mastery (D57). Building the port's answers
// costs hundreds of milliseconds on a 5,000-resource store (every material's exams walk every
// assignment's references); what they read changes only when the course's captured resources, their
// current references and facts, stored links, course-map assessments or map links change. The memo
// keeps the port's answers while a fingerprint over exactly those reads (~3 ms) is unchanged, and
// drops them the moment it changes. Without the store reads the fingerprint needs, nothing is memoised.
import { createHash } from "node:crypto";
import type { AssessmentLink, ExamDate, MaterialLink, ReferencesPort } from "../router-types";

/** The store reads the fingerprint uses; the desktop store has all of them. */
export interface FingerprintSource {
  courseInventoryHash?(course: { accountScope: string; courseId: string }): string;
  graphCounts?(course: { accountScope: string; courseId: string }): { resourceId: string; passages: number; facts: number; refs: number }[];
  links?(): { id: string; fromId: string; toId: string; status: string; type: string; reason: string }[];
  assessments?(course?: { accountScope: string; courseId: string }): { id: string; updatedAt: string; date: string | null }[];
  mapLinks?(course?: { accountScope: string; courseId: string }): { id: string; status: string; current: boolean }[];
}

export interface ReferencesMemo {
  key: string;
  examDates: Map<string, ExamDate[]>;
  assessmentsFor: Map<string, AssessmentLink[]>;
  references: Map<string, MaterialLink[]>;
  assignment: Map<string, { id: string; title: string; courseId: string } | null>;
}

/** Null when the source can't fingerprint the course (then every request reads the port afresh). */
export function referenceFingerprint(src: FingerprintSource | undefined, course: { accountScope: string; courseId: string }): string | null {
  if (!src?.courseInventoryHash || !src.graphCounts || !src.links || !src.assessments || !src.mapLinks) return null;
  const h = createHash("sha256");
  h.update(src.courseInventoryHash(course));
  for (const c of src.graphCounts(course)) h.update(`${c.resourceId}:${c.passages}:${c.facts}:${c.refs};`);
  for (const l of src.links()) h.update(`${l.id}:${l.fromId}:${l.toId}:${l.status}:${l.type}:${l.reason};`);
  for (const a of src.assessments(course)) h.update(`${a.id}:${a.updatedAt}:${a.date ?? ""};`);
  for (const m of src.mapLinks(course)) h.update(`${m.id}:${m.status}:${m.current};`);
  return h.digest("hex");
}

/** The port, answering from the memo while the fingerprint holds. */
export function memoReferences(port: ReferencesPort, key: string | null, store: Map<string, ReferencesMemo>, courseKey: string): ReferencesPort {
  if (key === null) return port;
  let memo = store.get(courseKey);
  if (!memo || memo.key !== key) {
    memo = { key, examDates: new Map(), assessmentsFor: new Map(), references: new Map(), assignment: new Map() };
    store.set(courseKey, memo);
  }
  const m = memo;
  const cached = <K, V>(map: Map<K, V>, k: K, read: () => V): V => {
    if (map.has(k)) return map.get(k)!;
    const v = read();
    map.set(k, v);
    return v;
  };
  return {
    examDates: (courseId) => cached(m.examDates, courseId, () => port.examDates(courseId)),
    assessmentsFor: (materialId) => cached(m.assessmentsFor, materialId, () => port.assessmentsFor(materialId)),
    references: (assignmentId) => cached(m.references, assignmentId, () => port.references(assignmentId)),
    assignment: (assignmentId) => cached(m.assignment, assignmentId, () => port.assignment(assignmentId)),
  };
}
