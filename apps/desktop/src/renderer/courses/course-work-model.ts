import type { Link, ResourceView, SourceHealth } from '@magic/contracts';
import type { CourseWorkAdmission } from '../../../../../packages/contracts/src/course-work';
import { personalWorkState, type PersonalWorkDescriptor, type PersonalWorkState } from '../../../../../packages/contracts/src/personal-work';
import { addDays, startOfDate } from '../calendar/model';
import { localTime } from '@magic/domain';
import { projectScheduleResources, schedulePlanning, type ScheduleResource } from '../schedule-projection';
import { SHOW_DATE_CONFLICT_UI } from '../date-conflict-policy';

export type CourseWorkScope = {
  key: string; selectedTerm: string | null;
  term: { label: string; state: 'verified' | 'mixed' | 'unknown' };
  courses: CourseWorkAdmission['courses'];
};
export type WorkTime =
  | { state: 'dated'; date: string; minute: number | null; at: string; timeZone: string;
      role: 'due' | 'starts' | 'planning'; personal: boolean; sourceConflict: boolean }
  | { state: 'conflict'; needsReview: boolean }
  | { state: 'undated' };
export type WorkSourceState = 'submitted' | 'excused' | 'requirement-complete' | 'unsubmitted' | 'missing' | 'unknown' | 'not-applicable';
export type CourseWorkAction = {
  kind: 'open-resource' | 'open-work-set' | 'review-dates' | 'resume-study'; label: string;
  resourceId: string; sessionId?: string;
};
export type CourseWorkRow = {
  key: string; scopeKey?: string; accountScope: string; courseId: string; sourceIds: string[]; resourceId: string | null;
  evidenceIds: string[]; kind: 'assignment' | 'quiz' | 'exam' | 'prep' | 'lecture' | 'discussion' | 'class';
  mode: 'task' | 'commitment'; title: string; courseLabel: string; time: WorkTime;
  sourceState: WorkSourceState; sourceLabel?: string;
  report: null | { issueId: string; obligationVersion: string; revision: number; checked: boolean;
    reportedAt?: string; needsReview: boolean; scheduleChanged?: boolean; changeLabel?: string; descriptor: PersonalWorkDescriptor };
  action: CourseWorkAction | null;
  relation?: { occurrenceKey: string; label: string };
  meetingEvidence?: 'dated-occurrence' | 'weekly-pattern';
};
export type CourseWorkModel = {
  scope: CourseWorkScope; rows: CourseWorkRow[];
  coverage: Array<{ kind: 'partial-source' | 'unknown-term' | 'unmapped-meeting' | 'recurrence-exceptions'; label: string; sourceIds: string[] }>;
  generatedAt: string;
};
export type CourseWorkResource = ResourceView & { personalWork?: PersonalWorkDescriptor };
/** Producer-supplied structured meaning. Never infer a lecture, prep or exam mode from a title. */
export type CourseWorkBinding = {
  resourceId: string; accountScope: string; courseId: string;
  kind: CourseWorkRow['kind']; mode: CourseWorkRow['mode'];
  evidenceIds: string[];
  occurrenceKey?: string; meetingEvidence?: CourseWorkRow['meetingEvidence'];
  relation?: CourseWorkRow['relation'];
};
export type CourseWorkInput = {
  resources: CourseWorkResource[]; sources: SourceHealth[]; admission: CourseWorkAdmission;
  links?: Link[]; personalWorkReports?: PersonalWorkState[]; bindings?: CourseWorkBinding[];
  coverage?: CourseWorkModel['coverage']; generatedAt: string; timeZone?: string;
};
const tuple = (account: string, course: string) => JSON.stringify([account, course]);
const uniq = (values: string[]) => [...new Set(values)].sort();

/** Header names only the admitted course evidence, never the newest capture or guessed season. */
export function courseWorkScope(admission: CourseWorkAdmission): CourseWorkScope {
  const courses = [...admission.courses].sort((a,b) => tuple(a.accountScope,a.courseId).localeCompare(tuple(b.accountScope,b.courseId)));
  const names = uniq(courses.flatMap(course => course.termName ? [course.termName] : []));
  const complete = courses.length > 0 && courses.every(course => !!course.termName &&
    (!admission.selectedTerm || admission.selectedTerm === course.termId || admission.selectedTerm === course.termName));
  const term: CourseWorkScope['term'] = !complete ? { label: 'Your courses', state: 'unknown' }
    : names.length === 1 ? { label: names[0]!, state: 'verified' } : { label: 'All selected terms', state: 'mixed' };
  return { key: JSON.stringify([admission.selectedTerm, courses.map(course => [course.accountScope, course.courseId, [...course.sourceIds].sort()])]),
    selectedTerm: admission.selectedTerm, courses, term };
}
function sourceState(resource: CourseWorkResource, mode: CourseWorkRow['mode'], feedOnly: boolean): WorkSourceState {
  if (feedOnly || mode === 'commitment') return 'not-applicable';
  if (resource.submission?.excused) return 'excused';
  if (resource.submitted || resource.submission?.submittedAt || resource.submission?.workflowState === 'submitted') return 'submitted';
  if (resource.submission?.missing) return 'missing';
  if (resource.submission?.workflowState === 'unsubmitted') return 'unsubmitted';
  if (resource.kind === 'assignment') return 'unknown'; // grade/completed/false alone cannot establish submission.
  if (resource.moduleItem?.completionRequirement?.completed === true) return 'requirement-complete';
  return 'not-applicable';
}
const labels: Record<WorkSourceState, string | undefined> = {
  submitted: 'Submitted in Canvas', excused: 'Excused', 'requirement-complete': 'Requirement completed',
  unsubmitted: 'Canvas shows not submitted', missing: 'Canvas shows missing', unknown: 'Submission unknown', 'not-applicable': undefined,
};
function workTime(resource: CourseWorkResource & ScheduleResource, mode: CourseWorkRow['mode'], tz: string): WorkTime {
  const planning = schedulePlanning(resource, tz);
  if ((resource.deadline.conflict && !planning?.personal) || resource.personalDeadline?.needsReview)
    return { state: 'conflict', needsReview: !!resource.personalDeadline?.needsReview };
  if (mode === 'commitment' && resource.calendar && !resource.scheduleDeadline?.feedOnly) {
    const calendar = resource.calendar;
    if (!Number.isFinite(Date.parse(calendar.start))) return { state: 'undated' };
    const day = calendar.allDay || /^\d{4}-\d{2}-\d{2}$/.test(calendar.start);
    const local = day ? { date: calendar.start.slice(0,10), min: null } : localTime(calendar.start, tz);
    return { state: 'dated', date: local.date, minute: local.min, at: day ? local.date : calendar.start,
      timeZone: calendar.timezone ?? tz, role: 'starts', personal: false, sourceConflict: false };
  }
  if (!planning) return { state: 'undated' };
  return { state: 'dated', date: planning.date, minute: planning.minute,
    at: planning.minute === null ? planning.date : planning.at, timeZone: planning.minute === null ? 'America/Chicago' : tz,
    role: planning.personal ? 'planning' : 'due', personal: planning.personal, sourceConflict: resource.deadline.conflict };
}
function taskMeaning(resource: CourseWorkResource, sourceScope: string, binding?: CourseWorkBinding): Pick<CourseWorkRow, 'kind' | 'mode'> | null {
  if (binding) return { kind: binding.kind, mode: binding.mode };
  const types = resource.submissionTypes ?? [];
  if (resource.kind === 'assignment') {
    const kind = sourceScope.split(':')[0] === 'quizzes' || types.includes('online_quiz') ? 'quiz' : types.includes('discussion_topic') ? 'discussion' : 'assignment';
    // A no-submission/on-paper item may be a scheduled assessment; keep inspectable without a speculative checkbox.
    return { kind, mode: types.length > 0 && types.every(type => type === 'on_paper' || type === 'none' || type === 'not_graded') ? 'commitment' : 'task' };
  }
  if (sourceScope.split(':')[0] === 'quizzes') return { kind: 'quiz', mode: 'task' };
  if (resource.moduleItem?.type === 'Quiz') return { kind: 'quiz', mode: 'task' };
  if (resource.moduleItem?.type === 'Assignment') return { kind: 'assignment', mode: 'task' };
  if (resource.moduleItem?.completionRequirement) return { kind: 'prep', mode: 'task' };
  return null;
}

/** Full admitted term inventory: no Home window, overdue cutoff or render pagination. */
export function projectCourseWork(input: CourseWorkInput): CourseWorkModel {
  const scope = courseWorkScope(input.admission), tz = input.timeZone ?? 'America/Chicago';
  const sources = new Map(input.sources.map(source => [source.id,source]));
  const courses = new Map(scope.courses.map(course => [tuple(course.accountScope,course.courseId),course]));
  const ids = new Set(input.admission.resourceIds);
  const permitted: Array<CourseWorkResource & ScheduleResource & { accountScope: string; sourceScope: string }> = input.resources.filter(resource => {
    const source = sources.get(resource.sourceId);
    return !!source && ids.has(resource.id) && !resource.deleted && source.status !== 'inaccessible' &&
      !!courses.get(tuple(source.accountScope,resource.courseId))?.sourceIds.includes(source.id);
  }).map(resource => ({...resource,accountScope:sources.get(resource.sourceId)!.accountScope,sourceScope:sources.get(resource.sourceId)!.scope}));
  const byId = new Map(permitted.map(resource => [resource.id,resource]));
  const bindings = new Map((input.bindings ?? []).filter(binding => {
    const resource = byId.get(binding.resourceId);
    return !!resource && resource.accountScope === binding.accountScope && resource.courseId === binding.courseId &&
      binding.evidenceIds.length > 0 && binding.evidenceIds.every(id => {
        const evidence = byId.get(id); return evidence?.accountScope === binding.accountScope && evidence.courseId === binding.courseId;
      });
  }).map(binding => [binding.resourceId,binding]));
  const coverage: CourseWorkModel['coverage'] = [...(input.coverage ?? [])];
  if (scope.term.state === 'unknown') coverage.push({kind:'unknown-term',label:'Some saved work has no verified term.',sourceIds:uniq(scope.courses.flatMap(course=>course.sourceIds))});
  const partial = input.sources.filter(source => scope.courses.some(course=>course.sourceIds.includes(source.id)) && (!source.complete || !['ok','unchanged'].includes(source.status)));
  if (partial.length) coverage.push({kind:'partial-source',label:'Some course sources are incomplete. Saved work is still shown.',sourceIds:partial.map(source=>source.id)});
  for (const gap of input.admission.scheduleCoverage ?? []) coverage.push({kind:'unmapped-meeting',...gap});
  const rows: CourseWorkRow[] = [];
  const canonical = projectScheduleResources(permitted, input.links, input.admission.aliases);
  for (const resource of canonical) {
    const binding = bindings.get(resource.id), feedOnly = !!resource.scheduleDeadline?.feedOnly;
    const meaning = feedOnly ? {kind:'assignment' as const,mode:'commitment' as const} : taskMeaning(resource,resource.sourceScope,binding);
    if (!meaning) {
      if (resource.kind === 'event') coverage.push({kind:'unmapped-meeting',label:'A saved calendar event has no verified class or preparation relation.',sourceIds:[resource.sourceId]});
      continue;
    }
    const course = courses.get(tuple(resource.accountScope,resource.courseId))!;
    const time = workTime(resource,meaning.mode,tz), state = sourceState(resource,meaning.mode,feedOnly);
    const evidenceIds = uniq([...resource.scheduleDeadline?.evidenceIds ?? [resource.id], ...binding?.evidenceIds ?? []]);
    const descriptor = meaning.mode === 'task' && !feedOnly ? resource.personalWork : undefined;
    // A report descriptor must still bind this exact admitted account/course and canonical contributors.
    const validDescriptor = descriptor && descriptor.scope.accountScope === resource.accountScope && descriptor.scope.courseId === resource.courseId &&
      evidenceIds.includes(descriptor.scope.canonicalResourceId) && descriptor.evidence.every(evidence=> { const row = byId.get(evidence.resourceId); return row?.accountScope === resource.accountScope && row.courseId === resource.courseId; });
    const personal = validDescriptor ? personalWorkState(input.personalWorkReports,descriptor) : null;
    const report: CourseWorkRow['report'] = personal && descriptor ? {
      issueId:descriptor.issueId,obligationVersion:descriptor.sourceVersion,revision:personal.revision,
      checked:!!personal.previous?.checked,reportedAt:personal.previous?.reportedAt,needsReview:personal.needsReview,
      scheduleChanged:personal.scheduleChanged,
      changeLabel:personal.changes.length ? uniq(personal.changes.map(change => ({instructionHash:'Instructions changed',requirementsHash:'Requirements changed',title:'Title changed',points:'Points changed',submissionTypes:'Submission requirements changed',evidence:'Supporting requirements changed',dueAt:'Due date changed',lockAt:'Availability changed',unlockAt:'Availability changed',moduleDueAt:'Module date changed',deadlines:'Dates changed'}[change.field]))).join(' · ') : undefined,descriptor,
    } : null;
    const action: CourseWorkAction = SHOW_DATE_CONFLICT_UI && time.state === 'conflict' ? {kind:'review-dates',label:'Review dates',resourceId:resource.id}
      : {kind:resource.kind === 'assignment' && state !== 'submitted' && state !== 'excused' ? 'open-work-set' : 'open-resource',
        label:state === 'submitted' ? 'View submission' : meaning.kind === 'prep' ? 'Open material' : feedOnly || meaning.mode === 'commitment' ? 'Open details' : `Open ${meaning.kind}`,resourceId:resource.id};
    rows.push({key:JSON.stringify([resource.accountScope,resource.courseId,resource.scheduleDeadline?.family ?? resource.id,binding?.occurrenceKey ?? 'work']),
      scopeKey:scope.key,accountScope:resource.accountScope,courseId:resource.courseId,sourceIds:uniq(evidenceIds.map(id=>byId.get(id)!.sourceId)),resourceId:resource.id,evidenceIds,
      ...meaning,title:resource.title,courseLabel:course.courseLabel,time,sourceState:state,sourceLabel:sources.get(resource.sourceId)?.kind === 'canvas' ? labels[state] : labels[state]?.replace('in Canvas','in source').replace('Canvas shows','Source shows'),report,action,
      ...(binding?.relation ? {relation:binding.relation} : {}),...(binding?.meetingEvidence ? {meetingEvidence:binding.meetingEvidence} : {})});
    if (binding?.meetingEvidence === 'weekly-pattern') coverage.push({kind:'recurrence-exceptions',label:'Weekly class patterns may omit cancellations and holidays.',sourceIds:[resource.sourceId]});
  }
  // Saved institutional meeting patterns cover their full explicit date range. The UI pages rows;
  // no generated occurrence claims cancellation/holiday verification that the source does not carry.
  for (const schedule of input.admission.schedules ?? []) {
    const anchor = byId.get(schedule.resourceId), course = courses.get(tuple(schedule.accountScope,schedule.courseId));
    if (!anchor || !course || anchor.accountScope !== schedule.accountScope || anchor.courseId !== schedule.courseId) continue;
    const sourceIds = uniq([anchor.sourceId,schedule.planningSourceId]);
    if (!schedule.complete) coverage.push({kind:'partial-source',label:'Some saved class meeting details are incomplete.',sourceIds});
    for (const [index,meeting] of schedule.meetings.entries()) {
      if (meeting.mode !== 'scheduled') continue;
      const start = meeting.startDate, end = meeting.endDate;
      if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end ||
        Date.parse(end)-Date.parse(start)>366*86400000 || meeting.startMinute === null || !meeting.days.length) {
        coverage.push({kind:'unmapped-meeting',label:'Some class meetings need verified dates or times before they can be placed.',sourceIds});continue;
      }
      const weekly = meeting.kind !== 'exam' || start !== end;
      if (weekly) coverage.push({kind:'recurrence-exceptions',label:'Class times follow saved weekly patterns. Cancellations and holidays are not verified.',sourceIds});
      for (let date=start; date<=end; date=addDays(date,1)) {
        if (!meeting.days.includes(new Date(`${date}T12:00:00Z`).getUTCDay() || 7)) continue;
        // Start with the shared zone-aware date boundary, then correct a DST shift in civil minutes.
        let at = startOfDate(date,meeting.timezone).getTime()+meeting.startMinute*60000;
        for(let attempt=0;attempt<3;attempt++) { const actual=localTime(new Date(at).toISOString(),meeting.timezone);
          if(actual.date===date && actual.min===meeting.startMinute) break;
          at+=(Date.parse(date)-Date.parse(actual.date))+(meeting.startMinute-actual.min)*60000; }
        const actual=localTime(new Date(at).toISOString(),meeting.timezone);
        if(actual.date!==date || actual.min!==meeting.startMinute) {coverage.push({kind:'unmapped-meeting',label:'A class time falls in an unrepresentable clock change and needs confirmation.',sourceIds});continue;}
        const kind = meeting.kind==='exam'?'exam':schedule.classKind;
        rows.push({key:JSON.stringify([schedule.key,index,date,meeting.startMinute]),scopeKey:scope.key,accountScope:schedule.accountScope,courseId:schedule.courseId,
          sourceIds,resourceId:anchor.id,evidenceIds:[anchor.id],kind,mode:'commitment',
          title:kind==='lecture'?'Lecture':kind==='discussion'?'Discussion':kind==='exam'?'Exam':'Class',courseLabel:course.courseLabel,
          time:{state:'dated',date,minute:meeting.startMinute,at:new Date(at).toISOString(),timeZone:meeting.timezone,role:'starts',personal:false,sourceConflict:false},
          sourceState:'not-applicable',sourceLabel:weekly?'Weekly pattern':undefined,report:null,
          action:{kind:'open-resource',label:'Open course',resourceId:anchor.id},meetingEvidence:weekly?'weekly-pattern':'dated-occurrence'});
      }
    }
  }
  rows.sort((a,b) => (a.time.state === 'dated' ? a.time.date : '9999').localeCompare(b.time.state === 'dated' ? b.time.date : '9999') ||
    (a.time.state === 'dated' ? a.time.minute ?? 1440 : 1440) - (b.time.state === 'dated' ? b.time.minute ?? 1440 : 1440) || a.key.localeCompare(b.key));
  return {scope,rows,coverage:[...new Map(coverage.map(item=>[JSON.stringify(item),item])).values()],generatedAt:input.generatedAt};
}
/** Before dispatch, reproject current input then compare the immutable row/action identity. */
export function isCourseWorkActionCurrent(row: CourseWorkRow, current: CourseWorkModel): boolean {
  const latest = current.rows.find(candidate=>candidate.key === row.key);
  return !!latest && latest.scopeKey === row.scopeKey && latest.accountScope === row.accountScope && latest.courseId === row.courseId &&
    JSON.stringify(latest.action) === JSON.stringify(row.action) && JSON.stringify(latest.evidenceIds) === JSON.stringify(row.evidenceIds) &&
    JSON.stringify(latest.sourceIds) === JSON.stringify(row.sourceIds);
}
