/**
 * `assignment.workspace {resourceId}` (owner: page-views): everything the student needs for one
 * assignment in one read. Code ranks the resources (the pipeline's reference graph first), every
 * row carries its reason and a quote from its source, and a field nothing supports is listed in
 * `missing`. Reads only; 0 tokens.
 */
import type {
  AssignmentWorkspace,
  PageChange,
  PageEvidence,
  PageMissing,
  PageResource,
  PageTool,
  Resource,
} from "@magic/contracts";
import { effortBand, resolveDeadline, type RailResource } from "@magic/domain";
import { effectiveCoursePolicy } from "../../../domain/src/course-intelligence";
import { classifyHost } from "../../../connectors/src/space-hosts";
import { canonicalAssessment, references, type Reference } from "../graph/references";
import { normaliseUrl, type Res } from "../graph/course-index";
import { approachFacts, approachHash, readApproach } from "./approach";
import {
  PageViewError,
  claimEvidence,
  clip,
  contextFor,
  copiesOf,
  courseOf,
  deadlineClaims,
  factHash,
  fieldEvidence,
  included,
  lineEvidence,
  ltiUrls,
  namer,
  noteSummary,
  openFor,
  quoteEvidence,
  resourceRow,
  roleOf,
  structureEvidence,
  textEvidence,
  titleEvidence,
  type ViewContext,
  type ViewStore,
} from "./common";
import { readinessFor, topicReader } from "./readiness";
import { gradeBank, offerRow } from "./grades";
import { examKind } from "../../../learning/src/analytics/references";

/** Spec C5: the work view shows at most five resources, plus the tools to open. */
export const WORK_VIEW_RESOURCES = 5;
const MORE_CAP = 25;
const TEXT_CAP = 12_000;
/** Host kinds that are platforms to open, not material to read (the space host table's kinds). */
export const TOOL_KINDS = new Set(["homework", "polling", "qa", "proctoring", "originality", "survey", "lti_tool", "courseware", "code", "portal"]);
const STRENGTH_WORDS: Record<string, string> = {
  direct: "linked in instructions",
  named: "named in prompt",
  module: "same module",
  syllabus: "syllabus names it",
  covers: "covers it",
};
const NO_DEADLINE = { dueAt: null, planningAt: null, conflict: false, claims: [], reason: "" };

function rail(r: Resource): RailResource {
  const types = r.submissionTypes ?? [];
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    courseId: r.courseId,
    courseName: r.courseName,
    completed: r.completed,
    submitted: r.submitted,
    deadline: NO_DEADLINE,
    kindLabel: types.length === 1 && types[0] === "online_quiz" ? "quiz" : types.length === 1 && types[0] === "discussion_topic" ? "discussion" : null,
    externalId: r.externalId,
    points: r.points,
    assignmentGroupId: r.assignmentGroupId ?? null,
    ...(r.assignmentGroup ? { assignmentGroup: r.assignmentGroup } : {}),
    ...(r.submission ? { submission: r.submission } : {}),
  };
}
const quotedIn = (reason: string) => /"([^"]{3,})"/.exec(reason)?.[1]?.replace(/…$/, "") ?? null;

/** Evidence for one graph reference: the quote its reason carries, found in its source. */
function referenceEvidence(ctx: ViewContext, ref: Reference, copies: Res[], target: Res | undefined): PageEvidence[] {
  const quote = quotedIn(ref.reason);
  if (ref.strength === "direct" || ref.strength === "named") {
    for (const c of copies) {
      const hit = quote ? quoteEvidence(ctx, c, quote) : null;
      if (hit) return [hit];
    }
    const own = copies[0]!;
    return [structureEvidence(ctx, own, "links", quote ?? ref.externalUrl ?? target?.url ?? ref.title)];
  }
  if (ref.strength === "module") {
    const m = /"([^"]+)"/.exec(ref.reason)?.[1];
    const entry = [...ctx.index.modules.values()].find((x) => x.title === m);
    const header = entry?.resourceId ? ctx.index.resources.get(entry.resourceId) ?? null : null;
    return [structureEvidence(ctx, header, "module", m ?? ref.reason, "module")];
  }
  if (ref.strength === "syllabus" && ctx.index.syllabus) {
    const hit = quote ? quoteEvidence(ctx, ctx.index.syllabus, quote) : null;
    if (hit) return [hit];
  }
  if (ref.strength === "covers" && target) {
    if (quote) {
      const inTitle = target.title.indexOf(quote);
      if (inTitle >= 0) return [titleEvidence(ctx, target, inTitle, inTitle + quote.length)];
      const hit = quoteEvidence(ctx, target, quote);
      if (hit) return [hit];
    }
    return [structureEvidence(ctx, target, "module", quote ?? ref.reason, "module")];
  }
  return [structureEvidence(ctx, target ?? null, "reference", quote ?? ref.reason)];
}

interface Candidate {
  key: string;
  r: Res | null;
  url: string | null;
  title: string;
  kind: string;
  strength: string;
  score: number;
  reasons: string[];
  evidence: PageEvidence[];
}

export function assignmentWorkspace(store: ViewStore, resourceId: string, now: string): AssignmentWorkspace {
  const { course, resource } = courseOf(store, resourceId);
  const ctx = contextFor(store, course, now);
  const self = ctx.index.resources.get(resource.id);
  if (!self) throw new PageViewError("This item isn't in its course's captured materials.");
  const a = canonicalAssessment(ctx.index, self);
  if (a.kind !== "assignment") throw new PageViewError("This item isn't an assignment.");
  if (!included(ctx)(a)) throw new PageViewError("This course is excluded. Include it in Sources to see this assignment.");
  const copies = copiesOf(ctx, a);
  const own = new Set(copies.map((c) => c.id));
  const missing: PageMissing[] = [];
  const miss = (field: string, text: string) => missing.push({ field, text });

  // ---------- Header ----------
  const { claims, unresolved } = deadlineClaims(ctx, a, copies);
  const resolution = resolveDeadline(claims, unresolved);
  const agreeing = (at: string) => claims.filter((c) => c.kind !== "lock" && c.scopeConfirmed && Date.parse(c.value) === Date.parse(at)).map((c) => claimEvidence(ctx, c));
  const due = resolution.dueAt ? { at: resolution.dueAt, evidence: agreeing(resolution.dueAt).slice(0, 4) } : null;
  if (!due) miss("due", resolution.conflict ? "The due date sources disagree; both are listed under the deadline." : "No due date posted.");
  const dated = (field: "lockAt" | "unlockAt") => {
    const holder = copies.find((c) => c[field]);
    return holder?.[field] ? { at: holder[field]!, evidence: [fieldEvidence(ctx, holder, field, holder[field])] } : null;
  };
  const lock = dated("lockAt");
  const unlock = dated("unlockAt");
  const points = a.points !== null ? { value: a.points, evidence: fieldEvidence(ctx, a, "points", a.points) } : null;
  if (!points) miss("points", "No points posted.");

  // The grade bank (grades.ts): account-scoped, computed only on a complete capture (FDB-001).
  const bank = gradeBank(ctx);
  const grade = bank.shareOf(a);
  const gradeWeight = {
    basis: grade.basis === "computed" ? ("computed" as const) : grade.basis === "unknown" ? ("unknown" as const) : ("listed" as const),
    percent: grade.sharePercent ?? grade.maxMovePercent,
    text: grade.text,
    evidence: grade.evidence,
  };
  if (grade.basis === "unknown") miss("gradeWeight", grade.text);

  const submission = a.submission ?? copies.find((c) => c.submission)?.submission ?? null;
  const types = a.submissionTypes ?? copies.find((c) => c.submissionTypes?.length)?.submissionTypes ?? [];
  const statusEvidence: PageEvidence[] = submission ? [fieldEvidence(ctx, a, "submission", { workflowState: submission.workflowState ?? null, late: submission.late ?? null, missing: submission.missing ?? null, submittedAt: submission.submittedAt ?? null })] : [];
  const state: AssignmentWorkspace["header"]["status"]["state"] = submission?.excused
    ? "excused"
    : submission?.missing
      ? "missing"
      : submission?.late
        ? "late"
        : submission?.workflowState === "graded"
          ? "graded"
          : submission?.submittedAt || a.submitted === true || submission?.workflowState === "submitted" || submission?.workflowState === "pending_review"
            ? "submitted"
            : types.length && types.every((t) => ["none", "not_graded", "on_paper"].includes(t))
              ? "no_submission"
              : a.submitted === false || submission?.workflowState === "unsubmitted"
                ? "not_submitted"
                : "unknown";
  if (state === "unknown") miss("status", "No submission status captured.");
  if (!types.length) miss("submissionTypes", "No submission type posted.");

  const effort = effortBand(rail(a));
  if (!effort) miss("effort", "No effort estimate: the title and type don't match a known kind of work.");
  miss("startBy", "No start-by time: the agenda's time estimate isn't part of this build.");

  const profile = store.courseIntelligence().find((p) => p.accountScope === course.accountScope && p.courseId === course.courseId);
  const policy = effectiveCoursePolicy(profile, a);
  const policyEvidence: PageEvidence[] = (profile?.claims ?? [])
    .filter((c) => c.kind === "ai_policy" && (c.scope === "course" || c.assignmentId === a.id))
    .flatMap((c) => c.evidence)
    .slice(0, 4)
    .map((e) => {
      const r = ctx.index.resources.get(e.resourceId);
      const live = r && e.start !== undefined && e.end !== undefined && r.text.slice(e.start, e.end) === e.quote ? textEvidence(ctx, r, e.start, e.end) : null;
      return live ?? { resourceId: e.resourceId, source: r?.title ?? "Course profile", origin: "course_profile" as const, url: e.url, quote: e.quote, basis: "field" as const, field: e.field, start: e.start ?? null, end: e.end ?? null, statedAt: null };
    });
  if (!policyEvidence.length) miss("aiPolicy", "No AI-use policy found for this course or assignment.");

  // ---------- Instructions ----------
  const text = a.text ?? "";
  if (!text.trim()) miss("instructions", "No description posted in Canvas.");
  const rubric = (a.rubric ?? copies.find((c) => c.rubric?.length)?.rubric ?? []).slice(0, 30).map((c) => ({
    criterion: clip(c.description ?? c.longDescription ?? "", 500),
    points: c.points ?? null,
    ratings: (c.ratings ?? []).slice(0, 10).map((x) => ({ description: clip(x.description ?? x.longDescription ?? "", 200), points: x.points ?? null })),
  }));
  if (!rubric.length) miss("rubric", "No rubric posted.");

  // ---------- Resources: the reference graph, weekly syllabus readings, topic coverage ----------
  const candidates = new Map<string, Candidate>();
  const tools: PageTool[] = [];
  const toolKeys = new Set<string>();
  const addTool = (tool: PageTool) => {
    const key = normaliseUrl(tool.url) ?? tool.url;
    if (toolKeys.has(key)) return;
    toolKeys.add(key);
    tools.push(tool);
  };
  const spaces = store.courseSpaces(course);
  const spaceFor = (url: string) => {
    const key = normaliseUrl(url);
    return key ? spaces.find((s) => normaliseUrl(s.url) === key) : undefined;
  };
  const offer = (c: Omit<Candidate, "reasons" | "key"> & { reason: string }) => {
    const key = c.r?.id ?? (c.url ? normaliseUrl(c.url) ?? c.url : c.title);
    if (c.r && own.has(c.r.id)) return;
    const kept = candidates.get(key);
    if (!kept) {
      candidates.set(key, { ...c, key, reasons: [c.reason] });
      return;
    }
    if (!kept.reasons.includes(c.reason)) kept.reasons.push(c.reason);
    kept.evidence.push(...c.evidence.filter((e) => !kept.evidence.some((k) => k.quote === e.quote)));
    if (c.score > kept.score) Object.assign(kept, { strength: c.strength, score: c.score });
  };
  const refs = references(store, a.id);
  const lti = ltiUrls(ctx);
  for (const ref of refs) {
    const target = ref.resourceId ? ctx.index.resources.get(ref.resourceId) : undefined;
    const url = target?.url ?? ref.externalUrl;
    // A Canvas tool's launch URL is listed under tools (open from Canvas), never as a link to open.
    if (!target && url && lti.has(normaliseUrl(url) ?? url)) continue;
    if (!target && url) {
      let host: string | null = null;
      try {
        host = new URL(url).hostname;
      } catch {
        host = null;
      }
      const rule = host ? classifyHost(host).rule : null;
      if (rule && TOOL_KINDS.has(rule.kind)) {
        const space = spaceFor(url);
        const open = openFor(ctx, null, url);
        addTool({
          name: rule.name,
          host: host!,
          kind: rule.kind,
          url,
          accessState: space?.accessState ?? "unknown",
          accessReason: space?.accessReason ?? null,
          action: { kind: open.how === "browser" ? "open_in_browser" : open.how === "canvas" ? "open_from_canvas" : "none", url: open.how === "none" ? null : open.url, note: open.note },
          launchEffect: rule.launchEffect ?? null,
          reason: STRENGTH_WORDS[ref.strength] ?? ref.reason,
          evidence: referenceEvidence(ctx, ref, copies, undefined),
        });
        continue;
      }
    }
    const role = roleOf(ctx, target);
    const words = ref.strength === "module" ? `same module: "${/"([^"]+)"/.exec(ref.reason)?.[1] ?? ""}"` : STRENGTH_WORDS[ref.strength] ?? ref.reason;
    offer({
      r: target ?? null,
      url: url ?? null,
      title: ref.title,
      kind: ref.kind,
      strength: ref.strength,
      score: ref.weight + (role === "lecture" || role === "reading" ? 0.05 : 0) - (role === "homework" || role === "solutions" ? 0.1 : 0) - (target ? 0 : 0.05),
      reason: ref.reason.includes("not captured") ? `${words} (not captured)` : words,
      evidence: referenceEvidence(ctx, ref, copies, target),
    });
  }

  // Syllabus readings for the assignment's week: a syllabus line that names the week and a material.
  const syllabus = ctx.index.syllabus;
  const weekFact = copies.flatMap((c) => store.materialFacts(c.id)).find((f) => f.kind === "session" && f.value.startsWith("week:"));
  const courseStart = [...ctx.index.resources.values()].find((r) => r.kind === "course")?.course?.startAt ?? null;
  const dueAt = resolution.dueAt ?? a.dueAt ?? null;
  const week = weekFact
    ? Number(weekFact.value.slice(5))
    : courseStart && dueAt && Date.parse(dueAt) > Date.parse(courseStart)
      ? Math.floor((Date.parse(dueAt) - Date.parse(courseStart)) / (7 * 86_400_000)) + 1
      : null;
  if (syllabus?.text && week) {
    const weekLine = new RegExp(`\\bweek\\s*0?${week}\\b`, "i");
    const materials = [...ctx.index.pageBySlug.values(), ...ctx.index.fileById.values()].filter((m) => !own.has(m.id) && m.id !== syllabus.id);
    let offset = 0;
    for (const line of syllabus.text.split("\n")) {
      if (weekLine.test(line)) {
        const lower = line.toLowerCase();
        for (const m of materials) {
          const name = m.title.replace(/\.[a-z0-9]{2,5}$/i, "").trim().toLowerCase();
          if (name.length < 6 || !lower.includes(name)) continue;
          const role = roleOf(ctx, m);
          if (role === "admin" || role === "syllabus") continue;
          const lead = line.length - line.trimStart().length;
          const ev = textEvidence(ctx, syllabus, offset + lead, offset + lead + clip(line.trim(), 300).replace(/…$/, "").length);
          offer({ r: m, url: m.url, title: m.title, kind: ctx.index.contentType(m) ?? "page", strength: "syllabus", score: 0.4, reason: `syllabus reading for week ${week}`, evidence: ev ? [ev] : [] });
        }
      }
      offset += line.length + 1;
    }
  }
  // Materials covering the assignment's topics (the student's concept map, when there is one).
  const learning = store.learning;
  if (learning) {
    const concepts = learning.concepts(`${course.accountScope}:${course.courseId}`).filter((c) => c.status === "active" && c.kind === "concept");
    for (const topic of concepts.filter((c) => c.sources.some((s) => own.has(s.resourceId)))) {
      const label = topic.studentLabel ?? topic.label;
      for (const s of topic.sources) {
        const m = ctx.index.resources.get(s.resourceId);
        if (!m || own.has(m.id)) continue;
        const ev = s.quoteValid && m.text.slice(s.start, s.end) === s.quote ? textEvidence(ctx, m, s.start, s.end) : null;
        if (!ev) continue;
        offer({ r: m, url: m.url, title: m.title, kind: ctx.index.contentType(m) ?? "page", strength: "topic", score: 0.35, reason: `covers topic "${label}"`, evidence: [ev] });
      }
    }
  }
  const ranked = [...candidates.values()]
    .map((c) => ({ ...c, score: c.score + 0.05 * (c.reasons.length - 1) }))
    .sort((x, y) => y.score - x.score || x.title.localeCompare(y.title))
    .map((c) =>
      resourceRow(ctx, c.r, { title: c.title, kind: c.kind, reason: c.reasons[0]!, reasons: c.reasons, strength: c.strength, score: c.score, evidence: c.evidence.slice(0, 3), url: c.url }),
    );
  if (!ranked.length) miss("resources", "No resource is linked to this assignment, named in it or in its module.");

  // ---------- Tools: course spaces seen in it, its module's Canvas tools, an external-tool submission ----------
  for (const s of spaces) {
    if (!s.foundInResourceId || !own.has(s.foundInResourceId)) continue;
    if (s.storeOrLink !== "link" && s.route !== "lti") continue;
    const rule = classifyHost(s.host).rule;
    const open = openFor(ctx, null, s.url);
    const lti = s.route === "lti" || open.how === "canvas";
    addTool({
      name: rule.kind === "unknown" ? s.title ?? s.host : rule.name,
      host: s.host,
      kind: s.kind,
      url: s.url,
      accessState: s.accessState,
      accessReason: s.accessReason,
      action: lti
        ? { kind: "open_from_canvas", url: ctx.courseUrl ? `${ctx.courseUrl}/modules` : null, note: "A Canvas tool: open it from Canvas. The app never launches it." }
        : { kind: open.how === "browser" ? "open_in_browser" : "none", url: open.how === "browser" ? open.url : null, note: open.note },
      launchEffect: rule.launchEffect ?? null,
      reason: "linked in instructions",
      evidence: [structureEvidence(ctx, a, "course_spaces", s.url)],
    });
  }
  for (const moduleId of copies.flatMap((c) => ctx.index.modulesOf.get(c.id) ?? [])) {
    const m = ctx.index.modules.get(moduleId);
    for (const item of m?.items ?? []) {
      if (item.moduleItem?.type !== "ExternalTool") continue;
      addTool({
        name: item.moduleItem.title ?? item.title,
        host: (() => {
          try {
            return new URL(item.url).hostname;
          } catch {
            return "";
          }
        })(),
        kind: "lti_tool",
        url: item.url,
        accessState: "unknown",
        accessReason: null,
        action: { kind: "open_from_canvas", url: ctx.courseUrl ? `${ctx.courseUrl}/modules` : null, note: "A Canvas tool in this module: open it from Canvas. The app never launches it." },
        launchEffect: null,
        reason: `same module: "${m!.title}"`,
        evidence: [structureEvidence(ctx, item, "moduleItem.type", "ExternalTool", "module")],
      });
    }
  }
  if (types.includes("external_tool"))
    addTool({
      name: "Canvas external tool (submission)",
      host: (() => {
        try {
          return new URL(a.url).hostname;
        } catch {
          return "";
        }
      })(),
      kind: "lti_tool",
      url: a.url,
      accessState: "unknown",
      accessReason: null,
      action: { kind: "open_from_canvas", url: a.url, note: "You submit through a tool inside this Canvas assignment. Open it in Canvas yourself; the app never launches it." },
      launchEffect: null,
      reason: "submission type is an external tool",
      evidence: [fieldEvidence(ctx, a, "submissionTypes", types)],
    });

  // ---------- Related lectures and the student's notes ----------
  const lectureRows = ranked.filter((r) => r.role === "lecture").slice(0, WORK_VIEW_RESOURCES);
  const moduleIds = new Set(copies.flatMap((c) => ctx.index.modulesOf.get(c.id) ?? []));
  const moduleKeys = new Set([...moduleIds, ...[...moduleIds].map((id) => ctx.index.modules.get(id)?.resourceId).filter((x): x is string => !!x)]);
  const linkedIds = new Set(ranked.map((r) => r.resourceId).filter((x): x is string => !!x));
  const notes = store.notes
    ? store.notes
        .notes({ accountScope: course.accountScope, courseId: course.courseId })
        .flatMap((n) => {
          const byModule = n.moduleId && moduleKeys.has(n.moduleId);
          const byLink = store.notes!.links(n.id).find((l) => linkedIds.has(l.resourceId));
          if (!byModule && !byLink) return [];
          return [
            {
              ...noteSummary(store.notes!, n),
              reason: byModule ? `your note from the same module${n.moduleName ? `, "${n.moduleName}"` : ""}` : `your note links ${ranked.find((r) => r.resourceId === byLink!.resourceId)?.title ?? "a linked material"}`,
            },
          ];
        })
        .slice(0, 5)
    : [];
  if (!lectureRows.length && !notes.length) miss("lectures", "No lecture material or note from this assignment's module was found.");

  // ---------- Changes: announcements, discussions and course mail that name it; date changes ----------
  const names = namer(ctx, a.title, a.externalId);
  const changes: PageChange[] = [];
  for (const r of ctx.index.resources.values()) {
    const scope = r.scope.split(":")[0];
    if (scope !== "announcements" && scope !== "discussions") continue;
    const byTitle = names.text(r.title);
    const byLink = names.links(r);
    const line = lineEvidence(ctx, r, (l) => names.text(l), r.createdAt ?? null);
    if (!byTitle && !byLink && !line) continue;
    const explicit = claims.find((c) => c.authority === "explicit_change" && c.span?.resourceId === r.id);
    changes.push({
      kind: scope === "announcements" ? "announcement" : "discussion",
      at: r.createdAt ?? r.updatedAt ?? null,
      title: r.title,
      reason: explicit ? "announces a date change" : byLink ? "links to it" : byTitle ? "names it in the title" : "names it",
      evidence: explicit ? [claimEvidence(ctx, explicit)] : line ? [line] : byTitle ? [titleEvidence(ctx, r)] : [structureEvidence(ctx, r, "links", a.url)],
      oldValue: explicit?.supersedes ?? null,
      newValue: explicit?.value ?? null,
      open: openFor(ctx, r),
    });
  }
  for (const source of ctx.sources.values()) {
    if (source.kind !== "mail") continue;
    for (const m of store.sourceResources(source.id)) {
      if (m.mail?.courseId !== course.courseId || !(names.text(m.title) || names.text(m.mail.preview))) continue;
      changes.push({
        kind: "mail",
        at: m.mail.receivedAt,
        title: m.title,
        reason: "course mail that names it",
        evidence: [names.text(m.title) ? titleEvidence(ctx, m) : fieldEvidence(ctx, m, "mail.preview", m.mail.preview, "mail")],
        oldValue: null,
        newValue: null,
        open: openFor(ctx, null, m.url),
      });
    }
  }
  const seenChange = new Set<string>();
  for (const c of copies)
    for (const ch of store.changes({ resourceId: c.id, limit: 20 })) {
      if (ch.type !== "date_changed" && ch.type !== "requirements_changed") continue;
      const key = `${ch.type}:${JSON.stringify(ch.newValues)}`;
      if (seenChange.has(key)) continue;
      seenChange.add(key);
      changes.push({
        kind: ch.type === "date_changed" ? "date_change" : "requirements_change",
        at: ch.observedAt,
        title: ch.type === "date_changed" ? "Canvas date changed" : "Canvas requirements changed",
        reason: `seen in ${ch.scope}`,
        evidence: [fieldEvidence(ctx, c, Object.keys(ch.newValues).join(",") || ch.type, ch.newValues, c.calendar ? "calendar" : "canvas", "Canvas change record")],
        oldValue: Object.keys(ch.oldValues).length ? JSON.stringify(ch.oldValues) : null,
        newValue: Object.keys(ch.newValues).length ? JSON.stringify(ch.newValues) : null,
        open: openFor(ctx, a),
      });
    }
  changes.sort((x, y) => (y.at ?? "").localeCompare(x.at ?? ""));

  // ---------- Readiness ----------
  const readiness = readinessFor(ctx, { resourceId: a.id }, [a.id]);
  if (readiness.status !== "ok") miss("readiness", readiness.message);

  const page: Omit<AssignmentWorkspace, "approach"> = {
    view: "assignment.workspace",
    generatedAt: now,
    factHash: "",
    course: { ...course, courseName: ctx.courseName, url: ctx.courseUrl },
    header: {
      resourceId: a.id,
      title: a.title,
      url: a.url,
      kind: rail(a).kindLabel,
      due,
      lock,
      unlock,
      deadline: {
        dueAt: resolution.dueAt,
        conflict: resolution.conflict,
        reason: resolution.reason,
        preferredAt: resolution.preferredAt ?? null,
        basis: resolution.basis ?? null,
        notes: (resolution.notes ?? []).slice(0, 8),
      },
      points,
      gradeWeight,
      submissionTypes: types,
      status: { state, late: submission?.late ?? null, missing: submission?.missing ?? null, submittedAt: submission?.submittedAt ?? null, evidence: statusEvidence },
      startBy: null,
      effort: effort ? { lowMin: effort.lowMin, highMin: effort.highMin, basis: effort.basis } : null,
      aiPolicy: {
        mode: policy.mode,
        conflict: policy.conflict,
        evidence: policyEvidence,
        text: policyEvidence.length ? `AI use: ${policy.mode}${policy.conflict ? " (sources disagree; the restriction wins)" : ""}.` : "No AI-use policy found; the app coaches conservatively.",
      },
    },
    instructions: { text: clip(text, TEXT_CAP), textLength: text.length, truncated: text.length > TEXT_CAP, rubric, canvas: { how: "browser", url: a.url, resourceId: a.id, note: "The assignment in Canvas." } },
    resources: ranked.slice(0, WORK_VIEW_RESOURCES),
    moreResources: { count: Math.max(0, ranked.length - WORK_VIEW_RESOURCES), items: ranked.slice(WORK_VIEW_RESOURCES, WORK_VIEW_RESOURCES + MORE_CAP) },
    tools,
    lectures: { materials: lectureRows, notes },
    changes: changes.slice(0, 12),
    readiness,
    grade,
    offers: examKind(a.title, types) || a.scope.startsWith("quizzes") ? offerRow(ctx, bank, a, topicReader(ctx)).offers : [],
    missing,
  };
  page.factHash = hashPage(page);
  const facts = approachFacts(page);
  const approach = readApproach(ctx, approachHash(facts), facts, { courseId: course.courseId, resourceIds: [a.id] });
  return { ...page, approach };
}

/** The page's fact hash: everything shown except when it was generated and how fresh a source is. */
export function hashPage(page: object): string {
  return factHash(JSON.parse(JSON.stringify(page, (k, v) => (k === "generatedAt" || k === "freshness" || k === "factHash" || k === "approach" ? undefined : v))));
}
export type { PageResource };
