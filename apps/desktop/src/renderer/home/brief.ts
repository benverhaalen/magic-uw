import type { CourseWorkSchedule, Link, PlanningSnapshot, ResourceView, SourceHealth } from '@magic/contracts';
import { schedulePlanning } from '../schedule-projection';
import type { HomePrerequisite } from './prerequisite';
import { scopeKey, selectHomeEvidence, type HomePassage } from './projection';
import { localTime } from '@magic/domain';
import { verifiedCanvasEnrollment } from '../enrollment-evidence';
import { SHOW_DATE_CONFLICT_UI } from '../date-conflict-policy';
import { addDays, localMinuteInstant } from '../calendar/model';

/**
 * Daily Brief composition. A pure projection over already selected Home evidence: it decides which
 * connected facts earn a passage, which single action each one offers, and what that action can
 * truthfully promise. It never infers reading, completion, readiness or mastery, and it never
 * starts a learning generation. Rendering lives in DailyBrief.tsx.
 */

/** What an action does. Every kind resolves to an existing route; none launches several apps. */
export type BriefActionKind = 'review-dates' | 'open-quiz' | 'review-quiz' | 'review-change' | 'start-work' | 'open-material' | 'open-assignment' | 'past-due';
/** Semantic operation colour for the shared Action (briefing-cohesion `intent`). */
export type BriefIntent = 'review' | 'coursework' | 'study';
/**
 * What the action can promise. `current`: its source's last check was ok and complete. `saved-copy`:
 * the saved copy opens, but its source was not fully checked on the last run. `unknown`: no source
 * health is known for the target, so nothing is claimed about it. `link-only`: only the link was
 * captured, so the destination lists it without saved text. None of these says the student is ready.
 */
export type BriefActionStatus =
  | { state: 'current' }
  | { state: 'saved-copy'; note: string }
  | { state: 'unknown'; note: string }
  | { state: 'link-only'; note: string };
export interface BriefAction {
  kind: BriefActionKind;
  label: string;
  intent: BriefIntent | null;
  /** Resource route target, or null for a section route (past-due work). */
  targetId: string | null;
  /** Stable across regeneration: derived from source identity, never from prose. */
  focusKey: string;
  status: BriefActionStatus;
}
export type BriefItem =
  | { id: string; kind: 'project'; resource: ResourceView; parts: [string, string]; action: BriefAction }
  | { id: string; kind: 'lecture-prep'; lecture: ResourceView; material: ResourceView; relation: StatedRelation; classKind: 'lecture' | 'class'; action: BriefAction }
  | { id: string; kind: 'date-conflict'; resource: ResourceView; action: BriefAction }
  | { id: string; kind: 'prerequisite'; prerequisite: HomePrerequisite; action: BriefAction }
  | { id: string; kind: 'linked-materials'; context: ResourceView; materials: ResourceView[]; relation: StatedRelation; action: BriefAction }
  | { id: string; kind: 'passage'; passage: HomePassage; action: BriefAction | null }
  | { id: string; kind: 'past-due'; count: number; action: BriefAction };

/** Coverage of the saved evidence the brief could draw from. Partial is never presented as clear. */
export interface BriefCoverage {
  state: 'none' | 'partial' | 'complete';
  total: number;
  /** Sources whose last check was not ok and complete. */
  unchecked: number;
  needsSignIn: boolean;
}
export interface BriefFallback { text: string; action: 'sources' }

/** Active brief passages before Upcoming. The past-due summary line is extra and always last. */
export const BRIEF_LIMIT = 3;
const MATERIAL_NAMES = 3;
const NAVIGATION_TITLES = /^(home|modules|assignments|announcements|syllabus|course overview|grades|pages|files)$/i;
const PROJECT_NAME = /\b(project|capstone|portfolio|final paper|final presentation)\b/i;
const PROJECT_PARTS = ['proposal', 'draft', 'prototype', 'implementation', 'code', 'analysis', 'report', 'presentation', 'dataset', 'bibliography', 'outline', 'slides'] as const;
const DELIVERABLE_VERB = /\b(submit|turn in|include|deliver|upload|create|write|build|prepare|provide|require|requires)\b/i;
/** Two deliverables in an affirmative instruction clause; no effort or difficulty inference. */
export function projectParts(resource: ResourceView): [string, string] | null {
  if (!resource.text.trim()) return null;
  const clauses = resource.text.split(/[.!?\n;]+/).filter(clause => DELIVERABLE_VERB.test(clause) &&
    !/\b(no need to|do not|don't|not required|optional|may|might|can)\b/i.test(clause));
  const found = PROJECT_PARTS.filter(part => clauses.some(clause => new RegExp(`\\b${part}\\b`, 'i').test(clause)));
  if (!PROJECT_NAME.test(resource.title) && found.length < 3) return null;
  const named = found.map(part => part === 'prototype' && clauses.some(clause => /\bworking prototype\b/i.test(clause)) ? 'working prototype' : part);
  return named.length >= 2 ? [named[0]!, named[1]!] : null;
}

export function briefCoverage(sources: SourceHealth[]): BriefCoverage {
  const counted = sources.filter(source => source.kind !== 'fixture');
  const unchecked = counted.filter(source => source.status !== 'ok' || !source.complete);
  return {
    state: !counted.length ? 'none' : unchecked.length ? 'partial' : 'complete',
    total: counted.length,
    unchecked: unchecked.length,
    needsSignIn: unchecked.some(source => source.status === 'needs_sign_in'),
  };
}

/**
 * A saved copy is still useful when its source failed; say so rather than hide or overstate it.
 * Missing health is unknown, never current.
 */
export function actionStatus(target: ResourceView | undefined, sources: SourceHealth[]): BriefActionStatus {
  const source = target && sources.find(s => s.id === target.sourceId);
  if (!source) return { state: 'unknown', note: 'No check of this source is saved, so it may be out of date.' };
  if (source.status === 'ok' && source.complete) return { state: 'current' };
  return { state: 'saved-copy', note: source.status === 'needs_sign_in' ? 'Saved copy. Sign in to refresh.' : 'Saved copy. Last check was incomplete.' };
}
function combinedStatus(a: ResourceView, b: ResourceView, sources: SourceHealth[]): BriefActionStatus {
  const first = actionStatus(a, sources), second = actionStatus(b, sources);
  return first.state === 'unknown' || second.state === 'unknown'
    ? { state: 'unknown', note: 'A source check is missing, so this saved relationship may be out of date.' }
    : first.state === 'saved-copy' || second.state === 'saved-copy'
      ? { state: 'saved-copy', note: 'Saved copy. One of these sources was not fully checked.' }
      : second;
}

/**
 * What the context's own text says to do with a linked material: the stated verb, its stated
 * modality, and the sentence it comes from (exact span of the context's saved version). Purpose,
 * benefit or priority is never added; a bare link or a descriptive mention yields nothing.
 */
export interface StatedRelation {
  verb: string;
  /** `required`: must/need to. `expected`: should. `optional`: can/may/optional. `instruction`: imperative. */
  modality: 'required' | 'expected' | 'optional' | 'instruction';
  evidence: { resourceId: string; contentHash: string; start: number; end: number; text: string };
}
const RELATION_VERBS = ['fill out', 'refer to', 'look over', 'use', 'read', 'watch', 'review', 'complete', 'download', 'consult', 'follow', 'answer', 'study', 'print'];
const VERB_PATTERN = new RegExp(`\\b(${RELATION_VERBS.map(v => v.replace(' ', '\\s+')).join('|')})\\b`, 'gi');
// A modal only counts when it governs the verb: at most two words sit between them.
const governs = (words: string) => new RegExp(`\\b(?:${words})\\s+(?:[a-z]+\\s+){0,2}$`, 'i');
const OPTIONAL = governs('can|could|may|might|optionally|is optional to|are welcome to|are free to');
const EXPECTED = governs('should');
const REQUIRED = governs('must|need to|needs to|are required to|is required to|have to|has to|be sure to|make sure to|make sure you');
const NEGATED = /\b(not|never|no need|don't|do not|doesn't|without)\b|n't\b/i;
const IMPERATIVE_LEAD = /^(?:please|first|then|next|also|before [^,]{1,40},|for [^,]{1,40},|\d+[.)]|[-*•])?\s*$/i;
/** Longest gap allowed between the verb and the material's mention in one sentence. */
const VERB_REACH = 80;

export function statedRelation(context: ResourceView, material: ResourceView): StatedRelation | null {
  const text = context.text;
  if (!text) return null;
  const pointer = (context.links ?? []).find(p => typeof p !== 'string' && p.url === material.url);
  const anchors = [typeof pointer === 'object' ? pointer.text : undefined, material.title]
    .map(a => a?.trim()).filter((a): a is string => Boolean(a && a.length >= 4));
  const lower = text.toLowerCase();
  for (const anchor of anchors) {
    const at = lower.indexOf(anchor.toLowerCase());
    if (at < 0) continue;
    const before = text.slice(0, at);
    const boundary = Math.max(before.lastIndexOf('\n'), ...['. ', '! ', '? '].map(b => { const i = before.lastIndexOf(b); return i < 0 ? -1 : i + 1; }));
    const start = boundary + 1;
    const tail = text.slice(at + anchor.length).search(/[.!?](?:\s|$)|\n/);
    const end = tail < 0 ? text.length : at + anchor.length + tail + 1;
    const lead = text.slice(start, at);
    const verbs = [...lead.matchAll(VERB_PATTERN)];
    const verb = verbs.at(-1);
    if (!verb || lead.length - (verb.index! + verb[0].length) > VERB_REACH) continue;
    const clause = lead.slice(0, verb.index);
    if (NEGATED.test(clause) || NEGATED.test(lead.slice(verb.index! + verb[0].length))) continue;
    const modality = OPTIONAL.test(clause) ? 'optional' : REQUIRED.test(clause) ? 'required' : EXPECTED.test(clause) ? 'expected' : IMPERATIVE_LEAD.test(clause.trim()) ? 'instruction' : null;
    if (!modality) continue;
    const sentence = text.slice(start, end).trim();
    const offset = text.indexOf(sentence, start);
    return { verb: verb[0].toLowerCase().replace(/\s+/g, ' '), modality,
      evidence: { resourceId: context.id, contentHash: context.contentHash, start: offset, end: offset + sentence.length, text: sentence } };
  }
  return null;
}

/**
 * Materials the context's own instructions link, backed by an accepted `specifies` link for the
 * exact material version, in the same account and course. Title similarity never qualifies.
 */
export function linkedMaterials(context: ResourceView, resources: ResourceView[], links: Link[], sources: SourceHealth[]): ResourceView[] {
  const byId = new Map(resources.map(r => [r.id, r]));
  const pointers = new Set((context.links ?? []).map(pointer => typeof pointer === 'string' ? pointer : pointer.url));
  const found: ResourceView[] = [];
  for (const link of links) {
    if (link.status !== 'accepted' || link.type !== 'specifies' || link.toId !== context.id) continue;
    const material = byId.get(link.fromId);
    if (!material || material.kind !== 'material' || material.deleted || material.assignmentGroup || material.module) continue;
    if (link.inputHash !== material.contentHash || scopeKey(material, sources) !== scopeKey(context, sources)) continue;
    if (NAVIGATION_TITLES.test(material.title.trim()) || !pointers.has(material.url)) continue;
    if (!found.some(m => m.id === material.id)) found.push(material);
  }
  return found;
}

/**
 * The one date issue the brief leads with: the item the student is reviewing, else an open conflict,
 * else a personal planning date. Unchanged from the earlier Home rule; only moved here.
 */
export function briefConflict(canonical: ResourceView[], reviewedId: string | null, timeZone: string): ResourceView | null {
  const planning = (r: ResourceView) => schedulePlanning(r, timeZone);
  return canonical.find(r => r.id === reviewedId && (planning(r)?.conflict || planning(r)?.personal))
    ?? canonical.find(r => planning(r)?.conflict && !r.completed && !r.submitted)
    ?? canonical.find(r => planning(r)?.personal) ?? null;
}

export interface BriefInput {
  now?: string;
  resources: ResourceView[];
  sources: SourceHealth[];
  links: Link[];
  schedules?: CourseWorkSchedule[];
  planning?: PlanningSnapshot;
  timeZone: string;
  /** Today's and future open work, in Home's order. */
  activeWork: ResourceView[];
  /** Past due, open and not shown as submitted. */
  earlier: ResourceView[];
  passages: HomePassage[];
  prerequisites: HomePrerequisite[];
  conflict: ResourceView | null;
  /** Assignments whose launch is already visible in Upcoming; the brief does not repeat it. */
  launchable: Set<string>;
  /** Whether a direct original-source opener exists (quiz action wording). */
  canOpenSource: boolean;
}
export interface DailyBriefProjection {
  items: BriefItem[];
  coverage: BriefCoverage;
  fallback: BriefFallback | null;
  /** Materials the brief already routes to, so Study does not repeat the same action. */
  surfacedMaterialIds: Set<string>;
}

/** Home's admission boundary: course inclusion alone cannot establish current enrollment. */
export function currentEnrollmentBrief(input: BriefInput): DailyBriefProjection {
  const at = new Date(input.now ?? Date.now());
  // The labelled synthetic sample has no UW enrollment to verify: its invented courses are the sample.
  if (input.sources.length && input.sources.every(s => s.kind === 'fixture')) return projectDailyBrief(input);
  const verified = verifiedCanvasEnrollment(input.planning, new Set(input.sources.filter(s => s.kind === 'canvas').map(s => s.accountScope)), at);
  if (!verified) return { items: [], coverage: briefCoverage(input.sources), surfacedMaterialIds: new Set(),
    fallback: { action: 'sources', text: 'Current enrollment is not confirmed in this saved capture. Check your sources for a current brief.' } };
  const bySource = new Map(input.sources.map(s => [s.id, s]));
  const courses = new Set(input.resources.filter(r => !r.deleted && r.course?.selection?.included !== false && r.course &&
    bySource.get(r.sourceId)?.accountScope === verified.canvasAccountScope &&
    verified.enrollment.match({ course_code: r.course.courseCode, name: r.courseName })).map(r => r.courseId));
  const eligible = (r: ResourceView) => !r.deleted && courses.has(r.courseId) && bySource.get(r.sourceId)?.accountScope === verified.canvasAccountScope;
  const resources = input.resources.filter(eligible);
  const sourceIds = new Set(resources.map(r => r.sourceId));
  const sources = input.sources.filter(s => sourceIds.has(s.id));
  // Re-rank after admission so excluded courses cannot crowd current evidence out of the window.
  const selected = selectHomeEvidence(resources, { sources, links: input.links }, at.toISOString(), input.timeZone);
  return projectDailyBrief({ ...input, resources, sources,
    activeWork: input.activeWork.filter(eligible),
    // Partial intake cannot support an assertive count of unsubmitted work.
    earlier: briefCoverage(sources).state === 'complete' ? input.earlier.filter(r => eligible(r) && actionStatus(r, sources).state === 'current' && !schedulePlanning(r, input.timeZone)?.conflict) : [],
    passages: selected.passages,
    prerequisites: selected.prerequisites,
    conflict: input.conflict && eligible(input.conflict) ? input.conflict : null });
}

/** Select an intact saved sentence; this is faithful extraction, not generated synthesis. */
export function briefExcerpt(text: string): string {
  if (text.length <= 190) return text;
  const sentences = text.match(/[^.!?]+[.!?](?:\s|$)|[^.!?]+$/g)?.map(s => s.trim()).filter(s => s.length > 20 && s.length <= 240) ?? [];
  const useful = sentences.find(s => /\b(quiz|exam|in-person|cancelled|canceled|moved|before class|before lecture)\b/i.test(s));
  return useful ?? sentences[0] ?? text.slice(0, 190).replace(/\s+\S*$/, '') + '…';
}

export function projectDailyBrief(input: BriefInput): DailyBriefProjection {
  const { resources, sources, links, timeZone, conflict } = input;
  const coverage = briefCoverage(sources);
  const byId = new Map(resources.map(r => [r.id, r]));
  const items: BriefItem[] = [];
  const used = new Set<string>();
  const surfacedMaterialIds = new Set<string>();
  const status = (id: string) => actionStatus(byId.get(id), sources);

  if (conflict && SHOW_DATE_CONFLICT_UI) {
    used.add(conflict.id);
    items.push({ id: `date-conflict:${conflict.id}`, kind: 'date-conflict', resource: conflict,
      action: { kind: 'review-dates', label: 'Review dates', intent: 'review', targetId: conflict.id, focusKey: `review-${conflict.id}`, status: status(conflict.id) } });
  }
  // A project earns Brief space only when the saved instructions name multiple concrete parts.
  // The deadline itself remains in Upcoming. No effort, difficulty or time claim is inferred.
  const today = localTime(input.now ?? new Date().toISOString(), timeZone).date;
  const rankedWork = [...input.activeWork].sort((a, b) => {
    const pa = projectParts(a), pb = projectParts(b);
    const da = schedulePlanning(a, timeZone), db = schedulePlanning(b, timeZone);
    const score = (r: ResourceView, parts: [string, string] | null, date: typeof da) =>
      (parts ? 4 : 0) + (date && !date.conflict ? Math.max(0, 7 - Math.max(0, (Date.parse(`${date.date}T12:00:00Z`) - Date.parse(`${localTime(input.now ?? new Date().toISOString(), timeZone).date}T12:00:00Z`)) / 86_400_000)) / 7 : 0);
    return score(b, pb, db) - score(a, pa, da) || (da?.at ?? '').localeCompare(db?.at ?? '') || a.id.localeCompare(b.id);
  });
  for (const resource of rankedWork) {
    if (items.length >= BRIEF_LIMIT) break;
    const planning = schedulePlanning(resource, timeZone);
    const days = planning && (Date.parse(`${planning.date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000;
    const parts = projectParts(resource);
    if (!parts || !planning || (planning.conflict && !planning.personal) || days === null || days < 0 || days > 7 || resource.kind !== 'assignment') continue;
    used.add(resource.id);
    items.push({ id: `project:${resource.id}`, kind: 'project', resource, parts,
      action: { kind: 'open-assignment', label: 'Get ahead', intent: 'coursework', targetId: resource.id,
        focusKey: `brief-project-${resource.id}`, status: status(resource.id) } });
    break;
  }
  // The admitted institutional crosswalk supplies the class occurrence, account, term and section.
  // A Canvas event in that course supplies the explicit reading instruction and exact material link.
  // Its title is never treated as evidence that a class exists or is a lecture.
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const scheduled = (input.schedules ?? []).filter(schedule => {
    const row = input.planning?.records.find(record => record.localId === schedule.planningRecordId && !record.deleted && record.kind === 'enrollment_package');
    const source = input.planning?.sources.find(candidate => candidate.id === schedule.planningSourceId);
    if (!row || row.kind !== 'enrollment_package' || !source || row.sourceId !== source.id || row.accountScope === 'public' || row.accountScope !== source.accountScope ||
      source.scope.kind !== 'enrollment_term' || source.scope.key !== row.termCode || source.status !== 'complete' || source.completeness !== 'complete' ||
      row.enrollmentState !== 'enrolled' || row.status === 'cancelled' || !row.meetingsComplete ||
      JSON.stringify(row.meetings) !== JSON.stringify(schedule.meetings)) return false;
    const captured = Date.parse(row.provenance.observedAt), checked = Date.parse(source.observedAt), at = Date.parse(input.now ?? new Date().toISOString());
    if (![captured, checked, at].every(Number.isFinite) || captured > at || checked > at || at - captured > 86_400_000 || at - checked > 86_400_000) return false;
    return schedule.complete && schedule.meetings.some(meeting => meeting.kind === 'class' && meeting.mode === 'scheduled' && meeting.startMinute !== null && meeting.startDate !== null && meeting.endDate !== null &&
      [addDays(tomorrow, -1), tomorrow, addDays(tomorrow, 1)].some(day => {
        if (day < meeting.startDate! || day > meeting.endDate! || !meeting.days.includes((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7 + 1)) return false;
        const start = localMinuteInstant(day, meeting.startMinute!, meeting.timezone);
        return start && localTime(start, timeZone).date === tomorrow;
      }));
  });
  for (const lecture of resources) {
    if (items.length >= BRIEF_LIMIT) break;
    if (lecture.kind !== 'event' || !lecture.calendar?.start || localTime(lecture.calendar.start, timeZone).date !== tomorrow) continue;
    const source = sources.find(candidate => candidate.id === lecture.sourceId);
    const meeting = scheduled.find(schedule => source?.accountScope === schedule.accountScope && lecture.courseId === schedule.courseId);
    if (!meeting) continue;
    const matched = linkedMaterials(lecture, resources, links, sources).map(material => ({ material, relation: statedRelation(lecture, material) }))
      .find(pair => pair.relation?.verb === 'read' && pair.relation.modality !== 'optional' && /\bbefore (?:class|lecture)\b/i.test(pair.relation.evidence.text));
    if (!matched?.relation) continue;
    surfacedMaterialIds.add(matched.material.id);
    items.push({ id: `lecture-prep:${lecture.id}:${matched.material.id}`, kind: 'lecture-prep', lecture, material: matched.material, relation: matched.relation, classKind: meeting.classKind === 'lecture' ? 'lecture' : 'class',
      action: { kind: 'open-material', label: 'Open reading', intent: 'study', targetId: matched.material.id,
        focusKey: `brief-reading-${matched.material.id}`, status: combinedStatus(lecture, matched.material, sources) } });
    break;
  }
  for (const prerequisite of input.prerequisites) {
    if (items.length >= BRIEF_LIMIT) break;
    used.add(prerequisite.assignment.id);
    const open = input.canOpenSource;
    items.push({ id: `prerequisite:${prerequisite.assignment.id}:${prerequisite.quiz.id}`, kind: 'prerequisite', prerequisite,
      action: { kind: open ? 'open-quiz' : 'review-quiz', label: open ? 'Open quiz' : 'Review quiz', intent: open ? 'coursework' : 'review',
        targetId: prerequisite.quiz.id, focusKey: `prerequisite-${prerequisite.quiz.id}`, status: status(prerequisite.quiz.id) } });
  }
  // A changed date outranks a relationship on the same item; otherwise the relationship replaces
  // that item's literal instruction quote, because it connects evidence rather than reciting it.
  const changed = new Set(input.passages.filter(p => p.reason === 'changed-date').map(p => p.resource.id));
  if (items.length < BRIEF_LIMIT) {
    for (const context of rankedWork) {
      if (used.has(context.id) || changed.has(context.id) || context.kind !== 'assignment') continue;
      // Only materials the instructions state something about; a bare link defers to other passages.
      const stated = linkedMaterials(context, resources, links, sources).flatMap(material => { const relation = statedRelation(context, material); return relation ? [{ material, relation }] : []; });
      const relation = stated[0]?.relation;
      if (!relation) continue;
      const materials = stated.filter(s => s.relation.verb === relation.verb && s.relation.modality === relation.modality).map(s => s.material);
      used.add(context.id);
      // One material opens directly; several open the assignment's full context (its Related material).
      const single = materials.length === 1 ? materials[0]! : null;
      const target = single ?? context;
      const saved = materials.filter(m => m.text.trim());
      const linkOnly: BriefActionStatus | null = !saved.length ? { state: 'link-only', note: single ? 'Only the link was saved.' : 'Only the links were saved.' } : null;
      const sourceStatus = status(target.id);
      for (const m of materials) surfacedMaterialIds.add(m.id);
      items.push({ id: `linked-materials:${context.id}`, kind: 'linked-materials', context, materials, relation,
        action: { kind: single ? 'open-material' : 'open-assignment', label: single ? 'Open linked material' : 'Open assignment', intent: single ? 'study' : 'coursework',
          targetId: target.id, focusKey: `brief-materials-${context.id}`, status: sourceStatus.state !== 'current' ? sourceStatus : linkOnly ?? sourceStatus } });
      break;
    }
  }
  // Informational news gets a remaining slot after evidenced work and teaching preparation.
  const news = input.passages.find(p => p.resource.kind === 'message' && p.reason === 'information' &&
    /\b(cancelled|canceled|moved|changed|available|posted|will meet|office hours|schedule|policy)\b/i.test(p.span.text));
  if (news && items.length < BRIEF_LIMIT && !used.has(news.resource.id)) {
    used.add(news.resource.id);
    items.push({ id: `passage:${news.resource.id}:${news.span.start}`, kind: 'passage', passage: news, action: null });
  }
  for (const passage of input.passages) {
    if (items.length >= BRIEF_LIMIT) break;
    const r = passage.resource;
    if (used.has(r.id)) continue;
    used.add(r.id);
    let action: BriefAction | null = null;
    if (passage.reason === 'changed-date') action = { kind: 'review-change', label: 'Review change', intent: 'review', targetId: r.id, focusKey: `briefing-${r.id}`, status: status(r.id) };
    else if (r.kind === 'assignment' && !input.launchable.has(r.id) && input.activeWork.some(w => w.id === r.id))
      action = { kind: 'start-work', label: 'Start work', intent: 'coursework', targetId: r.id, focusKey: `start-work-${r.id}`, status: status(r.id) };
    items.push({ id: `passage:${r.id}:${passage.span.start}`, kind: 'passage', passage, action });
  }
  // Older open deadlines stay reachable in one line; they never take Today or Upcoming slots.
  const earlier = input.earlier.filter(r => schedulePlanning(r, timeZone) && !used.has(r.id));
  if (earlier.length) items.push({ id: 'past-due', kind: 'past-due', count: earlier.length,
    action: { kind: 'past-due', label: 'Open past-due work', intent: null, targetId: null, focusKey: 'brief-past-due',
      status: coverage.state === 'complete' ? { state: 'current' }
        : coverage.state === 'none' ? { state: 'unknown', note: 'No source checks are saved, so submission status is unknown.' }
        : { state: 'saved-copy', note: 'Submission status may be incomplete because some sources were not fully checked.' } } });

  const active = items.filter(item => item.kind !== 'past-due').length;
  return { items, coverage, surfacedMaterialIds, fallback: active ? null : { action: 'sources', text: fallbackText(coverage) } };
}

/** Coverage detail for the heading's info control when the brief has passages but coverage is not complete. */
export function coverageNote(coverage: BriefCoverage): string | null {
  if (coverage.state === 'none') return 'No source checks are saved, so this brief may be out of date or missing coursework.';
  if (coverage.state !== 'partial') return null;
  const count = coverage.unchecked === 1 ? '1 of' : `${coverage.unchecked} of`;
  return `${count} ${coverage.total} saved sources ${coverage.unchecked === 1 ? 'was' : 'were'} not fully checked on the last run, so this brief may be missing coursework and actions from those sources open saved copies.${coverage.needsSignIn ? ' Sign in from Saved sources to refresh.' : ''}`;
}

/** Calendar date (YYYY-MM-DD) as a short label, without reinterpreting it in any time zone. */
export function calendarLabel(date: string, weekday = false): string {
  return new Intl.DateTimeFormat(undefined, { ...(weekday ? { weekday: 'short' as const } : {}), month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

/** Empty brief copy. Missing or partial evidence never reads as a clear day. */
export function fallbackText(coverage: BriefCoverage): string {
  if (coverage.state === 'none') return 'No course sources have been checked yet, so there is nothing to brief from.';
  if (coverage.state === 'partial') {
    const count = coverage.unchecked === 1 ? '1 source was' : `${coverage.unchecked} sources were`;
    return `Nothing in the saved instructions or announcements stood out, but ${count} not fully checked. Some coursework may be missing here.${coverage.needsSignIn ? ' Sign in to refresh.' : ''}`;
  }
  return 'Nothing in the saved instructions or announcements adds to your deadlines. Deadlines stay in Today and Upcoming.';
}
