// N00: the spec §8.1 student-facing result types, defined once here until the
// contracts follow-up moves them. None carries an ability value, a probability
// or a percentage (KM-6).

export interface Citation {
  id: string;
  resourceId: string;
  version: number;
  contentHash: string;
  start: number;
  end: number;
  quote: string;
  quoteValid: true;
  support: "jev" | "model_same" | "model_other" | "not_checked" | "disputed";
}

export interface Answer {
  kind: "answer" | "not_found" | "policy_limited";
  sentences: { text: string; citationIds: string[] }[];
  citations: Citation[];
  removed: number;
  checks: string[];
  scope: { searched: number; excluded: number; missing: string[]; capturedAt: string };
  receiptIds: string[];
}

export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6";
export type ConceptStateName = "solid" | "getting_there" | "iffy" | "not_seen";

/** Student-facing names (spec H4: Solid is shown as "Mastered"). */
export const STATE_LABEL: Record<ConceptStateName, string> = {
  solid: "Mastered",
  getting_there: "Getting there",
  iffy: "Iffy",
  not_seen: "Not seen yet",
};

export interface Reason {
  rule: RuleId;
  text: string;
  eventIds: string[];
  clearsWhen: string;
}

export interface ConceptCounts {
  answers: number;
  unassisted: number;
  correct: number;
  cardReviews: number;
  selfRatings: number;
}

export interface ConceptView {
  conceptId: string;
  label: string;
  unit: string | null;
  state: ConceptStateName;
  reasons: Reason[];
  counts: ConceptCounts;
  coveredBy: { assessmentId: string; title: string; daysAway: number }[];
  configVersion: string;
}

/** How one key idea was decided. `undecided` means code could not decide and no judge ran. */
export type KeyIdeaMethod = "exact" | "normalised" | "synonym" | "judge" | "student" | "undecided";

export interface Grade {
  itemId: string;
  /** `undecided`: code could not settle every required idea; the attempt is not scored yet. */
  outcome: "correct" | "partial" | "incorrect" | "undecided";
  keyIdeas?: { idea: string; found: boolean | null; method: KeyIdeaMethod }[];
  explanation?: { text: string; citation: Citation };
  tempting?: string;
  deferred: boolean;
  checks: string[];
}

export type SessionBlockKind = "confident_misses" | "mistakes" | "due_cards" | "learn" | "diagnostic";

export interface SessionPlan {
  sessionId: string;
  minutes: number;
  blocks: { kind: SessionBlockKind; itemIds: string[]; reason: string }[];
}

export interface Coverage {
  assessmentId: string;
  tier: "T1" | "T2" | "T3" | "T4";
  statement?: Citation;
  concepts: { conceptId: string; basis: "stated" | "schedule_window" | "mapped"; citation?: Citation }[];
  materials: { resourceId: string; reason: string }[];
  missing: string[];
  warnings: string[];
}
