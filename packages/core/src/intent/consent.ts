/**
 * The egress decision for the command bar's model calls: `maySend` for the current settings, the
 * held-preview policy, and a receipt for every send. The same steps as the pack handler's.
 */
import { aiRecipientSchema } from "@magic/contracts";
import { maySend } from "@magic/domain";
import { buildReceipt, egressFor } from "../egress";
import type { IntentStore } from "./types";

export interface EgressRequest {
  purpose: string;
  course: string;
  title: string;
  text: string;
  policy: string;
  resourceIds: string[];
  characters: number;
}

export function authorizer(store: IntentStore, request: EgressRequest, at: () => string, receiptIds: string[]) {
  return (recipient: string, categories: string[]) => {
    const parsed = aiRecipientSchema.safeParse(recipient);
    if (!parsed.success) return { allowed: false, reason: "This recipient is not supported." };
    const permission = maySend(store.privacy(), recipient, categories);
    const m = {
      recipient: parsed.data,
      purpose: request.purpose,
      categories,
      resourceIds: request.resourceIds,
      characters: request.characters,
      allowed: permission.allowed,
      reason: permission.reason,
      payload: { course: request.course, title: request.title, text: request.text, policy: request.policy },
    };
    const decision = egressFor(store).check(m, { at: at(), background: false });
    if (decision.status === "blocked") {
      receiptIds.push(decision.receiptId);
      return { allowed: false, reason: decision.reason };
    }
    if (decision.status === "preview_required") {
      receiptIds.push(decision.previewId);
      return { allowed: false, reason: decision.reason };
    }
    const receipt = buildReceipt(m, "sent", at());
    store.addReceipt(receipt);
    receiptIds.push(receipt.id);
    return { allowed: true, reason: permission.reason };
  };
}
