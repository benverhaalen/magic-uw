# AI choices and privacy

Accepted direction and implementation notes, checked September 26, 2026. Provider guidance was checked against live official sources on that date. This is a team reference, not a published privacy policy or a claim that we changed anyone's account settings.

## Four choices, two sign-ins at most

ChatGPT, Claude, Gemini, or a local model. The goal remains access with any account from those three hosted providers. Only UW and the selected hosted AI should require sign-in. Local AI needs only UW; there is no separate Magic Canvas or Jev account.

**Built:** local inference adapter and desktop controls; a separately enabled Jev gateway; local stdio MCP tools with per-client course/category grants, credential export, and revocation; privacy preferences and sharing receipts. **Not built:** embedded ChatGPT, Claude, or Gemini account connections or subscription-backed inference. Selecting a hosted provider records a preference and enables its permitted data boundary; it does not connect an account. A compatible external MCP client can read explicitly granted evidence. Compatibility with every provider, account type, and tier is unverified. The gateway is implemented but not deployed. Local inference has adapter tests but has not been demonstrated with an installed runtime and real model on this machine.

Subscriptions do not automatically authorize API use by our app. Verify each authorized connection method, tier, administrator restriction, and usage limit. Do not silently substitute a developer API key requirement or describe our hosted key as the student's subscription.

## Principles that must reach the implementation

- Local processing is the default. Cloud assistance is a feature-specific choice, with its recipient, purpose, and selected context visible before enabling it.
- Send the minimum useful context. Credentials, cookies, tokens, and unrelated data never belong in model context. Omitting identity fields does not anonymize free text.
- Training, history, memory, retention, human review, and security processing are separate controls. Turning one off does not turn the others off.
- Our settings control our requests. Provider settings are changed at the provider; never imply they were inspected or changed without evidence.
- A local language model with hosted Jev enabled is a mixed configuration. Fully local AI processing disables hosted Jev and other content uploads. Reading UW sources and downloading models are separate network activities.
- Revocation stops future requests and cancels work where possible; it cannot retrieve data already sent. Local deletion does not delete provider records or backups.
- Show the account type and applicable policy. Personal and university-managed accounts can have different protections and administrator access.

## What the current app shares

The default is `local_only`, with hosted sharing off and no MCP grants. Jev requires selective cloud mode and explicit Jev/course-text permission. An MCP read checks its client grant, selected courses, allowed categories, and current global privacy settings each time. A local recipient can use a grant in local-only mode; a hosted recipient also needs its provider selected and each requested category enabled. Label a connection by its actual destination: a local stdio transport does not make the connected AI local.

| Recipient                                                 | Current boundary                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local desktop                                             | Course records, downloaded documents, evidence, preferences, student state, and app-owned UW browser sessions. Grader feedback is collected locally by default. Sessions and feed capabilities remain separate from coursework and model context.                                                                        |
| Local Ollama runtime                                      | Selected course/title, instruction excerpt, directly linked supporting material, policy, and the student's question. The adapter uses loopback only, rejects redirects and remote model aliases, and verifies Ollama cloud functionality is disabled.                                                                    |
| Magic Canvas Jev gateway                                  | Assignment-kind classification receives course name (up to 200 characters), title (500), course text (12,000), and policy text (4,000), plus a device bearer credential for access.                                                                                                                                      |
| TypeSafe                                                  | Those bounded course fields plus the gateway's fixed classification question. The owner key is attached only by the gateway.                                                                                                                                                                                             |
| ChatGPT / Claude / Gemini through a compatible MCP client | Bounded source passages, citations, due dates, freshness, and changes from the granted courses/categories. Grades and grader comments require their own permissions. The external AI controls its subsequent processing under its account policy; no embedded provider login or hosted answer generation is implemented. |

The Jev compiler excludes source URLs, cookies, account identifiers, grades, comments, and drafts as fields. Selected text can still contain private information. MCP conservatively treats all GitLab content as student work and messages as communications, each with a separate gate. Local feedback collection is independent of cloud permission: switching collection off stops future comment reads but does not erase previously saved feedback.

The decided policy is to remove student identities and unnecessary personal identifiers from outgoing free text while retaining instructor/author names when they help interpret course material. There is no implemented name scrubber yet. Never equate today's allowlist with anonymization or imply that this docs update changes transmitted data. The redaction policy and proposed local citation-mapping boundary are in [pipeline details](pipeline-details.md#name-scrubbing-and-exact-citations).

The gateway handles text in memory without persisting bodies. Its database stores device IDs, bearer-token hashes, enrollment IPs, timestamps, and usage counters. Logs contain request metadata, not bodies, authorization headers, or keys. Hosting logs and a deletion schedule need to be set before deployment; current operational records remain until the operator removes them. See [gateway operations](../apps/gateway/README.md).

Local receipts record destination, purpose, category, resource IDs, character count, time, and status without duplicating text. A `sent` receipt means an attempted request or MCP response handoff, not confirmed provider delivery. Deleting local data clears coursework/history, downloaded documents, feed secrets, app-owned UW sessions, and MCP access files. Clearing only the UW session retains coursework. Neither removes UW records, provider copies, or OS backups.

The coursework database and downloads are permission restricted but not app encrypted. Feed capabilities and gateway credentials use OS-backed encryption. Exported MCP access files contain a revocable local credential with restrictive permissions; the database stores its hash. Keep the exported configuration and access file on the device. Exporting again rotates that connection's credential.

## Local model selection

The integrated route uses [llmfit](https://github.com/AlexsJones/llmfit) for hardware recommendations and selects a compatible **already installed** Ollama model. The adapter checks installed tag, quantization, memory fit, and context instead of guessing a fallback. Missing tools or suitable weights produce an unavailable state, never hosted inference.

Automatic installation/downloads are not implemented. The intended experience remains automatic selection, with download size and storage explained before approval and no model-hub account. Hardware fit estimates do not establish tutoring quality. The selector's MIT license does not license model weights: the install shortlist needs separate license and learning-task evaluation. No model was downloaded for this scaffold.

## Provider settings students can use

These instructions apply in the provider's interface, not through Magic Canvas. Recheck at connection time; account type and interface can change. Feedback can authorize additional processing even after opting out of training.

### ChatGPT

- **Training:** account menu → Settings → Data controls → **Improve the model for everyone** → off. Future chats are excluded from training across the signed-in account; history remains. Submitted feedback can still include the conversation for improvement. Business, Enterprise, Edu, and Healthcare content is not used for training by default; workspace controls apply. [OpenAI data controls](https://help.openai.com/en/articles/7730893-data-controls-in-chatgpt)
- **Temporary use:** start a **Temporary** chat and choose **Unpersonalized** before the first message to avoid using existing memories, custom instructions, and plugins. Temporary chats do not create memories or enter regular history and are not used for improvement while temporary. OpenAI may retain them for up to 30 days for safety. Saving one as a regular chat changes which settings apply. [Temporary Chat](https://help.openai.com/en/articles/8914046-temporary-chat-in-chatgpt)
- **Memory:** Settings → Personalization → Memory; disable available memory/history-reference controls. This is not deletion. Remove saved memories and relevant chats separately; files and connected sources can require separate cleanup. [Memory controls](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)

### Claude

- **Training, personal Free/Pro/Max:** profile menu → Settings → Privacy → **Help Improve our AI models** → off. This excludes earlier and new data from future training; it cannot undo training underway or completed. Safety-related exceptions remain. [Model-improvement settings](https://privacy.claude.com/en/articles/12109829-how-do-i-change-my-model-improvement-privacy-settings)
- **History:** begin an **Incognito** chat using the ghost icon on a new chat outside a project. These chats do not enter history or memory and are not used for training. Default retention is 30 days; organizational retention and compliance access can apply. [Incognito chats](https://support.claude.com/en/articles/12260368-use-incognito-chats)
- **Memory:** in the new experience, Settings → Memory; disable chat search/reference and memory generation as desired and delete existing memories separately. Older interfaces may put controls under Capabilities. Deleting a chat alone may leave a saved memory. [Search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)
- **Retention and organizations:** deleted consumer chats are generally removed from backend storage within 30 days; training opt-in, feedback, flagged content, and legal/security exceptions can retain data longer. Commercial products do not train on inputs/outputs by default; feedback or explicit permission can change that treatment. [Consumer retention](https://privacy.claude.com/en/articles/10023548-how-long-do-you-store-my-data), [commercial data use](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training)

### Gemini with a personal Google account

- **Activity:** open Gemini → Activity, or [Gemini Apps Activity](https://myactivity.google.com/product/gemini). Choose **On → Turn off**, or **Turn off and delete activity**. Activity-off chats can still be retained for up to 72 hours; some connected apps become unavailable. Leave the separate optional audio/Live-recording improvement setting off. [Activity controls](https://support.google.com/gemini/answer/13278892?co=GENIE.Platform%3DDesktop&hl=en)
- **Training and review:** with Keep Activity off, future chats are not used for model training unless feedback is submitted. Security processing and some human review can still occur; previously reviewed material and feedback can persist longer. This setting does not mean nothing is stored. [Gemini privacy explanation](https://support.google.com/gemini/answer/13594961?hl=en)
- **Memory:** Settings & help → Personal context → Memory → off. Instructions and connected-app data are separate. Removing information may also require deleting relevant chats and disconnecting the source app. [Memory controls](https://support.google.com/gemini/answer/16598469)

### Gemini with the UW account

Use UW Google Workspace through NetID (`netid@wisc.edu`), not a personal Google account. UW states this service does not use data for generative-model training or human review, permits public/internal data, and retains chats for **36 months**. Delete chats through their three-dot menu. Start temporary chats from the dashed-circle/pencil icon on the web landing page; UW documents this for web/desktop, not mobile. These protections do not authorize every data category or extend automatically to our gateway. [UW Gemini guidance](https://kb.wisc.edu/144080)

Personal-account activity instructions do not override school administration. Google says administrators control work/school activity and retention. [Account-type distinction](https://support.google.com/gemini/answer/13278892?co=GENIE.Platform%3DDesktop&hl=en)

## Jev ownership and provider policy

One owner-paid key serves the team and users through the gateway. Put `TYPESAFE_API_KEY` only in the ignored gateway environment file or deployment secret store; never in a desktop bundle, client environment variable, Markdown, or Git. Devices enroll with opaque bearer credentials stored using OS-backed encryption, without another user sign-in.

The gateway accepts one fixed task, validates bounded input, applies device/global request and concurrency limits, and reserves a persistent daily budget before calling TypeSafe. Failed attempts consume the budget. Anonymous enrollment does not verify identity; global caps bound spending but do not prevent every abuse pattern. Deployment and a live key-backed request remain unverified.

TypeSafe says Jev is not trained on customer requests or responses. Its privacy policy also excludes training/fine-tuning on inputs and describes service-provider processing and US hosting. Retention is purpose-based: **no fixed default retention period has been verified**. [Jev model documentation](https://docs.typesafe.ai/models.md), [TypeSafe privacy policy](https://typesafe.ai/legal/privacy-policy)

Zero data retention is offered to enterprise customers; we have not established that it applies to this key. Do not promise zero retention, no human access, or terms equivalent to UW-managed Gemini. Confirm the applicable agreement, subprocessors, retention/deletion handling, and hosting policy before broad launch. TypeSafe's policy also excludes knowing collection of under-18 personal data; clarify permitted use before offering hosted Jev to under-18 students. [Legal overview](https://docs.typesafe.ai/legal.md), [processing agreement](https://typesafe.ai/legal/data-processing), [age statement](https://typesafe.ai/legal/privacy-policy)
