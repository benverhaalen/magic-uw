export * from "./types";
export {
  resolveCli,
  knownCliDirs,
  cliSearchDirs,
  loginShellDirs,
  readLoginShellPath,
  parseShellPath,
  extendPathForClients,
  type ShellRunner,
  resolveNpmShim,
  runProcess,
  cliEnvironment,
  allowlistedEnv,
  CLIENT_ENV_ALLOW,
  type CliCommand,
  type ProcessResult,
} from "./process";
export { formatAskHeader, jsonSchemaOf, estimateTokens, sha256 } from "./util";
export { classifyFailure, statedReset } from "./util"; // owner: client-health
export {
  createClaudeBackend,
  claudeOneShotArgs,
  CLAUDE_TIER_MODELS,
  type ClaudeOptions,
} from "./claude";
export {
  createCodexBackend,
  codexArgs,
  CODEX_TIER_MODELS,
  type CodexOptions,
  type CodexTierModel,
} from "./codex";
export { createApiBackend, API_TIER_MODELS, type ApiOptions, type ApiProvider } from "./api";
export { createLocalBackend, type LocalOptions } from "./local";
export {
  createModelRunner,
  createBackgroundBudget,
  type RunnerOptions,
  type BackgroundBudget,
  type BudgetState,
} from "./runner";
export {
  createSessionPool,
  claudeSessionArgs,
  unionSchema,
  POOL_PROTOCOL,
  promptCacheMinimum,
  type SessionPool,
  type WarmRequest,
  type PoolOptions,
  type ActivityEvent,
  type LaneStatus,
} from "./pool";
export { claudeToolUse, codexToolUse, claudeStreamCheck, codexStreamCheck, toolUseError, DENY_TOOLS_SETTINGS, CLAUDE_ALLOWED_TOOLS } from "./tripwire"; // owner: client-detection
export { killTree } from "./process"; // owner: client-detection
export { runStudyToolLoop, courseSearch, StudyToolError, type StudyToolRequest, type StudyToolResult, type StudyToolReceipt, type StudyToolGrant, type StudyToolAction } from "./study-retrieval";
export { runSourceInvestigator, searchInvestigation, InvestigationError, type InvestigationRequest, type InvestigationResult, type InvestigationAction, type InvestigationContext, type InvestigationGrant, type InvestigationCitation, type InvestigationReceipt, type ExternalReadPort } from "./source-investigator";
export { investigateAssignmentClick, type AssignmentClickInvestigation } from "./source-investigator-adapter";
