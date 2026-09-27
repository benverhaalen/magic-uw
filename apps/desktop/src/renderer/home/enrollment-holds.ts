import type { Snapshot } from '@magic/contracts';
import { ATTENTION_HORIZON, projectMyUw } from '../myuw/model';

/** A small Home reading of the same saved, account-scoped evidence as My UW. */
export function homeEnrollmentHolds(snapshot: Snapshot, now: number) {
  const model = projectMyUw(snapshot, now);
  if (model.state === 'multiple_accounts') return {
    enrollment: 'More than one UW account is saved. Open My UW to choose which records to trust.',
    holds: 'Hold status unavailable across multiple accounts.',
    holdCount: 0, holdTitle: null, holdStale: false,
  };

  const term = model.thisTerm;
  const enrollment = !term ? 'Enrollment is not saved yet.'
    : term.complete ? term.courses.length
      ? `${term.courses.length} ${term.courses.length === 1 ? 'course' : 'courses'} enrolled for ${term.label}.`
      : `No enrolled courses reported for ${term.label}.`
    : term.courses.length
      ? `${term.courses.length} ${term.courses.length === 1 ? 'saved course' : 'saved courses'} listed for ${term.label}; refresh to confirm enrollment.`
      : `Enrollment for ${term.label} could not be confirmed.`;

  const holds = model.attention.filter((item) => item.kind === 'hold');
  const studentSources = model.sources.filter((source) => source.service === 'enroll' && source.label === 'Course Search & Enroll sign-in');
  const currentStudentInfo = studentSources.some((source) => source.state === 'current' &&
    now >= Date.parse(source.observedAt) && now - Date.parse(source.observedAt) <= ATTENTION_HORIZON);
  const top = holds[0];
  const holdsText = !holds.length
    ? currentStudentInfo ? 'No holds reported in the latest UW check.' : 'Hold status is not confirmed.'
    : `${holds.length} ${holds.length === 1 ? 'hold' : 'holds'} saved${holds.some((item) => item.stale) ? '; refresh to confirm' : ''}.`;

  return {
    enrollment, holds: holdsText, holdCount: holds.length,
    holdTitle: top?.kind === 'hold' ? top.record.title : null,
    holdStale: holds.some((item) => item.stale),
  };
}
