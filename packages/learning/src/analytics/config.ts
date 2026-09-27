// Practice analytics constants. Every one is a starting value, not validated (spec §5.9), in the
// same `Constant` shape as the knowledge-model config. Weakness and exam proximity reuse the km
// constants (needNotSeen, rulesPerFire, rulesCap, urgencyAmplitude, urgencyTauDays, minutesPerItem).
import type { Constant } from "../config";

const unvalidated = <T>(value: T): Constant<T> => ({ value, validated: false });

export const ANALYTICS_CONFIG = {
  version: "an-0.1",
  /** Scope share of a topic in no upcoming exam's scope (topics in scope get (0, 1]). */
  noExamShare: unvalidated(0.5),
  /** The least scope share a topic in an exam's scope gets. */
  shareFloor: unvalidated(0.25),
  /** Exams further away than this are not "upcoming" (days). */
  upcomingHorizonDays: unvalidated(60),
  /** Trend: state transitions over the last N practice sessions. */
  trendSessions: unvalidated(5),
  /** Agenda hint minutes: count at most this many of the topic's practice items. */
  hintMaxItems: unvalidated(10),
  /** Agenda hint minutes round up to this step. */
  hintRoundMinutes: unvalidated(5),
} as const;

export type AnalyticsConfig = typeof ANALYTICS_CONFIG;
