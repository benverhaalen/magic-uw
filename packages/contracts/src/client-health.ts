import type { ClientId } from "./index";

/**
 * owner: client-health (D50). How the app reaches a student's AI client, and whether it can
 * run right now. Health is typed so every failure has one notice with the exact next step.
 */

/**
 * - `instant` (the default; operator, 2026-09-27): the student's own signed-in client, run with
 *   the app's configuration as flags only; nothing is written to their settings. Offered per
 *   client and version after a check. The app never signs it in.
 * - `isolated`: the app-owned profile (D45), signed in once in the built-in terminal. An
 *   advanced opt-in only ("Use a separate sign-in for My Magic UW").
 * - `api_key`: the student's own key, stored encrypted by the app (Gemini's only route, D36).
 */
export type ClientMode = "instant" | "isolated" | "api_key";

/**
 * - `installed`: found, but its sign-in could not be confirmed yet.
 * - `plan_insufficient`: signed in, but the plan can't run this client (for example a free plan).
 * - `usage_limited`: the plan's usage limit is reached; `resetsAt` when the client says when.
 */
export type ClientHealthState =
  | "installed"
  | "not_installed"
  | "not_signed_in"
  | "plan_insufficient"
  | "usage_limited"
  | "model_unavailable"
  | "offline"
  | "ok";

/** Whether instant mode can be offered for this client on this device, and why not. */
export interface InstantSupport {
  available: boolean;
  /** Plain words, shown to the student when instant mode is not offered. */
  reason?: string;
  /** Plain words about what instant mode can't keep out, shown when it is offered anyway. */
  note?: string;
}

export interface ClientHealth {
  id: ClientId;
  state: ClientHealthState;
  mode: ClientMode;
  /** The client's own plan name when it states one (Claude's `subscriptionType`); never identity. */
  plan?: string;
  /** For `usage_limited`: the reset time as the client stated it. */
  resetsAt?: string;
  version?: string;
  /** Which check produced the state: detection, the client's status command, a run, or the key store. */
  source: "detect" | "status" | "run" | "key";
  instant: InstantSupport;
  /** The modes this client can use here, best first. */
  modes: ClientMode[];
  checkedAt: string;
}

/** Presence only: a key's value never crosses the bridge. */
export interface ApiKeyStatus {
  /** A key is saved in the app's encrypted store; runs use only this one. */
  stored: boolean;
  /** GEMINI_API_KEY is set on this computer. Its value is never read unless the student pastes it. */
  inEnvironment: boolean;
}
