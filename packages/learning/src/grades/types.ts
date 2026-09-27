// The grade bank's shapes (D57). Scores here are the student's own captured Canvas results and the
// course's listed weights: facts with their sources, never a prediction of a final grade.

export type WeightSource = "canvas" | "syllabus";

export interface GradeGroup {
  /** The Canvas assignment group ID (the captured group resource's external ID). */
  id: string;
  title: string;
  /** Canvas `group_weight`, as listed; null when Canvas gave none. */
  weight: number | null;
  position: number;
  dropLowest: number;
  dropHighest: number;
  /** Assignment IDs (Canvas external IDs) that are never dropped. */
  neverDrop: string[];
}

export interface GradeItem {
  /** The stored resource ID. */
  id: string;
  /** The Canvas assignment ID, which group rules and `neverDrop` use. */
  externalId: string;
  title: string;
  groupId: string | null;
  /** Points possible; null or 0 means the item does not count toward a percentage. */
  points: number | null;
  /** Points earned; null when there is no captured score. */
  score: number | null;
  excused: boolean;
  missing: boolean;
  late: boolean;
  submitted: boolean | null;
  dueAt: string | null;
  submittedAt: string | null;
  /** Where the score sits on a timeline: when it was submitted, else its due date; null when neither is known. */
  at: string | null;
  /** An exam-like title (midterm, final, exam, quiz), from the same code rule analytics uses. */
  examKind: "exam" | "midterm" | "final" | "quiz" | null;
}

export interface SyllabusWeight {
  label: string;
  weight: number;
  resourceId: string;
  /** The syllabus line the weight was read from, verbatim. */
  quote: string;
}

export interface CourseGradeInput {
  accountScope: string;
  courseId: string;
  courseName: string;
  groups: GradeGroup[];
  items: GradeItem[];
  syllabusWeights: SyllabusWeight[];
  /** Whether every source read for this course (in this account) finished completely. */
  coverage: { status: "complete" | "partial" | "none"; reasons: string[] };
}

export type ResolvedWeights =
  | { status: "known"; source: WeightSource; byGroup: Map<string, number>; text: string }
  | { status: "unknown"; reason: string };

export interface GroupResult {
  groupId: string;
  title: string;
  /** The group's weight and where it came from; null when unknown. */
  weight: { value: number; source: WeightSource } | null;
  earned: number;
  possible: number;
  /** earned / possible after the group's drop rules, rounded to one decimal; null with no scored work. */
  percent: number | null;
  scored: number;
  dropped: string[];
  missing: number;
  /** Items that count here but have no captured score yet. */
  ungraded: number;
}

export type CourseGrade =
  | { status: "known"; percent: number; basis: string }
  | { status: "unknown"; reason: string };

export type AssignmentShare =
  | { status: "known"; share: number; groupWeight: number; source: WeightSource; text: string }
  | { status: "group_only"; groupWeight: number; source: WeightSource; text: string; reason: string }
  | { status: "unknown"; reason: string };

export interface TrajectoryPoint {
  at: string;
  itemId: string;
  title: string;
  groupId: string | null;
  /** This item's score as a percent of its points, one decimal. */
  percent: number;
  /** The running figure after this item: the weighted course grade when weights are known, else the running points percent. */
  running: number;
}

export type Trend =
  | { kind: "slipping"; since: string; sinceItemId: string; earlier: number; recent: number; items: number }
  | { kind: "rising"; since: string; sinceItemId: string; earlier: number; recent: number; items: number }
  | { kind: "steady"; level: number; items: number }
  | { kind: "too_few"; items: number };

export interface GroupTrajectory {
  groupId: string | null;
  title: string;
  points: TrajectoryPoint[];
  trend: Trend;
}

export interface HighWeightItem {
  itemId: string;
  title: string;
  dueAt: string | null;
  groupTitle: string | null;
  /**
   * `share`: the item's own part of the grade when the grade bank knows it (complete capture, no
   * drops); otherwise null and only `group`, its group's listed weight, is stated. Null when unknown.
   */
  weight: { share: number | null; group: number; source: WeightSource } | null;
  examKind: GradeItem["examKind"];
}

export interface CourseGrades {
  accountScope: string;
  courseId: string;
  courseName: string;
  coverage: CourseGradeInput["coverage"];
  weights: { status: "known"; source: WeightSource; text: string } | { status: "unknown"; reason: string };
  grade: CourseGrade;
  groups: GroupResult[];
  trajectory: { course: TrajectoryPoint[]; courseTrend: Trend; groups: GroupTrajectory[]; undated: number };
  upcomingHighWeight: HighWeightItem[];
  note: string;
}
