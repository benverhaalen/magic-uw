import { z } from "zod";
import type { ContextManifest } from "@magic/contracts";
export { createLocalAi } from "./local";
export { createLocalCourseExtractor } from "./course-extraction";
const kinds = [
  "essay",
  "problem_set",
  "quiz",
  "exam",
  "discussion",
  "project",
  "reading",
  "other",
] as const;
export const judgmentResultSchema = z
  .object({
    kind: z.enum(kinds),
    probabilities: z.record(z.string(), z.number().min(0).max(1)),
    model: z.string().min(1),
    questionVersion: z.literal("assignment.kind.v1"),
  })
  .strict();
export type KindJudgment = z.infer<typeof judgmentResultSchema>;
export interface JudgmentGateway {
  evaluate(
    payload: ContextManifest["payload"],
    signal: AbortSignal,
  ): Promise<KindJudgment>;
}
export interface DeviceCredentialStore {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
}
export function gatewayClient(
  baseUrl: string,
  credentials: DeviceCredentialStore,
  fetcher: typeof fetch = fetch,
): JudgmentGateway {
  const base = new URL(baseUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    !(
      base.protocol === "https:" ||
      (base.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))
    )
  )
    throw new Error(
      "Gateway requires HTTPS, or a loopback development address.",
    );
  let enrolling: Promise<string> | undefined;
  async function token(signal: AbortSignal) {
    const saved = await credentials.read();
    if (saved) return saved;
    if (!enrolling)
      enrolling = (async () => {
        const r = await fetcher(new URL("/v1/devices", base), {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal,
        });
        if (!r.ok)
          throw new Error(
            "Could not register this installation with the judgment gateway.",
          );
        const t = z
          .object({ token: z.string().min(24).max(512) })
          .strict()
          .parse(await r.json()).token;
        await credentials.write(t);
        return t;
      })().finally(() => {
        enrolling = undefined;
      });
    return enrolling;
  }
  return {
    async evaluate(payload, signal) {
      const t = await token(signal);
      signal.throwIfAborted();
      const r = await fetcher(
        new URL("/v1/judgments/assignment.kind.v1", base),
        {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${t}`,
          },
          body: JSON.stringify({ state: payload }),
          signal,
        },
      );
      if (!r.ok)
        throw new Error(
          r.status === 429
            ? "Judgment budget reached. Try later."
            : r.status === 503
              ? "The judgment gateway is not configured."
              : "The judgment gateway could not complete this request.",
        );
      const result = judgmentResultSchema.parse(await r.json());
      if (
        Object.keys(result.probabilities).length !== kinds.length ||
        kinds.some((k) => result.probabilities[k] === undefined) ||
        Math.abs(
          Object.values(result.probabilities).reduce((a, b) => a + b, 0) - 1,
        ) > 0.02
      )
        throw new Error("Invalid judgment distribution.");
      return result;
    },
  };
}
