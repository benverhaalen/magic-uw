import type { Store } from '@magic/contracts';
import type { CourseWorkAdmission } from '../../contracts/src/course-work';
import { courseWorkMeetings } from './course-work-meetings';
import { courseInclusion } from './access';
import { buildCourseIndex } from './graph/course-index';

/** Reuses the actual account/course policy. Unknown sources never enter canonical joins. */
export function courseWorkAdmission(store: Store, now?: string): CourseWorkAdmission {
  const sourceById = new Map(store.sources().map(source => [source.id, source]));
  const included = courseInclusion(store);
  const admitted = store.resources().filter(resource => !resource.deleted && included(resource) &&
    sourceById.get(resource.sourceId)?.status !== 'inaccessible');
  const groups = new Map<string, typeof admitted>();
  for (const resource of admitted) {
    const source = sourceById.get(resource.sourceId);
    if (!source) continue;
    const key = JSON.stringify([source.accountScope, resource.courseId]);
    groups.set(key, [...(groups.get(key) ?? []), resource]);
  }
  const courses: CourseWorkAdmission['courses'] = [], aliases: CourseWorkAdmission['aliases'] = [];
  for (const rows of groups.values()) {
    // Personal mail/calendar and account-profile resources are not an additional course.
    // A course-less but real task remains visible with unknown-term coverage.
    if (!rows.some(row => row.kind === 'course' || row.kind === 'assignment' ||
      row.moduleItem?.type === 'Assignment' || row.moduleItem?.type === 'Quiz' || !!row.moduleItem?.completionRequirement ||
      (row.kind === 'event' && sourceById.get(row.sourceId)?.scope === 'calendar_feed' &&
        (!!row.calendar?.assignmentExternalId || /^event-assignment-\d+$/.test(row.calendar?.uid ?? ''))))) continue;
    const first = rows[0]!, source = sourceById.get(first.sourceId)!;
    // Match the policy's course evidence selection, including source scope.
    const course = rows.findLast(row => row.kind === 'course' && sourceById.get(row.sourceId)?.scope === 'course');
    courses.push({ accountScope: source.accountScope, courseId: first.courseId,
      sourceIds: [...new Set(rows.map(row => row.sourceId))].sort(),
      termId: course?.course?.termId ?? null, termName: course?.course?.termName ?? null,
      courseLabel: course?.course?.courseCode ?? course?.courseName ?? first.courseName });
    const index = buildCourseIndex({ accountScope: source.accountScope, courseId: first.courseId }, '',
      rows.map(row => ({ ...row, scope: sourceById.get(row.sourceId)!.scope })));
    for (const item of index.moduleItemById.values()) {
      const target = index.itemTarget(item);
      if (target && target.id !== item.id) aliases.push({ resourceId: item.id, targetId: target.id });
    }
  }
  const result: CourseWorkAdmission = { selectedTerm: store.ingestionSettings().selectedTerm ?? null,
    courses: courses.sort((a,b) => JSON.stringify([a.accountScope,a.courseId]).localeCompare(JSON.stringify([b.accountScope,b.courseId]))),
    resourceIds: admitted.map(row => row.id).sort(), aliases };
  return now ? {...result,...courseWorkMeetings(store,result,now)} : result;
}
