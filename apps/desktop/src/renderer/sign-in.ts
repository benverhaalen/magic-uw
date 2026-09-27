import type { AppBridge, SignInOutcome, SignInService } from "@magic/contracts";

/**
 * owner: client-health (FDB-002). Sign in to UW, then read Canvas only when the sign-in was
 * confirmed. A closed window (`cancelled`) or a window that couldn't open (`failed`) claims
 * nothing and starts no sync. An answer without an outcome is treated as unconfirmed.
 */
export async function signInAndSync(
  bridge: Pick<AppBridge, "signInUW" | "syncCanvas" | "syncPlanning">,
  service?: SignInService,
  /**
   * fix/current-courses-only. Onboarding: `enrollmentFirst` reads this term's UW enrollment
   * (Course Search & Enroll) before the Canvas course list, so enrollment decides "this term";
   * a failed or slow read (`enrollmentTimeoutMs`) leaves Canvas's rules to decide. Degree history
   * and saved audits follow in the background. `discover` reads only the course list.
   */
  options: { discover?: boolean; enrollmentFirst?: boolean; enrollmentTimeoutMs?: number } = {},
): Promise<{ outcome: SignInOutcome; synced: boolean }> {
  if (!bridge.signInUW)
    return { outcome: { status: "failed", service: service ?? "canvas", reason: "UW sign-in is available in the desktop app only." }, synced: false };
  const raw: unknown = await bridge.signInUW(service);
  const outcome = isOutcome(raw) ? raw : { status: "failed" as const, service: service ?? "canvas", reason: "The sign-in didn't report how it ended." };
  if (outcome.status !== "confirmed" || !bridge.syncCanvas) return { outcome, synced: false };
  if (options.enrollmentFirst && bridge.syncPlanning) {
    const limit = options.enrollmentTimeoutMs ?? 30_000;
    await Promise.race([
      bridge.syncPlanning({ phase: "enrollment" }).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, limit)),
    ]);
  }
  await (options.discover ? bridge.syncCanvas({ discover: true }) : bridge.syncCanvas());
  // Degree history and saved audits (My UW) never block onboarding.
  if (options.enrollmentFirst && bridge.syncPlanning) void bridge.syncPlanning().catch(() => undefined);
  return { outcome, synced: true };
}

function isOutcome(value: unknown): value is SignInOutcome {
  const v = value as Partial<SignInOutcome> | null;
  return !!v && (v.status === "confirmed" || v.status === "cancelled" || v.status === "failed") && typeof v.service === "string";
}

/** Plain words for each outcome, shown where the sign-in was started. */
export function signInMessage(outcome: SignInOutcome): string {
  if (outcome.status === "confirmed") return "Signed in. Reading your courses now.";
  if (outcome.status === "cancelled") return "The sign-in window was closed before UW confirmed it. Nothing was read.";
  return outcome.reason ?? "The UW sign-in window couldn't open.";
}
