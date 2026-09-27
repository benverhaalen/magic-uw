// owner: study-prep. The item space's calls, over the existing bridge channels only: `query` for the
// 0-token `study.prep` read, `execute` for the `pack` command (generation), `learning` ops (the
// scoped ask and the FSRS review) and the item-type correction, `openExternal` for Canvas.
import type { ItemType, LearningRequest, LearningResult, StudyPrepKind, StudyPrepResult } from "@magic/contracts";


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

// Temporary integration boundary: remove only with the exact-account, selected-source and
// effective policy producer overlay. Owner: Study delivery lead; see team packet 18.
export const STUDY_PRODUCER_HOLD = "Study generation and questions are temporarily unavailable while course permissions and source selection are being connected. You can still browse your materials.";
export async function prepGenerate(_kinds: StudyPrepKind[], _scope: PrepScope): Promise<GenerateResult> {
  return { status: "unavailable", message: STUDY_PRODUCER_HOLD, cached: false, tokens: null, current: [] };
}

export async function learning(request: LearningRequest): Promise<LearningResult> {
  const result = await bridge().execute({ type: "learning", request });
  if (!result.learning) throw new Error("The study service gave no answer.");
  return result.learning;
}

export async function ask(_scope: PrepScope, _question: string): Promise<AskAnswer> {
  return { text: "", citations: [], notFound: false, unavailable: STUDY_PRODUCER_HOLD };
}

export async function correctType(courseId: string, itemId: string, type: ItemType): Promise<string> {
  const result = await bridge().execute({ type: "correct", value: { subject: "item_type", courseId, itemId, type } });
  return result.message ?? "Saved.";
}

export function openExternal(url: string): Promise<void> {
  return bridge().openExternal(url);
}

export const operationId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`);
