/**
 * The course graph (the material pipeline): passages, quoted facts, references and the agenda,
 * all built by code from what ingestion stored. The queries read; only the jobs write.
 */
export { agenda, dayStart, type Agenda, type AgendaEntry, type AgendaGroup, type AgendaInput } from "./agenda";
export { ANALYZER_VERSION, analyzeLinks, analyzeResource, classifyRole, roles, type Role } from "./analyze";
export { courseGraph, type CourseGraph } from "./course-graph";
export {
  buildCourseIndex,
  courseIndex,
  courseOfSource,
  isPipelineStore,
  normaliseUrl,
  type CourseIndex,
  type PipelineStore,
  type Res,
} from "./course-index";
export { canonicalAssessment, references, strengthWeight, type Reference } from "./references";
export { compileCourse, hasLinks, isMaterial, linkResource, type WriteReport } from "./write";
