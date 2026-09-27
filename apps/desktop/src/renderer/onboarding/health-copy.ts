import type { ClientHealth, ClientId } from "@magic/contracts";

/**
 * owner: client-health (D50). Plain words for each client health state: what's wrong, why, and
 * the exact next step, plus which actions the notice offers. Pure, so every state is testable.
 * Links were taken from the installed clients' own messages where they state one.
 */

export type NoticeAction =
  | { kind: "quick_chat" }
  | { kind: "check_again" }
  | { kind: "switch" }
  | { kind: "use_profile" }
  | { kind: "add_key" }
  | { kind: "link"; label: string; url: string };

export interface HealthCopy {
  tone: "ok" | "wait" | "problem";
  title: string;
  cause: string;
  /** The exact next step. `{command}` marks where `command` is shown as code. */
  next: string;
  command?: string;
  actions: NoticeAction[];
}
/** The command that signs each client in on this computer, in the student's own terminal. */
export const SIGN_IN_COMMANDS: Partial<Record<ClientId, string>> = { claude: "claude", codex: "codex login" };

const names: Record<ClientId, { name: string; provider: string; plan: string }> = {
  claude: { name: "Claude Code", provider: "Anthropic", plan: "Claude plan" },
  codex: { name: "Codex", provider: "OpenAI", plan: "ChatGPT plan" },
  gemini: { name: "Gemini", provider: "Google", plan: "Google account" },
};
export const INSTALL_URLS: Record<ClientId, string> = {
  claude: "https://code.claude.com/docs/en/setup",
  codex: "https://developers.openai.com/codex/cli",
  gemini: "https://github.com/google-gemini/gemini-cli",
};
/** From the clients' own messages: claude.ai/upgrade/max, claude.ai/settings/usage, chatgpt.com/explore/plus and chatgpt.com/codex/settings/usage. */
const UPGRADE: Record<ClientId, { label: string; url: string } | null> = {
  claude: { label: "Plans at claude.ai", url: "https://claude.ai/upgrade/max" },
  codex: { label: "Upgrade at chatgpt.com", url: "https://chatgpt.com/explore/plus" },
  gemini: null,
};
const USAGE: Record<ClientId, { label: string; url: string } | null> = {
  claude: { label: "Your usage at claude.ai", url: "https://claude.ai/settings/usage" },
  codex: { label: "Your usage at chatgpt.com", url: "https://chatgpt.com/codex/settings/usage" },
  gemini: null,
};
/** Google AI Studio's key page (not checked from this device). */
export const GEMINI_KEY_URL = "https://aistudio.google.com/apikey";

const other = (id: ClientId) => (id === "claude" ? "Codex" : "Claude Code");
const chat = (h: ClientHealth): NoticeAction[] => (h.id === "gemini" ? [] : [{ kind: "quick_chat" }]);

/** `chat`: whether Quick chat is offered where this notice shows; the words mention it only then. */
export function healthCopy(h: ClientHealth, options: { chat?: boolean } = {}): HealthCopy {
  const { name, provider, plan } = names[h.id];
  const canChat = options.chat !== false && h.id !== "gemini";
  switch (h.state) {
    case "ok":
      return {
        tone: "ok",
        title: `${name} is ready`,
        cause:
          h.mode === "api_key"
            ? "Your key is saved on this computer, encrypted."
            : `Signed in${h.plan ? ` with ${h.plan[0].toUpperCase()}${h.plan.slice(1)}` : ""}${h.mode === "isolated" ? " to the app's own profile" : ""}.`,
        next: "Nothing to do.",
        actions: [],
      };
    case "installed":
      if (h.mode === "instant" && !h.instant.available)
        return {
          tone: "problem",
          title: `Update ${name} to use it here`,
          cause: h.instant.reason ?? `This version of ${name} can't be run with My Magic UW's settings.`,
          next: `Update ${name}, then check again. Or choose another AI.`,
          actions: [{ kind: "link", label: `How to update ${name}`, url: INSTALL_URLS[h.id] }, { kind: "check_again" }, { kind: "switch" }],
        };
      return {
        tone: "wait",
        title: `${name} didn't confirm your sign-in`,
        cause: `${name} is installed, but it didn't say whether you're signed in.`,
        next: canChat ? `Check again. To see what ${name} says, open Quick chat.` : `Check again, or run ${name} in your own terminal to see what it says.`,
        actions: [{ kind: "check_again" }, ...chat(h)],
      };
    case "not_installed":
      return {
        tone: "problem",
        title: `${name} isn't installed`,
        cause: h.version ? `${name} was found but didn't start.` : `${name} wasn't found on this computer.`,
        next: `Install it, then check again. Or choose another AI.`,
        actions: [{ kind: "link", label: `How to install ${name}`, url: INSTALL_URLS[h.id] }, { kind: "check_again" }, { kind: "switch" }],
      };
    case "not_signed_in":
      if (h.id === "gemini")
        return {
          tone: "problem",
          title: "Gemini needs your API key",
          cause: "Gemini's command-line sign-in can't be used by other apps, so My Magic UW uses your own key instead.",
          next: "Create a key in Google AI Studio and paste it here. It's stored encrypted on this computer.",
          actions: [{ kind: "add_key" }, { kind: "link", label: "Get a key in Google AI Studio", url: GEMINI_KEY_URL }],
        };
      if (h.mode === "instant")
        // Operator, 2026-09-27: never start a sign-in from the app; say how, then check again.
        return {
          tone: "problem",
          title: `${name} isn't signed in on this computer`,
          cause: `My Magic UW uses the ${name} already on this computer and never signs in for you.`,
          next: "Open a terminal and run {command}, sign in, then click Check again.",
          command: SIGN_IN_COMMANDS[h.id],
          actions: [{ kind: "check_again" }, ...chat(h)],
        };
      return {
        tone: "problem",
        title: `Sign in to ${name}`,
        cause: `The app's ${name} profile isn't signed in yet.`,
        next: `Sign in with ${provider}'s own page in the terminal, then check again.`,
        actions: [{ kind: "use_profile" }, { kind: "check_again" }],
      };
    case "plan_insufficient":
      return {
        tone: "problem",
        title: `Your ${plan} can't run ${name}`,
        cause:
          h.id === "claude"
            ? "Claude Code needs a Pro or Max plan, or an API key with credit."
            : "Codex needs a ChatGPT plan that includes it, such as Plus.",
        next: `Upgrade your plan, or switch to ${other(h.id)}.`,
        actions: [...(UPGRADE[h.id] ? [{ kind: "link" as const, ...UPGRADE[h.id]! }] : []), { kind: "switch" }, ...chat(h)],
      };
    case "usage_limited":
      return {
        tone: "wait",
        title: `${name}'s usage limit is reached`,
        cause: h.resetsAt ? `Your ${plan} says it resets ${h.resetsAt}.` : `Your ${plan} limit resets later; ${name} didn't say when.`,
        next: `Wait for the reset, or switch to ${other(h.id)}. Background work pauses until then; studying still works.`,
        actions: [...(USAGE[h.id] ? [{ kind: "link" as const, ...USAGE[h.id]! }] : []), { kind: "switch" }, { kind: "check_again" }],
      };
    case "model_unavailable":
      return {
        tone: "problem",
        title: "That model isn't on your plan",
        cause: `${name} refused the model this task asked for.`,
        next: canChat
          ? `Open Quick chat and type /model to see what your plan includes, or switch to ${other(h.id)}.`
          : `Check which models your plan includes in ${name} (/model), or switch to ${other(h.id)}.`,
        actions: [...chat(h), { kind: "switch" }],
      };
    case "offline":
      return {
        tone: "wait",
        title: `Can't reach ${provider}`,
        cause: "This computer couldn't connect to the AI service.",
        next: "Check your internet connection, then check again. Studying and saved courses still work offline.",
        actions: [{ kind: "check_again" }],
      };
  }
}
