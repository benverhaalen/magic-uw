/**
 * The critical-action agenda (D49): code ranks open work by least slack (latest start = due −
 * estimate − buffer), the student's AI refines estimates and writes checked "why now" lines in the
 * background, and the launch views read it all from the local database.
 */
export { AGENDA_CONFIG, type AgendaConfig } from "./config";
export { readAgendaFacts, statedQuestionCount, type AgendaFact, type AgendaKind, type AgendaFacts } from "./items";
export { codeEstimate, correctEstimate, resolveEstimate, baselineEstimate, calibrations, storedEstimates, putEstimate, clampMinutes, formatMinutes, ESTIMATE_QUESTIONS } from "./estimate";
export { rankAgenda, type RankedItem, type RankResult } from "./rank";
export { checkLine, codeLine, narrationFact, narrationHash, NARRATION_VERSION } from "./narrate";
export { agendaRankedView, workspaceBootstrapView, rankedAgenda, invalidateAgenda, NARRATION_CHECKED } from "./query";
export {
  AGENDA_ESTIMATE_JOB,
  agendaEstimateJob,
  registerAgendaJobs,
  estimateCourse,
  narrateAgenda,
  correctAgendaEstimate,
  type AgendaJobDeps,
} from "./jobs";
