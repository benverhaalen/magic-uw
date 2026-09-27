import type { Resource, Store, StoredPlanningRecord } from '@magic/contracts';
import type { CourseWorkAdmission, CourseWorkSchedule } from '../../contracts/src/course-work';
import { projectCourseLabel } from '../../domain/src/course-label';
import { buildCourseIdentityTable, canonicalizeCourseKey, parseAuditCourseTerm, parseUwTermLabel, resolveCourseIdentity } from '../../domain/src/planning';

/** Exact institutional identity, term, section and native verified account link are all required. */
export function courseWorkMeetings(store: Store, admission: CourseWorkAdmission, now: string): {
  schedules: CourseWorkSchedule[]; scheduleCoverage: NonNullable<CourseWorkAdmission['scheduleCoverage']>;
} {
  const schedules: CourseWorkSchedule[] = [], scheduleCoverage: NonNullable<CourseWorkAdmission['scheduleCoverage']> = [];
  const records = store.planningRecords().filter(row=>!row.deleted), planningSources = new Map(store.planningSources().map(source=>[source.id,source]));
  const sources = new Map(store.sources().map(source=>[source.id,source])), admittedIds = new Set(admission.resourceIds);
  const courses = store.resources().filter(row=>admittedIds.has(row.id) && row.kind === 'course' && sources.get(row.sourceId)?.scope === 'course');
  let table;
  try { table = buildCourseIdentityTable(records.filter((r):r is Extract<StoredPlanningRecord,{kind:'subject'}>=>r.kind==='subject' && r.accountScope==='public'),
    records.filter((r):r is Extract<StoredPlanningRecord,{kind:'crosslist'}>=>r.kind==='crosslist' && r.accountScope==='public')); }
  catch { return {schedules,scheduleCoverage:[{label:'Conflicting institutional course mappings prevent class schedule matching.',sourceIds:[]}]}; }
  const fresh = (row:StoredPlanningRecord) => {
    const source = planningSources.get(row.sourceId);
    return !!source && source.status === 'complete' && source.completeness === 'complete' && source.accountScope === row.accountScope &&
      [source.observedAt,row.provenance.observedAt].every(stamp=>Date.parse(now)>=Date.parse(stamp)&&Date.parse(now)-Date.parse(stamp)<=86400000);
  };
  const links = records.filter((row): row is Extract<StoredPlanningRecord,{kind:'account_link'}> => row.kind === 'account_link' && fresh(row));
  const identity = (course:Resource) => {
    const source = sources.get(course.sourceId)!;
    const label = projectCourseLabel({resource:course,source});
    if (label.method !== 'verified-wrapper' || !label.context.termToken || !label.context.section || !label.displayCode) return null;
    const term = parseAuditCourseTerm(label.context.termToken); if (!term) return null;
    const nameTerm = parseUwTermLabel(course.course?.termName ?? '');
    // Canvas sometimes names the academic year rather than a single calendar year.
    const range = /^(fall|spring|summer)\s+(20\d{2})[-–](20\d{2})$/i.exec(course.course?.termName?.trim() ?? '');
    if (!nameTerm && !(range && Number(range[3]) === Number(range[2])+1 && term.season === range[1]!.toLowerCase() && term.year === Number(range[term.season === 'fall' ? 2 : 3]))) return null;
    if (nameTerm && nameTerm.code !== term.code) return null;
    const match = /^([A-Z]+) (\d{3})$/.exec(label.displayCode); if (!match) return null;
    const canonical = resolveCourseIdentity({subject:match[1]!,catalog:match[2]!},table);
    return canonical.status === 'resolved' ? {course,accountScope:source.accountScope,courseKey:canonical.courseKey,termCode:term.code,section:label.context.section} : null;
  };
  const identities = courses.flatMap(course=> {const value=identity(course);return value?[value]:[];});
  for (const record of records) {
    if (record.kind !== 'enrollment_package' || record.enrollmentState !== 'enrolled' || record.status === 'cancelled') continue;
    const accounts = [...new Set(links.filter(link=>link.accountScope===record.accountScope).map(link=>link.canvasAccountScope))];
    const sections = record.sections.map(section=>/^(LEC|DIS|LAB|SEM|IND) (\d{3})$/.exec(section));
    const matches = accounts.length === 1 && sections.every(Boolean) ? identities.filter(candidate=>candidate.accountScope===accounts[0] && candidate.courseKey===canonicalizeCourseKey(record.courseKey,table) && candidate.termCode===record.termCode && sections.some(section=>section![2]===candidate.section)) : [];
    // Ambiguous section/course matches, stale identity links and unknown metadata never choose a course.
    if (matches.length !== 1 || !fresh(record)) {
      scheduleCoverage.push({label:'Some saved class schedules lack a current, unique account, term and section match.',sourceIds:[record.sourceId]});continue;
    }
    const matched = matches[0]!;
    const competing = records.filter(other=>!other.deleted && other.kind==='enrollment_package' && other.enrollmentState==='enrolled' && other.status!=='cancelled' && other.accountScope===record.accountScope && other.termCode===record.termCode && canonicalizeCourseKey(other.courseKey,table)===canonicalizeCourseKey(record.courseKey,table) && other.sections.some(section=>sections.some(candidate=>candidate?.[0]===section)));
    if(competing.length!==1){scheduleCoverage.push({label:'Several saved enrollment packages describe the same class section.',sourceIds:[record.sourceId]});continue;}
    const components = new Set(sections.map(section=>section![1]));
    schedules.push({key:JSON.stringify([matched.accountScope,matched.course.courseId,record.localId]),accountScope:matched.accountScope,
      courseId:matched.course.courseId,resourceId:matched.course.id,planningRecordId:record.localId,planningSourceId:record.sourceId,
      classKind:components.size===1&&components.has('LEC')?'lecture':components.size===1&&components.has('DIS')?'discussion':'class',
      meetings:record.meetings,complete:record.meetingsComplete});
  }
  return {schedules,scheduleCoverage};
}
