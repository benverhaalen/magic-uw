// owner: floating-chat. When the launcher may warm the student's AI client (the router's `prewarm`),
// so the first answer does not wait on its start-up. Warming starts an AI session, so a hover may
// only do it when the student's settings already let chat run on their hosted AI with no preview;
// otherwise the first open warms it, and hovering never does.
import type { ConsentRecord, PrivacyPreferences } from "@magic/contracts";
import { maySend, withConsents } from "@magic/domain";

/** `hover`: first hover, focus or open. `open`: first open only. `never`: no warm-up at all. */
export type ChatWarmPolicy = "hover" | "open" | "never";

export function chatWarmPolicy(privacy: PrivacyPreferences, consents: readonly ConsentRecord[]): ChatWarmPolicy {
  // Fully local mode blocks hosted AI; with no hosted AI selected or agreed to, there is nothing to warm.
  if (privacy.mode === "local_only" || privacy.hostedProvider === "none") return "never";
  const settings = withConsents(privacy, consents);
  if (!maySend(settings, privacy.hostedProvider, []).allowed) return "never";
  // Chat answers send course text. Always-preview (or course text not shared) means an answer
  // cannot run without the student acting first, so only their opening the chat warms it.
  const runsWithoutPreview = maySend(settings, privacy.hostedProvider, ["course_text"]).allowed && privacy.alwaysPreview !== true;
  return runsWithoutPreview ? "hover" : "open";
}
