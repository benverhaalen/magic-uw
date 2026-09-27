import { JudgmentBudgetError } from "@magic/ai";

/** Only a fixed code and bounded duration cross IPC; upstream error text stays private. */
export function judgmentFailure(error: unknown) {
  return error instanceof JudgmentBudgetError
    ? { error: true as const, code: "judgment_budget" as const, retryAfterMs: error.retryAfterMs }
    : { error: true as const };
}

export function judgmentFailureError(message: { code?: unknown; retryAfterMs?: unknown }): Error {
  return message.code === "judgment_budget" && typeof message.retryAfterMs === "number" &&
    Number.isFinite(message.retryAfterMs) && message.retryAfterMs >= 60_000 && message.retryAfterMs <= 86_400_000
    ? new JudgmentBudgetError(message.retryAfterMs)
    : new Error("Judgment unavailable");
}
