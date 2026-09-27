import type { DeadlineSpan, ResourceView, SourceHealth } from '@magic/contracts';

/** A display claim corroborated from literal text + module structure, not a stored graph link. */
export interface HomePrerequisite {
  assignment: ResourceView;
  quiz: ResourceView;
  module: ResourceView;
  /** The exact quiz name quoted in the assignment and repeated at the start of the quiz title. */
  reference: string;
  evidence: DeadlineSpan;
  quizTitleSpan: { start: number; end: number; text: string };
  completion: 'unknown' | 'not-submitted';
  rule: 'home-prerequisite.v1';
}

const normalized = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
const conditions = /\b(if|unless|except|only|optional|not|never|otherwise|instead|example|superseded|revoked|obsolete|outdated|correction|however|skip|waived|exempt|alternatively)\b/i;
// This grammar names a quiz, module and order explicitly. Other instruction forms stay in source.
const namedOrder = /(?:^|\n\s*\n)(?:Please\s+)?(?:take|complete)\s+(?:the\s+)?['“‘"]([^'”’"\r\n]+)['”’"]\s+found\s+(?:within|in)\s+the\s+((?:Unit|Module)\s+\d+)\s+module\s+before\s+reading\s+and\s+answering\s+the\s+following\s+questions\.(?=\s|$)/gi;
const classStages = (title: string) => [...new Set([...title.matchAll(/\bclass\s+(\d+)\b/gi)].map(m => m[1]!))];
const nameHead = (title: string, name: string) => normalized(title) === normalized(name) || normalized(title).startsWith(normalized(name) + ' - ');

function sourceScope(resource: ResourceView, sources: SourceHealth[]): string | null {
  const source = sources.find(s => s.id === resource.sourceId);
  return source?.kind === 'canvas' && source.accountScope && source.courseId === resource.courseId
    ? JSON.stringify([source.accountScope, resource.courseId]) : null;
}
function exactQuizDestination(quiz: ResourceView, assignment: ResourceView): boolean {
  try {
    const target = new URL(quiz.url), owner = new URL(assignment.url);
    if (target.protocol !== 'https:' || target.origin !== owner.origin) return false;
    return target.pathname === `/courses/${quiz.courseId}/modules/items/${quiz.externalId}` || target.pathname === `/courses/${quiz.courseId}/quizzes/${quiz.moduleItem?.contentId}`;
  } catch { return false; }
}

/**
 * Recognize one explicit named prerequisite. No fuzzy title join, arbitrary nearby material,
 * completion inference from a containing module, or source-derived date parsing is performed.
 * Recognized limiting or conditional language makes this concise claim ineligible.
 */
export function assignmentPrerequisite(assignment: ResourceView, resources: ResourceView[], sources: SourceHealth[]): HomePrerequisite | null {
  if (assignment.kind !== 'assignment' || assignment.deleted || assignment.submitted || assignment.completed || conditions.test(assignment.text)) return null;
  const scope = sourceScope(assignment, sources);
  if (!scope) return null;
  const stages = classStages(assignment.title);
  if (stages.length !== 1) return null;
  const matches = [...assignment.text.matchAll(namedOrder)];
  if (matches.length !== 1) return null;
  const match = matches[0]!, reference = match[1]!, moduleName = match[2]!;
  const modules = resources.filter(r => !r.deleted && r.module && sourceScope(r, sources) === scope && nameHead(r.title, moduleName));
  if (modules.length !== 1) return null;
  const module = modules[0]!;
  const candidates = resources.filter(r => {
    if (r.deleted || r.kind !== 'material' || sourceScope(r, sources) !== scope || r.moduleItem?.type !== 'Quiz' || !r.moduleItem.contentId || r.moduleItem.moduleId !== module.module!.id) return false;
    if (!nameHead(r.title, reference) || !exactQuizDestination(r, assignment)) return false;
    // Reciprocal source wording ties this quiz to the same class stage, rather than a
    // same-name quiz elsewhere in the module. Keep its whole title as evidence.
    const tail = / - take before starting Class (\d+) assignment$/i.exec(r.title);
    return tail?.[1] === stages[0] && normalized(r.title.slice(0, tail.index)) === normalized(reference);
  });
  if (candidates.length !== 1) return null;
  const quiz = candidates[0]!;
  // Unknown quiz status stays unknown even when the containing module says completed.
  if (quiz.submitted === true || quiz.completed === true || quiz.moduleItem?.completionRequirement?.completed === true || quiz.moduleItem?.lockInfo?.locked === true) return null;
  const start = match.index! + match[0].search(/\S/);
  const paragraphEnd = assignment.text.slice(start).search(/\n\s*\n/);
  const end = paragraphEnd < 0 ? assignment.text.length : start + paragraphEnd;
  const text = assignment.text.slice(start, end).trimEnd();
  const titleEnd = / - take before starting Class (\d+) assignment$/i.exec(quiz.title)!.index;
  return {
    assignment, quiz, module, reference,
    evidence: { resourceId: assignment.id, contentHash: assignment.contentHash, version: assignment.version, field: 'text', start, end: start + text.length, text },
    quizTitleSpan: { start: 0, end: titleEnd, text: quiz.title.slice(0, titleEnd) },
    completion: quiz.submission?.workflowState === 'unsubmitted' ? 'not-submitted' : 'unknown',
    rule: 'home-prerequisite.v1',
  };
}
