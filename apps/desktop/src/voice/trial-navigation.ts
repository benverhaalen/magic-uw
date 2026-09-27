import type { CommandOutcome, IntentCommandResult, Snapshot } from '@magic/contracts';
import { buildCourseCards } from '../../../../packages/domain/src/course-page';
import { pageDestination } from '../../../../packages/core/src/intent/page-action';

const emptyCost = { in: 0, cached: 0, out: 0 };
const result = (outcome: CommandOutcome): IntentCommandResult =>
  ({ ...outcome, path: 'code', latencyMs: 0, tokens: emptyCost });
const normalize = (value: string) => value.toLocaleLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');

/** Match only explicit navigation speech; no arbitrary utterance reaches a model or action router. */
export function trialNavigation(text: string, snapshot: Snapshot | null): IntentCommandResult {
  const page = pageDestination(text);
  if (page) return result({ status: 'ran', action: 'page.open', args: { text }, result: { navigate: { view: page } } });
  const phrase = /^(?:please )?(?:open|show|go to|take me to)(?: my| the)? (.+?)(?: please)?[.!?]*$/iu.exec(text.trim())?.[1];
  if (!phrase) return result({ status: 'unavailable', reason: 'This voice trial opens an app page or an included course. Say “Open Calendar” or “Open my biology course”.' });
  const requested = normalize(phrase.replace(/(?:\s+(?:course|class))$/iu, ''));
  if (!requested || requested === 'course' || requested === 'class')
    return result({ status: 'clarify', question: 'Which included course should I open?', candidates: [] });
  if (!snapshot) return result({ status: 'unavailable', reason: 'Your course list is still loading. Try again in a moment.' });
  // Keep this admission rule aligned with the renderer's included Courses cards. The
  // snapshot comes from the worker's most recent response; this path does not queue one.
  const sources = new Map(snapshot.sources.map(source => [source.id, source]));
  const resources = snapshot.resources.filter(resource => {
    if (resource.deleted) return false;
    const source = sources.get(resource.sourceId);
    const override = snapshot.courseOverrides?.find(item => item.accountScope === source?.accountScope && item.courseId === resource.courseId);
    const course = snapshot.resources.find(item => item.kind === 'course' && item.course && item.courseId === resource.courseId && sources.get(item.sourceId)?.scope === 'course' && sources.get(item.sourceId)?.accountScope === source?.accountScope);
    if (course?.course?.accessRestricted || (course?.course?.accessState && course.course.accessState !== 'open')) return false;
    if (course?.course?.selection?.reasons.some(reason => /absent|no longer|not returned/i.test(reason))) return false;
    const term = snapshot.ingestionSettings?.selectedTerm;
    if (term && course?.course && term !== course.course.termName && term !== course.course.termId) return false;
    return override?.included ?? course?.course?.selection?.included ?? true;
  });
  const cards = buildCourseCards({ resources, sources: snapshot.sources, courseIntelligence: snapshot.courseIntelligence, now: snapshot.generatedAt });
  const labels = (card: typeof cards[number]) => [card.code, card.courseName, card.rawCourseName,
    ...(card.term ? [card.code && `${card.code} ${card.term}`, `${card.courseName} ${card.term}`] : [])
  ].filter((label): label is string => !!label).map(normalize);
  const exact = cards.filter(card => labels(card).includes(requested));
  // A student may say a distinctive part of the displayed name; require word
  // boundaries and ask when that part names more than one included course.
  const matches = exact.length ? exact : requested.length >= 4 ? cards.filter(card => labels(card).some(label => ` ${label} `.includes(` ${requested} `))) : [];
  if (!matches.length) return result({ status: 'clarify', question: `I couldn't find an included course called “${phrase.trim()}”. Which course did you mean?`, candidates: [] });
  if (matches.length > 1) return result({ status: 'clarify', question: `I found ${matches.length} included courses named “${phrase.trim()}”. Say the full course code or term.`, candidates: [] });
  const card = matches[0]!;
  const accountScope = card.key.slice(0, card.key.length - card.courseId.length - 1);
  return result({ status: 'ran', action: 'page.open', args: { text }, result: { navigate: { view: 'course', courseId: card.courseId, accountScope } } });
}
