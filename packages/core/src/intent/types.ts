import type { z } from "zod";
import type {
  CourseCoreStore,
  IntentSlots,
  LearningRequest,
  LearningResult,
  PackScope,
  Store,
  WorkspaceCommand,
  WorkspaceResult,
} from "@magic/contracts";
import type { LearningStore } from "../../../learning/src/store";

export type IntentStore = Store & CourseCoreStore & { learning: LearningStore };
export type SlotName = keyof IntentSlots;

export interface ResolvedCourse {
  /** `accountScope:courseId`, the learning store's course reference. */
  ref: string;
  accountScope: string;
  courseId: string;
  /** "COMPSCI 400" when the name carries one. */
  code: string | null;
  name: string;
}
/** An inclusive local-date range in the student's time zone (YYYY-MM-DD). */
export interface DateRange {
  from: string;
  to: string;
  label: string;
}
/** What code resolved from the slots; every ID here came from the store, never the model. */
export interface ResolvedArgs {
  text: string;
  course?: ResolvedCourse;
  assignment?: { resourceId: string; title: string };
  topicIds?: string[];
  /** Topic words that matched no concept label; the router passes them on as a description. */
  topicText?: string;
  date?: DateRange;
  query?: string;
  kind?: "cards" | "quiz";
  count?: number;
  scope?: "course" | "all";
}

export type SlotResolution<T> =
  | { status: "ok"; value: T }
  | { status: "none" }
  | { status: "ambiguous"; options: T[] };

/** Code's resolvers: course IDs, dates in the student's time zone, topics and resource IDs. */
export interface Resolve {
  course(text: string): SlotResolution<ResolvedCourse>;
  courseById(courseId: string): ResolvedCourse | null;
  date(text: string): DateRange | null;
  topics(course: ResolvedCourse, labels: string[]): { ids: string[]; unmatched: string[] };
  assignment(text: string, course?: ResolvedCourse): SlotResolution<{ resourceId: string; title: string }>;
  courses(): ResolvedCourse[];
  /** The course's assignments that anchor a practice scope (the learning router authorizes each). */
  anchors(course: ResolvedCourse): string[];
}

/** What core hands the router for one command: its own seams, never a new network path. */
export interface IntentHost {
  workspace(value: WorkspaceCommand): Promise<WorkspaceResult>;
  learning?: { handle(request: LearningRequest, signal: AbortSignal): Promise<LearningResult> };
  pack?(pack: string, scope: PackScope, signal: AbortSignal): Promise<unknown>;
}

export interface ActionContext {
  store: IntentStore;
  host: IntentHost;
  resolve: Resolve;
  now: Date;
  timeZone: string;
  signal: AbortSignal;
  /** The grounded ask, for the `ask` action and adapters that answer questions. */
  ask(question: string, courses: ResolvedCourse[] | "all", signal: AbortSignal): Promise<AskResult>;
}

export interface AskResult {
  text: string;
  citations: import("@magic/contracts").IntentCitation[];
  notFound: boolean;
  dropped: number;
  path: "ai" | "cache" | "none";
  tokens: { in: number; cached: number; out: number };
  unavailable?: string;
}

/** One registered app action. The model only ever names one; code validates and runs it. */
export interface ActionSpec<A = ResolvedArgs> {
  name: string;
  description: string;
  /** Which surface arguments it takes; the catalogue lists these names. */
  slots: Partial<Record<SlotName, "required" | "optional">>;
  /** Validates the resolved arguments (IDs and dates from code) before run. */
  argsSchema: z.ZodType<A>;
  examples: string[];
  /** Code-path patterns over the normalised request; named groups fill slots. */
  patterns?: RegExp[];
  /** The candidate's label, in the student's words. */
  label?(args: A): string;
  run(args: A, ctx: ActionContext): Promise<unknown>;
}
