import { createHash, randomUUID } from "node:crypto";
import { resolveDeadline } from "@magic/domain";
import { buildExplanationRequest, checkCitations, explanationPack, type ExplanationPackRequest, type ExplanationPackResult } from "../../../packages/packs/learning-session";
import type { LearningSessionRepository, LearningCitation, Resource } from "@magic/contracts";

/** These are our projection ports, NOT claimed literal signatures from Nate's unpublished code.
 * Bind repository to canonical learning_sessions/artifacts; study to checked item engines;
 * explain to T13/T12 including recipient consent, sensitive preview, ledger and persisted receipts.
 * No fallback database, item engine, runner or provider is constructed here. */
export interface LearningBackendPorts {
  sessions: LearningSessionRepository;
  study: {
    selectPrepared(input: { accountScope: string; courseId: string; goal: string; sources: LearningSource[]; excludeActivityIds: string[] }): LearningActivity | undefined;
    hint(activityId: string): { text: string; citations: LearningCitation[] } | undefined;
    grade(input: { activityId: string; answer: string }): { text: string; citations: LearningCitation[] } | undefined;
  };
  packs: { explain(request: ExplanationPackRequest, signal: AbortSignal): Promise<ExplanationPackResult> };
}
export const LEARNING_BACKEND_UNAVAILABLE = "Learning tools are not connected in this build. Your course material is still available.";

export function eligibleLearningSource(resource: Resource, at = Date.now()): boolean {
  if (resource.gitlab) return false;
  if (resource.kind !== "assignment") return resource.kind === "material" || resource.kind === "course";
  const locks = resource.deadlines.filter(d => d.kind === "lock");
  if (locks.length) return locks.every(d => d.scopeConfirmed && Number.isFinite(Date.parse(d.value)) && Date.parse(d.value) <= at);
  const due = resolveDeadline(resource.deadlines);
  return !due.conflict && !!due.dueAt && Date.parse(due.dueAt) <= at;
}
import { learningStartSchema, learningActSchema, learningDraftSchema, learningActivityContentSchema, type ContextManifest, type Store, type LearningSession, type LearningSessionView, type LearningSource, type LearningEvent, type LearningActivity } from "@magic/contracts";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
const unavailable = "This learning session is no longer available for the current course and account.";

/** Session orchestration over canonical backend ports; study actions never invoke packs. */
export function createLearningService(store: Store, core: { context(id: string, recipient: "local"): ContextManifest }, ports?: LearningBackendPorts) {
  function backend(): LearningBackendPorts {
    if (!ports) throw new Error(LEARNING_BACKEND_UNAVAILABLE);
    return ports;
  }
  const repository = () => backend().sessions;
  let epoch = 0;
  const active = new Map<string, AbortController>();
  function cancel(id?: string) {
    if (id) { active.get(id)?.abort(); active.delete(id); return; }
    epoch++;
    for (const controller of active.values()) controller.abort();
    active.clear();
  }
  function context(resourceId: string) {
    backend();
    const target = store.resource(resourceId);
    if (!target || target.deleted || target.kind !== "assignment") throw new Error(unavailable);
    const health = store.sources();
    const owner = health.find(s => s.id === target.sourceId);
    if (!owner) throw new Error(unavailable);
    const manifest = core.context(resourceId, "local");
    if (!manifest.allowed) throw new Error(manifest.reason);
    let budget = 4200;
    const sources: LearningSource[] = [];
    for (const id of manifest.resourceIds) {
      const r = store.resource(id), source = r && health.find(s => s.id === r.sourceId);
      if (!r || r.deleted || !eligibleLearningSource(r) || !source || source.accountScope !== owner.accountScope || r.courseId !== target.courseId || source.courseId !== owner.courseId) continue;
      if (budget <= 0 || sources.length >= 6 || !r.text.trim()) continue;
      const text = r.text.slice(0, Math.min(2100, budget)); budget -= text.length;
      sources.push({ resourceId: r.id, contentHash: r.contentHash, title: r.title, url: r.url, observedAt: r.observedAt, text, complete: source.complete && text.length === r.text.length, status: source.status });
    }
    const policyMode = manifest.effectivePolicy?.mode ?? target.policy.mode;
    // Observation timestamps do not invalidate identical evidence. Policy/freshness decisions and permissions do.
    const contextHash = hash({ manifest, privacy: store.privacy(), sources: sources.map(s => ({ resourceId: s.resourceId, contentHash: s.contentHash, text: s.text })), account: owner.accountScope });
    return { target, owner, manifest, sources, policyMode, contextHash };
  }
  function read(id: string) {
    const session = repository().learningSession(id);
    if (!session) throw new Error(unavailable);
    const c = context(session.resourceId);
    if (c.owner.accountScope !== session.accountScope || c.target.courseId !== session.courseId) throw new Error(unavailable);
    return { session, c };
  }
  function view(session: LearningSession, c: ReturnType<typeof context>): LearningSessionView {
    if (c.policyMode === "restricted") return { session, availability: "blocked", reason: "Course policy restricts AI help. Your saved work remains here; review the policy before continuing." };
    if (session.contextHash !== c.contextHash || session.inputHash !== c.target.contentHash)
      return { session, availability: "stale", reason: "Course evidence or data settings changed. Your saved work is preserved. Start a new session using the current sources." };
    return { session, availability: "current", reason: "Study uses prepared material and code checks. Ungraded reflections are not evidence of mastery. Explanation provenance does not establish teaching accuracy." };
  }
  function get(id: string) { const { session, c } = read(id); return view(session, c); }
  function list(resourceId: string) { const c = context(resourceId); return repository().learningSessions(resourceId).filter(s => s.accountScope === c.owner.accountScope && s.courseId === c.target.courseId).map(s => view(s, c)); }
  function saveDraft(raw: unknown) {
    const request = learningDraftSchema.parse(raw), { session, c } = read(request.sessionId);
    if (session.revision !== request.revision) throw new Error("This learning session changed. Reload it; your unsaved draft is still in the editor.");
    if (session.draft === request.draft) return view(session, c);
    const updated = { ...session, draft: request.draft, revision: session.revision + 1, updatedAt: now() };
    repository().putLearningSession(updated, session.revision);
    return view(updated, c);
  }
  function ensureIdle() { if (active.size) throw new Error("A learning request is running. Cancel it before starting another."); }
  function event(session: LearningSession, operationId: string, kind: LearningEvent["kind"], text: string, assistance?: LearningEvent["assistance"]): LearningEvent {
    const previous = session.events.filter(e => e.activityId === session.currentActivityId);
    const current = session.activities.find(a => a.id === session.currentActivityId);
    const seenBefore = repository().learningSessions(session.resourceId).filter(s => s.id !== session.id && s.accountScope === session.accountScope).some(s => s.activities.some(a => a.id === current?.id || a.prompt === current?.prompt));
    return { id: randomUUID(), operationId, activityId: session.currentActivityId, kind, text, assistance: assistance ?? (previous.some(e => e.kind === "hint" || e.kind === "feedback") ? "hinted" : current?.format === "practice" && !seenBefore && !previous.some(e => e.assistance === "exposed") ? "none" : "exposed"), verification: "ungraded", createdAt: now() };
  }
  function append(session: LearningSession, events: LearningEvent[], additions: Partial<LearningSession> = {}) {
    const updated = { ...session, ...additions, events: [...session.events, ...events], revision: session.revision + 1, updatedAt: now() };
    repository().putLearningSession(updated, session.revision);
    return updated;
  }
  function checkedActivity(activity: LearningActivity, sources: LearningSource[], session: LearningSession) {
    const { id, model, digest, createdAt, ...content } = activity;
    if (!id || !model || !digest || Buffer.byteLength(JSON.stringify(activity)) > explanationPack.budget.maxOutputBytes) throw new Error("Prepared activity metadata is incomplete.");
    learningActivityContentSchema.parse(content);
    checkCitations(activity.citations, sources);
    const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
    if (session.activities.some(a => a.id === id || normalize(a.prompt) === normalize(activity.prompt))) throw new Error("This activity was already exposed. Choose a different prepared item.");
    return activity;
  }
  function prepared(session: LearningSession, sources: LearningSource[]) {
    const activity = backend().study.selectPrepared({ accountScope: session.accountScope, courseId: session.courseId, goal: session.goal, sources, excludeActivityIds: session.activities.map(a => a.id) });
    if (!activity) throw new Error("No checked practice is prepared for this material yet. Prepare its course pool before starting practice.");
    if (activity.format !== "practice") throw new Error("The prepared study pool did not return a practice item.");
    return checkedActivity(activity, sources, session);
  }
  async function start(requestId: string, raw: unknown) {
    const request = learningStartSchema.parse(raw);
    const c = context(request.resourceId);
    if (request.inputHash !== c.target.contentHash) throw new Error("This assignment changed. Review its current evidence before starting.");
    const sessionId = hash([request.resourceId, request.operationId]);
    const existing = repository().learningSession(sessionId);
    if (existing) return get(existing.id);
    ensureIdle();
    if (c.policyMode === "restricted") throw new Error("Course policy restricts AI help on this work.");
    if (!c.sources.length) throw new Error("No eligible supporting material is available yet. Refresh the course or add permitted study material before starting.");
    const date = now();
    const session: LearningSession = { id: sessionId, resourceId: request.resourceId, accountScope: c.owner.accountScope, courseId: c.target.courseId, inputHash: request.inputHash, contextHash: c.contextHash, revision: 0, goal: request.goal?.trim() || "Help me understand the key idea and practice applying it.", sources: c.sources, activities: [], events: [], currentActivityId: "", draft: "", createdAt: date, updatedAt: date };
    const controller = new AbortController(), version = epoch;
    active.set(requestId, controller);
    try {
      let activity: LearningActivity;
      if (request.mode === "explain") {
        const pack = buildExplanationRequest({ accountScope: session.accountScope, courseId: session.courseId }, session.goal, c.policyMode, c.sources);
        const result = await backend().packs.explain(pack, controller.signal);
        if (!result.receipt.id || result.receipt.status !== "sent" || result.requestHash !== pack.payloadHash || !result.receipt.payloadHash)
          throw new Error("The explanation is missing its canonical egress receipt.");
        const sentSources = c.sources.flatMap(source => {
          const sent = pack.payload.sources.find(s => s.resourceId === source.resourceId);
          return sent ? [{ ...source, text: sent.text, complete: source.complete && source.text === sent.text }] : [];
        });
        if (result.activity.format === "practice") throw new Error("Explanation packs cannot create unchecked practice items.");
        activity = checkedActivity(result.activity, sentSources, session);
        session.sources = sentSources;
      } else activity = prepared(session, c.sources);
      controller.signal.throwIfAborted();
      const latest = context(session.resourceId);
      if (version !== epoch || latest.contextHash !== c.contextHash || repository().learningSession(session.id)) throw new Error("Course evidence changed. Start again using current sources.");
      session.activities = [activity]; session.currentActivityId = activity.id;
      session.events = [event(session, request.operationId, "exposure", "Activity delivered.")];
      repository().putLearningSession(session, null);
      return view(session, latest);
    } finally { if (active.get(requestId) === controller) active.delete(requestId); }
  }
  async function act(requestId: string, raw: unknown) {
    const request = learningActSchema.parse(raw);
    let { session, c } = read(request.sessionId);
    if (session.events.some(e => e.operationId === request.operationId)) return view(session, c);
    if (session.revision !== request.revision) throw new Error("This learning session changed. Reopen it before continuing.");
    const state = view(session, c);
    if (state.availability !== "current") throw new Error(state.reason);
    ensureIdle();
    if (session.events.length >= 194 || (request.action === "next" && session.activities.length >= 30)) throw new Error("This session reached its limit. Start a new session to continue.");
    const currentEvents = session.events.filter(e => e.activityId === session.currentActivityId);
    const answered = currentEvents.some(e => e.kind === "answer" || e.kind === "skip");
    if ((request.action === "answer" || request.action === "skip") && answered) throw new Error("This activity already has a response. Continue to a new activity.");
    const submitted = currentEvents.find(e => e.kind === "answer");
    if (request.action === "retry_feedback" && (!submitted || currentEvents.some(e => e.kind === "feedback"))) throw new Error("There is no pending feedback to retry.");
    if (request.action === "next" && !answered) throw new Error("Answer or skip this activity before continuing.");
    if (request.action === "hint" && session.activities.find(a => a.id === session.currentActivityId)?.format !== "practice") throw new Error("Reflections have no prepared hint.");
    if (request.action === "hint" && answered) throw new Error("Continue to a new activity for another hint.");
    if (request.action === "skip") return view(append(session, [event(session, request.operationId, "skip", "Skipped by the student.")], { draft: "" }), c);
    if (request.action === "answer") {
      const answer = request.answer?.trim();
      if (!answer) throw new Error("Write a response before requesting feedback.");
      // Persist the student's work before the prepared check; failure cannot discard it.
      session = append(session, [event(session, request.operationId, "answer", answer)], { draft: "" });
    }
    const controller = new AbortController(), version = epoch, expectedRevision = session.revision;
    active.set(requestId, controller);
    try {
      const activity = request.action === "next" ? prepared(session, c.sources) : undefined;
      const feedback = request.action === "hint" ? backend().study.hint(session.currentActivityId)
        : request.action === "next" || session.activities.find(a => a.id === session.currentActivityId)?.format !== "practice" ? undefined : backend().study.grade({ activityId: session.currentActivityId, answer: request.action === "retry_feedback" ? submitted!.text : request.answer! });
      controller.signal.throwIfAborted();
      const latest = read(session.id);
      if (version !== epoch || latest.c.contextHash !== c.contextHash || latest.session.revision !== expectedRevision) throw new Error("The learning request became stale.");
      if (activity) {
        const next = { ...session, activities: [...session.activities, activity], currentActivityId: activity.id };
        session = append(next, [event(next, request.operationId, "exposure", "Prepared activity delivered.")], { draft: "" });
      } else if (feedback) {
        if (!feedback.text || feedback.text.length > 3000) throw new Error("Prepared feedback is unavailable.");
        checkCitations(feedback.citations, c.sources);
        session = append(session, [{ ...event(session, request.operationId, request.action === "hint" ? "hint" : "feedback", feedback.text, "hinted"), citations: feedback.citations }]);
      } else if (request.action === "hint") throw new Error("No prepared hint is available.");
      else session = append(session, [event(session, request.operationId, "feedback", "Your reflection is saved. No deterministic check is available for this response; it remains ungraded.")]);
      return view(session, latest.c);
    } catch {
      // Only a safe marker is stored; runtime errors never expose private model response text.
      const saved = repository().learningSession(session.id);
      if (saved && saved.revision === expectedRevision && epoch === version) {
        session = append(saved, [event(saved, request.operationId, "failure", controller.signal.aborted ? "Request cancelled. Your saved response is preserved." : "The prepared study operation was unavailable or could not be verified. Your saved work is preserved.")]);
      }
      return get(session.id);
    } finally { if (active.get(requestId) === controller) active.delete(requestId); }
  }
  return { list, get, start, act, saveDraft, cancel };
}
