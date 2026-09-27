import { createLocalAi } from "@magic/ai";
import {
  localQuestionSchema,
  localContextPayload,
  type LocalAnswer,
  type LocalStatus,
  type Store,
  type ContextManifest,
} from "@magic/contracts";
import { UW_DEFAULT_NOTICE_WITH_LINK } from "../../../packages/domain/src/uw-ai-policy";
import { isOpenGraded } from "../../../packages/domain/src/learning-request";

/** Runs only on explicit request, outside the renderer. No model download or installation. */
export function createLocalService(
  store: Pick<Store, "resource" | "privacy">,
  core: { context(id: string, recipient: "local"): ContextManifest },
  adapter: Pick<
    ReturnType<typeof createLocalAi>,
    "status" | "generate"
  > = createLocalAi(),
) {
  let generation = 0;
  const active = new Map<string, AbortController>();
  function cancel(id?: string) {
    if (id) {
      active.get(id)?.abort();
      active.delete(id);
      return;
    }
    generation++;
    for (const controller of active.values()) controller.abort();
    active.clear();
  }
  async function status(id: string): Promise<LocalStatus> {
    if (active.size)
      throw new Error(
        "A local AI request is already running. Cancel it before starting another.",
      );
    const controller = new AbortController();
    active.set(id, controller);
    try {
      const state = await adapter.status(controller.signal);
      controller.signal.throwIfAborted();
      return {
        status: state.status,
        reason: state.reason,
        cloudDisabled: state.cloudDisabled,
        selectedModel: state.selected?.name ?? null,
        recommenderAvailable: state.recommendations.status === "available",
        basis:
          state.recommendations.status === "available"
            ? state.recommendations.basis
            : state.recommendations.reason,
      };
    } finally {
      active.delete(id);
    }
  }
  async function ask(id: string, raw: unknown): Promise<LocalAnswer> {
    if (active.size)
      throw new Error(
        "A local AI request is already running. Cancel it before starting another.",
      );
    const request = localQuestionSchema.parse(raw);
    const resource = store.resource(request.id);
    if (
      !resource ||
      resource.deleted ||
      resource.contentHash !== request.inputHash
    )
      throw new Error(
        "This item changed. Review its current evidence and ask again.",
      );
    // Resource data and the policy come from the store, never the renderer's request.
    const manifest = core.context(resource.id, "local");
    if (!manifest.allowed) throw new Error(manifest.reason);
    const version = generation,
      privacy = JSON.stringify(store.privacy());
    const controller = new AbortController();
    active.set(id, controller);
    try {
      const result =
        (manifest.effectivePolicy?.mode ?? resource.policy.mode) ===
        "restricted"
          ? {
              text: "This course restricts AI help on this work. Review the quoted course policy and ask your instructor which preparation is permitted.",
              model: null,
              policyLimited: true,
              recipient: "local" as const,
            }
          : await adapter.generate(
              {
                question: request.question,
                policyMode:
                  manifest.effectivePolicy?.mode ?? resource.policy.mode,
                context: localContextPayload(manifest.payload),
              },
              controller.signal,
            );
      controller.signal.throwIfAborted();
      const current = store.resource(resource.id);
      if (
        generation !== version ||
        !current ||
        current.deleted ||
        current.contentHash !== request.inputHash ||
        JSON.stringify(store.privacy()) !== privacy ||
        JSON.stringify(core.context(resource.id, "local")) !==
          JSON.stringify(manifest)
      )
        throw new Error(
          "The source or data settings changed. Ask again using the current evidence.",
        );
      // Under UW–Madison's default, an answer on open graded work always carries the reminder (added by code).
      const reminder =
        manifest.effectivePolicy?.source === "uw-default" && isOpenGraded(resource)
          ? `\n\n${UW_DEFAULT_NOTICE_WITH_LINK}`
          : "";
      return {
        ...result,
        text: `${result.text}${reminder}`,
        resourceId: resource.id,
        inputHash: request.inputHash,
        sourceTitle: resource.title,
        sourceUrl: resource.url,
        observedAt: resource.observedAt,
      };
    } finally {
      active.delete(id);
    }
  }
  return { status, ask, cancel };
}
