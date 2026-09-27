// owner: study-prep. The item space's calls, over the existing bridge channels only: `query` for the
// 0-token `study.prep` read, `execute` for the `pack` command (generation), `learning` ops (the
// scoped ask and the FSRS review) and the item-type correction, `openExternal` for Canvas.
import type { ItemType, LearningRequest, LearningResult, StudyPrepKind, StudyPrepResult } from "@magic/contracts";
import { studyPrepPackName } from "@magic/contracts";

export interface PrepScope {
  courseId: string;
  itemId: string;
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

export async function prepQuery(req: { courseId?: string; itemId?: string; resourceIds?: string[]; topicIds?: string[] }): Promise<StudyPrepResult> {
  const b = bridge();
  if (!b.query) throw new Error("Scoped queries aren't available in this build.");
  const result = await b.query({ view: "study.prep", ...req });
  if (result.view !== "study.prep") throw new Error("The app answered a different view.");
  return result;
}

export async function prepGenerate(kinds: StudyPrepKind[], scope: PrepScope): Promise<GenerateResult> {
  // The pack scope names the item in `assessmentId` (the item's id: an assessment, assignment, quiz or material).
  const { itemId, ...rest } = scope;
  const result = await bridge().execute({ type: "pack", pack: studyPrepPackName(kinds), scope: { ...rest, assessmentId: itemId } });
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
  const r = await learning({ op: "notebook.ask", courseId: scope.courseId, question, scope: { assessmentId: scope.itemId, ...(scope.resourceIds ? { resourceIds: scope.resourceIds } : {}) } });
  const data = r.data as Partial<AskAnswer> | undefined;
  if (r.status !== "ok" || !data) return { text: "", citations: [], notFound: false, unavailable: r.message ?? "Asking isn't available right now." };
  return { text: String(data.text ?? ""), citations: Array.isArray(data.citations) ? data.citations : [], notFound: data.notFound === true, ...(data.unavailable ? { unavailable: data.unavailable } : {}) };
}

export async function correctType(courseId: string, itemId: string, type: ItemType): Promise<string> {
  const result = await bridge().execute({ type: "correct", value: { subject: "item_type", courseId, itemId, type } });
  return result.message ?? "Saved.";
}

export function openExternal(url: string): Promise<void> {
  return bridge().openExternal(url);
}

export const operationId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`);
