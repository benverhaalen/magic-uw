import type { SignInOutcome, SignInService } from "@magic/contracts";

/**
 * owner: client-health (FDB-002). The `magic:signin` IPC contract. The window's own result
 * (`openSignIn` resolves true only after the service answered with the student's profile)
 * becomes a typed outcome instead of being dropped, so closing the window can't read as success.
 * An unknown service and a refused consent still reject, exactly as before; nothing here syncs.
 */
export const HEADLESS_SIGN_IN = "Sign-in requires your interaction; headless mode will not open a window.";

export const isSignInService = (value: unknown): value is SignInService =>
  value === "canvas" || value === "gitlab" || value === "enroll" || value === "myuw";

export async function handleSignInRequest(
  requested: unknown,
  deps: {
    /** The consent gate (spec G1); false rejects with `refused`. */
    consented(): Promise<boolean>;
    refused: string;
    /** Opens the single-flight sign-in window; resolves true when a sign-in was confirmed. */
    open(service: SignInService | undefined): Promise<boolean>;
  },
): Promise<SignInOutcome> {
  if (requested !== undefined && !isSignInService(requested)) throw new Error("Unsupported sign-in source.");
  if (!(await deps.consented())) throw new Error(deps.refused);
  const service: SignInService = requested ?? "canvas";
  try {
    return { status: (await deps.open(requested)) ? "confirmed" : "cancelled", service };
  } catch (error) {
    // Only our own plain message crosses; anything else gets a generic reason.
    const reason =
      error instanceof Error && error.message === HEADLESS_SIGN_IN ? error.message : "The UW sign-in window couldn't open.";
    return { status: "failed", service, reason };
  }
}
