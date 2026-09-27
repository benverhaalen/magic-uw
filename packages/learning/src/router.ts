/**
 * The learning router stub (T05b). N25 takes it over: every LearningRequest op against the
 * store, the engines and an injected runtime. Until then each op answers `not_built`, so a
 * learning command reaches its channel end to end and nothing pretends to work.
 */
import type { LearningRequest, LearningResult } from "@magic/contracts";

export interface LearningRouter {
  handle(request: LearningRequest, signal: AbortSignal): Promise<LearningResult>;
}
export function createLearningRouter(): LearningRouter {
  return {
    async handle(request) {
      return {
        op: request.op,
        status: "not_built",
        message: "This study feature isn't built yet.",
      };
    },
  };
}
