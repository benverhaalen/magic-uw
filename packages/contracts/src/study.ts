/** Renderer-safe canonical study projection. Answer keys and internal mastery parameters never leave the router. */
export interface StudyCitation {
  resourceId: string;
  contentHash: string;
  start: number;
  end: number;
  quote: string;
}
export interface StudySource {
  resourceId: string;
  contentHash: string;
  title: string;
  url: string;
  observedAt: string;
}
export interface StudyItemView {
  id: string;
  version: number;
  kind: "mc" | "tf" | "typed" | "cloze" | "numeric";
  stem: string;
  options: { id: string; text: string }[] | null;
  unit?: string;
  citations: StudyCitation[];
  checks: {
    check: string;
    method: string;
    outcome: "pass" | "fail" | "abstain" | "not_run";
  }[];
}
export interface StudyEvent {
  id: string;
  operationId: string;
  itemId: string;
  itemVersion: number;
  kind: "answer" | "hint" | "explain" | "skip";
  text: string;
  createdAt: string;
  assistance: "none" | "hint" | "explained";
  outcome?: "correct" | "partial" | "incorrect" | "undecided";
  score?: number | null;
  checks?: string[];
}
export interface StudySessionView {
  id: string;
  resourceId: string;
  accountScope: string;
  courseId: string;
  inputHash: string;
  revision: number;
  goal: string;
  draft: string;
  startedAt: string;
  updatedAt: string;
  availability: "current" | "stale" | "blocked";
  reason: string;
  status: "active" | "complete";
  currentItem?: StudyItemView;
  answered: boolean;
  events: StudyEvent[];
  sources: StudySource[];
  plan: { kind: string; reason: string; itemIds: string[] }[];
}

export type StudyResultData =
  | { session: StudySessionView }
  | { sessions: StudySessionView[] };
