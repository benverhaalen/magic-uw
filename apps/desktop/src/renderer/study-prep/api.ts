// owner: study-prep. The component's calls, over the existing bridge channels only: `query` for the
// 0-token `study.prep` read, `execute` for the `pack` command (generation) and `learning` ops (the
// scoped ask and the FSRS review), `openExternal` for a source's original page.
import type { LearningRequest, LearningResult, StudyPrepKind, StudyPrepResult } from "@magic/contracts";
import { studyPrepPackName } from "@magic/contracts";

export interface PrepScope {
  courseId: string;
  assessmentId: string;
  resourceIds?: string[];
  topicIds?: string[];
}

/** The pack command's answer for a study-prep pack (packages/core/src/study-prep/generate.ts). */
export interface GenerateResult {
  status: string;
  message: string;
  cached: boolean;
  tokens: { in: number; cached: number; out: number } | null;
  current: StudyPrepKind[];
}

export interface AskCitation {
  sourceId: string;
  resourceId: string;
  title: string;
  url: string;
  quote: string;
}
export interface AskAnswer {
  text: string;
  citations: AskCitation[];
  notFound: boolean;
  unavailable?: string;
}

const bridge = () => {
  if (!window.magic) throw new Error("The desktop connection is unavailable.");
  return window.magic;
};

export async function prepQuery(scope: { courseId: string; assessmentId?: string; resourceIds?: string[]; topicIds?: string[] }): Promise<StudyPrepResult> {
  const b = bridge();
  if (!b.query) throw new Error("Scoped queries aren't available in this build.");
  const result = await b.query({ view: "study.prep", ...scope });
  if (result.view !== "study.prep") throw new Error("The app answered a different view.");
  return result;
}

export async function prepGenerate(kinds: StudyPrepKind[], scope: PrepScope): Promise<GenerateResult> {
  const result = await bridge().execute({ type: "pack", pack: studyPrepPackName(kinds), scope });
  const v = result.pack as Partial<GenerateResult> | undefined;
  if (v && typeof v.status === "string" && typeof v.message === "string")
    return { status: v.status, message: v.message, cached: v.cached === true, tokens: v.tokens ?? null, current: Array.isArray(v.current) ? v.current : [] };
  return { status: "failed", message: result.message ?? "Generation isn't available in this build.", cached: false, tokens: null, current: [] };
}

export async function learning(request: LearningRequest): Promise<LearningResult> {
  const result = await bridge().execute({ type: "learning", request });
  if (!result.learning) throw new Error("The study service gave no answer.");
  return result.learning;
}

export async function ask(scope: PrepScope, question: string): Promise<AskAnswer> {
  const r = await learning({ op: "notebook.ask", courseId: scope.courseId, question, scope: { assessmentId: scope.assessmentId, ...(scope.resourceIds ? { resourceIds: scope.resourceIds } : {}) } });
  const data = r.data as Partial<AskAnswer> | undefined;
  if (r.status !== "ok" || !data) return { text: "", citations: [], notFound: false, unavailable: r.message ?? "Asking isn't available right now." };
  return { text: String(data.text ?? ""), citations: Array.isArray(data.citations) ? data.citations : [], notFound: data.notFound === true, ...(data.unavailable ? { unavailable: data.unavailable } : {}) };
}

export function openExternal(url: string): Promise<void> {
  return bridge().openExternal(url);
}

export const operationId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`);
