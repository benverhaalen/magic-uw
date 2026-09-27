const providers = [
  {
    name: "ChatGPT",
    steps:
      "Settings → Data controls → turn off Improve the model for everyone.",
    note: "This controls training on future chats. History and memory have separate controls; disabling training does not delete them. Feedback can still include the conversation for improvement.",
    source:
      "https://help.openai.com/en/articles/7730893-data-controls-in-chatgpt",
  },
  {
    name: "Claude · personal account",
    steps: "Settings → Privacy → turn off Help Improve our AI models.",
    note: "Incognito chats stay out of history and memory and are not used for training. Default retention is 30 days; safety and organization rules can differ. Memory settings are separate.",
    source:
      "https://privacy.claude.com/en/articles/12109829-how-do-i-change-my-model-improvement-privacy-settings",
    extraSource:
      "https://support.claude.com/en/articles/12260368-use-incognito-chats",
  },
  {
    name: "Gemini · personal account",
    steps:
      "Gemini → Activity → On → Turn off, or Turn off and delete activity.",
    note: "Future chats are excluded from model training unless you submit feedback. Chats can still be retained for up to 72 hours, and security review can still occur. Memory and connected apps have separate controls.",
    source:
      "https://support.google.com/gemini/answer/13278892?co=GENIE.Platform%3DDesktop&hl=en",
    extraSource: "https://support.google.com/gemini/answer/13594961?hl=en",
  },
  {
    name: "Gemini · UW account",
    steps:
      "Use your UW Google Workspace account through NetID for UW’s managed service.",
    note: "UW documents no model training or human review and 36-month chat retention. School administrators control the applicable settings. These protections do not extend to Jev or other services.",
    source: "https://kb.wisc.edu/144080",
  },
  {
    name: "Jev · TypeSafe",
    steps:
      "Turn off Jev judgments above to stop future requests, or choose Keep AI context local to block all hosted AI context.",
    note: "Enabled judgments send the selected text through our gateway to TypeSafe. TypeSafe says it does not train on requests. We have not verified a fixed retention period or zero-retention coverage for our account.",
    source: "https://typesafe.ai/legal/privacy-policy",
    extraSource: "https://docs.typesafe.ai/legal.md",
  },
];

export function ProviderGuidance({
  open,
  disabled,
}: {
  open: (url: string) => void;
  disabled: boolean;
}) {
  return (
    <section className="settings-section">
      <h2>Hosted provider controls</h2>
      <p>
        A hosted service receives the context you send and applies its own data
        rules. My Magic UW settings do not change your provider account
        settings. ChatGPT, Claude, and Gemini connections are not available in
        this build.
      </p>
      <div className="provider-guidance">
        {providers.map((provider) => (
          <details key={provider.name}>
            <summary>{provider.name}</summary>
            <p>{provider.steps}</p>
            <p className="small muted">{provider.note}</p>
            <div className="inline-actions">
              <button
                className="subtle-button"
                disabled={disabled}
                onClick={() => open(provider.source)}
              >
                Official guidance ↗
              </button>
              {provider.extraSource ? (
                <button
                  className="subtle-button"
                  disabled={disabled}
                  onClick={() => open(provider.extraSource!)}
                >
                  Data handling details ↗
                </button>
              ) : null}
            </div>
          </details>
        ))}
      </div>
      <p className="small muted">
        Checked September 26, 2026. Training, memory, deletion, and retention
        are separate controls. Account type and settings can change.
      </p>
    </section>
  );
}
