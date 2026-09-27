/**
 * Scenario files for the fake clients (tests/e2e/fake-cli/fake.mjs). One scenario sets both
 * clients; the launcher writes it to <fake-bin>/scenario.json and a test can swap it mid-run.
 */
export type FakeRun = "ok" | "usage_limit" | "model_unavailable" | "offline" | "not_signed_in" | "plan_insufficient";
export interface FakeClientSpec {
  /** Omit the client entirely: its executable is not written, so it reads as not installed. */
  installed?: boolean;
  version?: string;
  /** Claude: a plan name ("max", "pro", "free"), "signed_out", "api_key" or "unknown". Codex: "chatgpt", "signed_out" or "api_key". */
  auth?: string;
  /** The sign-in of the app's own profile (a home other than the student's). Default: signed out, as a new profile is. */
  profileAuth?: string;
  /** How a model call ends. */
  run?: FakeRun;
  /** The reset time a usage-limit message states, as the client writes it. */
  resetsAt?: string;
  /** Flags this version's --help doesn't list and its parser rejects. */
  missingFlags?: string[];
  /** Delay before a model reply, to hold a run open. */
  delayMs?: number;
  /** false: the fake leaves its own home alone. */
  writesHome?: boolean;
  /** A fixed model output instead of the synthesised one. */
  output?: unknown;
}
export interface Scenario {
  claude: FakeClientSpec;
  codex: FakeClientSpec;
}

const both = (claude: FakeClientSpec, codex: FakeClientSpec = claude): Scenario => ({ claude, codex });

/** The operator's list: signed in, signed out, free plan, usage limit, model unavailable, offline, old version. */
export const SCENARIOS = {
  signedIn: both({ version: "2.1.283", auth: "max", run: "ok" }, { version: "0.156.1", auth: "chatgpt", run: "ok" }),
  signedInPro: both({ version: "2.1.290", auth: "pro", run: "ok" }, { version: "0.157.0", auth: "chatgpt", run: "ok" }),
  signedOut: both({ version: "2.1.283", auth: "signed_out" }, { version: "0.156.1", auth: "signed_out" }),
  /** Claude reports a free plan in its status; a free ChatGPT account is refused at run time. */
  freePlan: both({ version: "2.1.283", auth: "free" }, { version: "0.156.1", auth: "chatgpt", run: "plan_insufficient" }),
  usageLimit: both(
    { version: "2.1.283", auth: "max", run: "usage_limit", resetsAt: "3pm (America/Chicago)" },
    { version: "0.156.1", auth: "chatgpt", run: "usage_limit", resetsAt: "3:05 PM" },
  ),
  modelUnavailable: both({ version: "2.1.283", auth: "max", run: "model_unavailable" }, { version: "0.156.1", auth: "chatgpt", run: "model_unavailable" }),
  offline: both({ version: "2.1.283", auth: "max", run: "offline" }, { version: "0.156.1", auth: "chatgpt", run: "offline" }),
  /** Older than the verified versions, and missing the flag instant mode needs. */
  oldVersion: both(
    { version: "2.0.14", auth: "max", missingFlags: ["--safe-mode"] },
    { version: "0.120.0", auth: "chatgpt", missingFlags: ["--ignore-rules"] },
  ),
  /** Codex isn't installed at all: its executable is absent from PATH. */
  codexMissing: both({ version: "2.1.283", auth: "max", run: "ok" }, { installed: false }),
  /** A newer version whose --help dropped a required flag: the help check, not the version gate, refuses. */
  missingFlag: both(
    { version: "2.1.300", auth: "max", missingFlags: ["--safe-mode"] },
    { version: "0.160.0", auth: "chatgpt", missingFlags: ["--ignore-rules"] },
  ),
} satisfies Record<string, Scenario>;
export type ScenarioName = keyof typeof SCENARIOS;
