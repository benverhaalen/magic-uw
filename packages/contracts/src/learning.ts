import { z } from "zod";
const id = z.string().min(1).max(500);
export const learningCitationSchema = z.object({ resourceId: id, contentHash: id, quote: z.string().min(1).max(1200), start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict();
export const learningActivityContentSchema = z.object({ format: z.enum(["explanation", "worked_example", "practice"]), title: z.string().min(1).max(160), content: z.string().min(1).max(4000), prompt: z.string().min(1).max(1000), reason: z.string().min(1).max(600), citations: z.array(learningCitationSchema).min(1).max(6) }).strict();
export type LearningCitation = z.infer<typeof learningCitationSchema>;
export type LearningActivityContent = z.infer<typeof learningActivityContentSchema>;
export interface LearningSource { resourceId: string; contentHash: string; title: string; url: string; observedAt: string; text: string; complete: boolean; status: string; }
export interface LearningActivity extends LearningActivityContent { id: string; model: string; digest: string; createdAt: string; }
export interface LearningEvent { id: string; operationId: string; activityId: string; kind: "exposure" | "hint" | "answer" | "skip" | "feedback" | "failure"; text: string; assistance: "none" | "exposed" | "hinted"; verification: "ungraded"; citations?: LearningCitation[]; createdAt: string; }
export interface LearningSession { id: string; resourceId: string; accountScope: string; courseId: string; inputHash: string; contextHash: string; revision: number; goal: string; sources: LearningSource[]; activities: LearningActivity[]; events: LearningEvent[]; currentActivityId: string; draft: string; createdAt: string; updatedAt: string; }
export interface LearningSessionView { session: LearningSession; availability: "current" | "stale" | "blocked"; reason: string; }
export const learningStartSchema = z.object({ resourceId: id, inputHash: id, operationId: id, goal: z.string().max(1000).optional(), mode: z.enum(["practice", "explain"]).optional() }).strict();
export const learningActSchema = z.object({ sessionId: id, revision: z.number().int().nonnegative(), operationId: id, action: z.enum(["answer", "hint", "skip", "next", "retry_feedback"]), answer: z.string().max(4000).optional() }).strict();
export const learningDraftSchema = z.object({ sessionId: id, revision: z.number().int().nonnegative(), draft: z.string().max(4000) }).strict();
export type LearningStart = z.infer<typeof learningStartSchema>;
export type LearningAct = z.infer<typeof learningActSchema>;
export type LearningDraft = z.infer<typeof learningDraftSchema>;
export interface LearningBridge {
  learningList(resourceId: string): Promise<LearningSessionView[]>;
  learningGet(sessionId: string): Promise<LearningSessionView>;
  learningStart(request: LearningStart): Promise<LearningSessionView>;
  learningAct(request: LearningAct): Promise<LearningSessionView>;
  learningSaveDraft(request: LearningDraft): Promise<LearningSessionView>;
  cancelLearning(): Promise<void>;
}
/** UI projection repository port; a binding to Nate's canonical learning tables is still required. */
export interface LearningSessionRepository {
  learningSessions(resourceId: string): LearningSession[];
  learningSession(id: string): LearningSession | undefined;
  putLearningSession(session: LearningSession, expectedRevision: number | null): void;
}
