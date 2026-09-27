// P08: Write mode (PI-11). Typed recall for every item family, graded by key
// ideas with the found and missing ideas listed. "I was right" (contest)
// stores a grade dispute, which removes the attempt from the knowledge model;
// withdrawing it restores the attempt. A contest never flips an attempt to
// correct: it only excludes it (the evidence filter in knowledge/events.ts).
import { gradeTyped, type TypedGrade } from "../grade";
import type { LearnFamily } from "../learn";
import type { Dispute, KeyIdea, LearningAttempt, LearningStore } from "../store";

export interface WritePrompt {
  familyId: string;
  itemId: string;
  itemVersion: number;
  stem: string;
  key: string;
  keyIdeas: KeyIdea[];
}

/** The recall variant when the family has one; otherwise the recognition stem, asked without options, keyed to the right option's text. */
export function writePrompt(f: LearnFamily): WritePrompt | null {
  if (f.recall) return { familyId: f.familyId, itemId: f.recall.id, itemVersion: f.recall.version, stem: f.recall.stem, key: String(f.recall.key), keyIdeas: f.recall.keyIdeas };
  const r = f.recognition;
  if (!r) return null;
  const keyText = r.options?.find((o) => o.id === r.key)?.text;
  if (!keyText) return null;
  return { familyId: f.familyId, itemId: r.id, itemVersion: r.version, stem: r.stem, key: keyText, keyIdeas: r.keyIdeas };
}

export interface WriteFeedback {
  grade: TypedGrade;
  found: string[];
  missing: string[];
  notChecked: string[];
}

export function gradeWrite(p: WritePrompt, answer: string): WriteFeedback {
  const grade = gradeTyped({ id: p.itemId, key: p.key, keyIdeas: p.keyIdeas }, answer);
  return {
    grade,
    found: grade.keyIdeas.filter((i) => i.found === true).map((i) => i.idea),
    missing: grade.keyIdeas.filter((i) => i.found === false).map((i) => i.idea),
    notChecked: grade.keyIdeas.filter((i) => i.found === null).map((i) => i.idea),
  };
}

/** "I was right": a grade dispute on the attempt. The attempt row itself is never changed. */
export function contest(store: LearningStore, attempt: LearningAttempt, at: string, note: string | null = null): Dispute {
  const d: Dispute = {
    id: `contest:${attempt.id}`,
    courseRef: attempt.courseRef,
    targetKind: "grade",
    targetId: attempt.id,
    reason: "grade_wrong",
    note,
    status: "open",
    createdAt: at,
    resolvedAt: null,
  };
  const existing = store.evidence(attempt.courseRef).disputes.find((x) => x.id === d.id);
  if (existing) {
    if (existing.status !== "open") store.setDisputeStatus(d.id, "open", at);
    return { ...existing, status: "open", resolvedAt: null };
  }
  store.addDispute(d);
  return d;
}

/** Withdraw a contest: the attempt counts again, as it was graded. */
export function withdrawContest(store: LearningStore, disputeId: string, at: string): void {
  store.setDisputeStatus(disputeId, "undone", at);
}

/** For history: a contested attempt stays visible, marked "contested". */
export function attemptStatus(attempt: LearningAttempt, disputes: Dispute[]): "contested" | "counted" {
  return disputes.some((d) => d.targetKind === "grade" && d.targetId === attempt.id && d.status === "open") ? "contested" : "counted";
}
