/**
 * owner: client-health (FDB-002). What the UW sign-in window ended with. A resolved call alone
 * never meant success: closing the window is `cancelled`, and only `confirmed` means the
 * service answered with the student's profile. `failed` carries a plain reason.
 */
export type SignInService = "canvas" | "gitlab" | "enroll" | "myuw";
export interface SignInOutcome {
  status: "confirmed" | "cancelled" | "failed";
  service: SignInService;
  reason?: string;
}
