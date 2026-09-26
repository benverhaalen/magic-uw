# AI choices and privacy

Accepted product direction, September 26, 2026. This describes the intended experience, not completed provider integrations or a published privacy policy.

## Four choices

ChatGPT, Claude, Gemini, or a local model. We want students to use any account with the three named hosted providers. Exact account tiers, authorized connection methods, and usage limits still need verification. Do not quietly replace this requirement with developer API keys or a paid-plan-only flow.

Only UW and the selected hosted AI should require sign-in. Local AI needs only UW. No separate Magic Canvas, Jev, model-hub, or relay-service account. Our internal service authentication must not introduce another student login.

## Automatic local selection

When the student does not choose hosted AI, provide local AI as a built-in alternative. Detect the system and select a suitable open-source model automatically. Avoid requiring knowledge of RAM, GPU memory, quantization, or inference runtimes. Explain necessary download size and storage before downloading; never silently fall back to a hosted provider.

**Candidate to evaluate:** [AlexsJones/llmfit](https://github.com/AlexsJones/llmfit). Its README describes hardware detection, model/quantization recommendations, JSON interfaces, and macOS/Windows support. The repository identifies an MIT license. These are source claims, not our integration tests. No dependency has been adopted or installed.

Selection must balance actual learning-task quality, available memory, context needs, responsiveness, and license compatibility. A hardware-fit ranking alone does not establish the best tutor. Model weights have separate licenses; an open-source selector does not make every suggested model eligible. Keep a suitable no-account download path and explain unsupported hardware honestly. Exact selector, runtime, and model shortlist remain open.

## Who sees what

The product must give a clear feature-specific disclosure before sending private content. The table below is the required boundary, not a claim about implemented controls.

| Recipient | Intended data access |
| --- | --- |
| Local app | Course captures, evidence, student state, and locally stored sessions needed for authorized reads |
| Selected hosted AI | Only context needed for the request: prompts, relevant course excerpts/policy, selected conversation history, and relevant drafts or practice answers; attachments/screens only when the feature calls for them and the student understands the handoff |
| Jev through our proxy | Bounded state and candidate options required for each judgment; exclude identity and unrelated content where unnecessary |
| Local model | Selected context processed on the device; model download is distinct from uploading course content |

UW passwords, session cookies, and authentication tokens must not be sent as model context. Our proxy is an additional processing boundary: its logs, retention, and hosting must be accounted for too. Owning the Jev bill does not remove this disclosure requirement.

## Data-usage settings guidance

For each hosted provider, explain what is transmitted, why, and what its current account-specific policies allow it to retain or use. Link current official guidance and date the check. Distinguish model training/improvement, conversation history, personalization/memory, retention, and operational/security processing; disabling one does not necessarily disable the others.

Suggest available settings that reduce optional use, with precise steps verified for the actual account type. Clearly distinguish settings we enforce locally from settings the user must change at the provider. Do not claim a provider setting was changed unless verified. Provider-specific instructions are pending research; do not invent universal switches or retention guarantees.

A local-language-model selection still uses cloud processing if hosted Jev is enabled. A **fully local processing mode** must disable or replace hosted Jev and other content uploads, with any resulting feature limits explained. Do not label the mixed configuration fully local.

## Jev ownership

One Magic Canvas–owned Jev key, paid for by us, kept server-side. Students never enter it or create a Jev account. The app accesses our proxy without adding a new user-facing sign-in. Access control and abuse limits are technical details still to resolve.
