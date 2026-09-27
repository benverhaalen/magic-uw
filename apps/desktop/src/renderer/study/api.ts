// owner: study frontend. The one place the study panel talks to the app bridge.
// Every call goes through the existing learning router, `pack` command or scoped query, so
// course scope, account scope, AI policy and egress gates stay in the backend.
import type { LearningRequest, LearningResult, QueryRequest, StudySessionView } from "@magic/contracts";
import type {
  AssignmentAnalyticsData,
  Capability,
  FlashcardSessionView,
  GuideQueryResult,
  PackOutcome,
  PracticePathData,
  PracticeResults,
} from "./types";

const FALLBACK = "Study could not continue. Your saved coursework is still available.";

export async function learning(request: LearningRequest): Promise<LearningResult> {
  const response = await window.magic.execute({ type: "learning", request });
  const result = response.learning;
  if (!result) throw new Error(FALLBACK);
  return result;
}
async function ok(request: LearningRequest): Promise<LearningResult> {
  const result = await learning(request);
  if (result.status !== "ok") throw new Error(result.message || FALLBACK);
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
export function isSession(value: unknown): value is StudySessionView {
  if (!record(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.resourceId === "string" &&
    typeof value.accountScope === "string" &&
    typeof value.revision === "number" &&
    typeof value.draft === "string" &&
    Array.isArray(value.events) &&
    Array.isArray(value.sources)
  );
}
function isFlashcards(value: unknown): value is FlashcardSessionView {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.revision === "number" &&
    typeof value.remaining === "number" &&
    Array.isArray(value.reviewed)
  );
}
function isPath(value: unknown): value is PracticePathData {
  return (
    record(value) &&
    typeof value.courseId === "string" &&
    typeof value.ready === "boolean" &&
    Array.isArray(value.topics) &&
    Array.isArray(value.openSessions) &&
    record(value.cards)
  );
}

/** A saved session (per-material or course practice) or a flashcard session. */
export type ActiveStudy =
  | { kind: "session"; session: StudySessionView }
  | { kind: "flashcards"; flashcards: FlashcardSessionView };

export function readActive(result: LearningResult): ActiveStudy {
  const data = result.data;
  if (record(data) && isSession(data.session)) return { kind: "session", session: data.session };
  if (record(data) && isFlashcards(data.flashcards))
    return { kind: "flashcards", flashcards: data.flashcards };
  throw new Error("The study session could not be read.");
}
export async function activeRequest(request: LearningRequest): Promise<ActiveStudy> {
  return readActive(await ok(request));
}
export async function sessionRequest(request: LearningRequest): Promise<StudySessionView> {
  const active = await activeRequest(request);
  if (active.kind !== "session") throw new Error("The study session could not be read.");
  return active.session;
}

export async function readSessions(resourceId: string): Promise<StudySessionView[]> {
  const result = await ok({ op: "study.sessions", resourceId });
  const data = result.data;
  if (!record(data) || !Array.isArray(data.sessions) || !data.sessions.every(isSession))
    throw new Error("Saved study sessions could not be read.");
  return [...data.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The study context resolver accepts only assignment anchors, so a material page cannot anchor
 * course practice on itself. This finds one saved assignment in the same course and account
 * through the scoped `resources` query; course-wide practice ops use it only to establish course
 * scope, and the backend still checks that its course matches. Null when none can be confirmed.
 */
export async function findCourseAnchor(courseId: string, accountScope: string | undefined): Promise<string | null> {
  if (!accountScope || !window.magic.query) return null;
  const found = await window.magic.query({ view: "resources", courseId, accountScope, kinds: ["assignment"], limit: 1 });
  if (!found || found.view !== "resources") return null;
  const item = found.items.find((r) => r.kind === "assignment" && r.courseId === courseId);
  return item?.id ?? null;
}

/** `practice.path` anchored on an assignment: course practice status, topic states and open sessions. */
export async function readPath(courseId: string, anchorId: string): Promise<Capability<PracticePathData>> {
  const result = await learning({ op: "practice.path", courseId, anchorIds: [anchorId] });
  if (result.status === "not_built") return { state: "unconnected" };
  if (result.status === "ok" && isPath(result.data)) return { state: "ok", data: result.data };
  if (result.status === "unavailable")
    return {
      state: "unavailable",
      message: result.message ?? "No practice is ready yet.",
      ...(isPath(result.data) ? { data: result.data } : {}),
    };
  return { state: "failed", message: result.message || "Course practice could not be read." };
}

export async function readResults(sessionId: string): Promise<PracticeResults> {
  const result = await ok({ op: "study.submit", sessionId });
  const data = result.data;
  if (!record(data) || !record(data.results) || typeof data.results.answered !== "number")
    throw new Error("Practice results could not be read.");
  return data.results as unknown as PracticeResults;
}

// Before the integrator merges main, the bridge rejects the analytics ops and the guide query at
// schema validation. That rejection means "not in this build", not a study failure.
function schemaRejection(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : String(cause);
  return /invalid (?:input|discriminator|union|option|enum|literal|value)|invalid_union|invalid_value|invalid_type|unrecognized_keys|no matching discriminator/i.test(
    text,
  );
}

/** `analytics.assignment` (main c5f0231): the topics and materials behind one assignment. */
export async function readAssignmentAnalytics(
  courseId: string,
  anchorId: string,
  assignmentId: string,
): Promise<Capability<AssignmentAnalyticsData>> {
  try {
    const result = await learning({
      op: "analytics.assignment",
      courseId,
      anchorIds: [anchorId],
      assignmentId,
    } as unknown as LearningRequest);
    if (result.status === "not_built") return { state: "unconnected" };
    if (result.status === "ok" && record(result.data) && Array.isArray(result.data.topics))
      return { state: "ok", data: result.data as unknown as AssignmentAnalyticsData };
    if (result.status === "unavailable")
      return { state: "unavailable", message: result.message ?? "Nothing is linked yet." };
    if (/invalid analytics request|invalid request/i.test(result.message ?? ""))
      return { state: "unconnected" };
    return { state: "failed", message: result.message || "Assignment topics could not be read." };
  } catch (cause) {
    if (schemaRejection(cause)) return { state: "unconnected" };
    return { state: "failed", message: cause instanceof Error ? cause.message : "Assignment topics could not be read." };
  }
}

export interface GuideScope {
  courseId: string;
  moduleId?: string;
}
/** The personalised study guide (main c5f0231 `guide` query, 0 model calls). */
export async function readGuide(scope: GuideScope): Promise<Capability<GuideQueryResult>> {
  if (!window.magic.query) return { state: "unconnected" };
  try {
    const result = (await window.magic.query({
      view: "guide",
      courseId: scope.courseId,
      kind: "guide",
      ...(scope.moduleId ? { moduleId: scope.moduleId } : {}),
    } as unknown as QueryRequest)) as unknown;
    if (!record(result) || result.view !== "guide" || typeof result.status !== "string")
      return { state: "unconnected" };
    return { state: "ok", data: result as unknown as GuideQueryResult };
  } catch (cause) {
    if (schemaRejection(cause)) return { state: "unconnected" };
    return { state: "failed", message: cause instanceof Error ? cause.message : "The study guide could not be read." };
  }
}

/**
 * Runs one generation pack after an explicit student action. The backend applies the course AI
 * policy, the student's consent and preview gates, and records receipts; this never grants consent.
 */
export async function runPack(
  pack: "quiz" | "cards" | "guide",
  scope: { courseId: string; resourceIds?: string[]; moduleId?: string },
): Promise<PackOutcome> {
  const response = await window.magic.execute({ type: "pack", pack, scope });
  const result = response.pack;
  if (!record(result) || typeof result.status !== "string" || typeof result.message !== "string") {
    if (response.message) return { status: "unknown_pack", message: response.message, pack, cached: false, counts: { generated: 0, accepted: 0, dropped: 0 }, receiptIds: [] };
    throw new Error("The result of making study material could not be read.");
  }
  return result as unknown as PackOutcome;
}
