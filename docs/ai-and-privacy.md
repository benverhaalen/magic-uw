# AI choices and privacy

Accepted direction and implementation notes, checked September 26, 2026. Provider guidance was checked against live official sources on that date. This is a team reference, not a published privacy policy or a claim that we changed anyone's account settings.

## Paid AI direction and current implementation

Ben accepted Nathaniel's $5 one-time app license plus the student's own paid AI plan or key. Intended routes are Claude Code, Codex, Gemini CLI with a paid key, and OpenRouter. Prefer existing supported client sign-in; guide setup when absent. UW, provider setup, and license activation are the intended prerequisites without a separate Magic Canvas or Jev user account. This supersedes the any-account/local-default launch requirement; see [the recorded resolution](decisions.md#pricing-and-ai-access-resolution--september-26). No payment flow or new provider adapter is implemented by this decision.

**Built:** local inference adapter and desktop controls; a separately enabled Jev gateway; local stdio MCP tools with per-client course/category grants, credential export, and revocation; privacy preferences and sharing receipts. **Not built:** embedded ChatGPT, Claude, or Gemini account connections or subscription-backed inference. Selecting a hosted provider records a preference and enables its permitted data boundary; it does not connect an account. A compatible external MCP client can read explicitly granted evidence. Compatibility with every provider, account type, and tier is unverified. The gateway is implemented but not deployed. Local inference has adapter tests but has not been demonstrated with an installed runtime and real model on this machine.

Subscriptions do not automatically authorize API use by our app. Verify each authorized connection method, tier, administrator restriction, and usage limit. Disclose the paid API-key requirement on the intended Gemini/OpenRouter routes; never describe our hosted key as the student's subscription.

## Principles that must reach the implementation

- Local storage and hosted-sharing-off remain the privacy defaults. The paid AI launch direction requires explicit provider consent; payment or account connection alone does not grant data access. Show the recipient, purpose, and selected context.
- Send the minimum useful context. Credentials, cookies, tokens, and unrelated data never belong in model context. Omitting identity fields does not anonymize free text.
- Training, history, memory, retention, human review, and security processing are separate controls. Turning one off does not turn the others off.
- Our settings control our requests. Provider settings are changed at the provider; never imply they were inspected or changed without evidence.
- A local language model with hosted Jev enabled is a mixed configuration. Fully local AI processing disables hosted Jev and other content uploads. Reading UW sources and downloading models are separate network activities.
- Revocation stops future requests and cancels work where possible; it cannot retrieve data already sent. Local deletion does not delete provider records or backups.
- Show the account type and applicable policy. Personal and university-managed accounts can have different protections and administrator access.

## Accepted disclosure flow — implementation pending

Obtain consent once per provider, with recipient, purpose, data categories, applicable provider settings, and revocation explained. Each request shows its selected sources/context without another blocking confirmation and creates an inspectable receipt. The first request sharing a new sensitive category (such as student work, grades, comments, or communications) requires a blocking preview; **always preview** requires one every time. Changed recipients need their own consent. Code still checks course/category grants and current privacy settings on every request. Receipts must describe the payload actually sent, not a different preview.

This is Ben's accepted correction; provider onboarding, sensitive-category first-use tracking, and always-preview controls are not yet implemented. Existing flags/MCP grants and receipts provide only part of it. Choosing a paid route does not enable sharing automatically or expose planning records.

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

The decided policy is to remove student identities and unnecessary personal identifiers from outgoing free text while retaining instructor/author names when they help interpret course material. It is implemented as the [protection layers](#protection-layers) below. Never equate it with anonymization: distinctive details can still identify people. The redaction policy and proposed local citation-mapping boundary are in [pipeline details](pipeline-details.md#name-scrubbing-and-exact-citations).

The gateway handles text in memory without persisting bodies. Its database stores device IDs, bearer-token hashes, enrollment IPs, timestamps, and usage counters. Logs contain request metadata, not bodies, authorization headers, or keys. Hosting logs and a deletion schedule need to be set before deployment; current operational records remain until the operator removes them. See [gateway operations](../apps/gateway/README.md).

Local receipts record destination, purpose, category, resource IDs, character count, time, and status without duplicating text. A `sent` receipt means an attempted request or MCP response handoff, not confirmed provider delivery. Deleting local data clears coursework/history, downloaded documents, feed secrets, app-owned UW sessions, and MCP access files. Clearing only the UW session retains coursework. Neither removes UW records, provider copies, or OS backups.

The coursework database and downloads are permission restricted. Mail previews, gists and senders, OneNote/OneDrive notes bodies, and planning captures and records are also sealed with AES-256-GCM (see [at rest](#at-rest)); the rest of the database is not app encrypted. Feed capabilities and gateway credentials use OS-backed encryption. Exported MCP access files contain a revocable local credential with restrictive permissions; the database stores its hash. Keep the exported configuration and access file on the device. Exporting again rotates that connection's credential.

## Protection layers

Built and tested in isolation on `feat/privacy-hardening` (September 27); integrated means called by the running app, which needs the lead's merge. Code: `packages/core/src/privacy/`. Tests: `tests/privacy-*.test.ts`.

1. **Roster scrubber** (`identity.ts`, unchanged): known student names, emails, NetIDs and IDs from the manual roster and Canvas; instructors kept.
2. **Code detectors** (`privacy/detectors.ts`), each with a precision guard: email; phone (NANP with separators, or E.164 with a leading `+` and 8 to 15 digits); UW student ID (10 digits only after a context word such as ID, student, campus, Wiscard); Wiscard or campus card numbers (11 to 19 digits after a card context word); street address (number, capitalised street name, a street suffix, optional unit); date of birth (only after born, DOB, date of birth or birthday); URLs carrying a credential or signature (`verifier`, `token`, `sig`, `key`, `access_token`, `code`, `X-Amz-Signature` and similar, userinfo, or a JWT) and bare JWTs; IPv4 (octets checked; not after section, version or figure words; small dotted numbers need an IP context word) and IPv6; Canvas user IDs in `/users/<id>` or `user_id=`; card numbers (issuer prefix, length and Luhn); US SSN (validity rules; a bare 9-digit number needs an SSN context word); labelled NetIDs. These replace the roster scrubber's own patterns, which fixes two false positives: a bare 10-digit number (a timestamp or an ISBN) is kept, and a sentence-start common word that is also a first name ("Will this be on the exam?") is kept unless a name cue follows ("Will said", "Will's") or the same word appears capitalised mid-sentence.
3. **Pseudonyms** (`privacy/pseudonyms.ts`): within one request every value keeps one placeholder across all fields (`[EMAIL_1]` is the same address everywhere). Numbers are assigned in HMAC-SHA-256 order keyed by the install secret and the send context (`pack:<course>`, `guide:<course>`, `context:<recipient>:<course>`, `mcp:<tool>`), so a repeat of the same material gets the same placeholders (the pack cache stays warm) while another install or purpose ranks differently. The reverse map lives only in the request's memory. Names keep the roster's labels (`[STUDENT_SELF]`, `[STUDENT_n]`) for now; switching them to the per-request ranking is an open decision because existing tests pin those labels.
4. **Receipts** record replacement counts per kind (`protection`, for example 3 names, 1 email, 1 phone), counted from the placeholders in the exact payload, never the values. Migration v14 adds the column.
5. **Logs** (`privacy/log.ts`, `redactForLog`): a URL becomes host plus path class (numeric and opaque segments `:id`, page, file and user slugs `:slug`, no query or fragment); detector hits become `[kind]`; name-shaped runs of capitalised words become `[name]`; credential-keyed values become `[redacted]`. Used by the dev trial log, the worker's seal-failure line and main's startup error.

Measured on this laptop (Windows 11, Node 24), one 10 KB course payload with a 42-person roster: the roster scrubber alone 0.32 ms, the full protection pass 0.72 ms (2.3×).

### Egress coverage

| Path | Call site | Protection applied |
| --- | --- | --- |
| Explain context and preview (Claude, ChatGPT, Gemini, OpenRouter) | `packages/core/src/index.ts:231` (`context`) | Full pass per field, primed per request; citation projection `index.ts:290`; `validate-citations` `index.ts:899`; receipt counts `index.ts:291`, `:307` |
| Jev gateway (assignment kind) | `index.ts:482` → `packages/ai/src/index.ts:100` | The same `context(…, "jev")` payload; receipt with counts |
| Packs: quiz, cards | `packages/core/src/pack-handler.ts:347`, sent at `packages/runner/src/runner.ts:182` | Passages, sections, topics and frame, then the whole system prompt and input again in `beforeCall`; receipt counts `pack-handler.ts:419` |
| Study guides (guide, briefing, FAQ, timeline, compare, concept map) | `packages/packs/guide/src/run.ts:129` | As packs; receipt counts `run.ts:214` |
| Intent classify and ask | not on this branch | Must go through the pack path (`runPack` with `beforeCall`), which the sweep covers |
| MCP tools (`search`, `get_item`, `answer_course_question`, overview) | `packages/core/src/mcp.ts:97`, `:151` | Full pass per scope; projection for citations |
| Mail as a hosted prompt (`mail.gist`) | stub, `packages/core/src/jobs/mail-gist.ts:8` | `protectMail`: subject, preview and gist as course text; sender name and address pseudonymised (a retained instructor name is kept); mail and unmapped notes use the account-wide roster |
| OneNote and OneDrive notes | through the paths above | Same treatment as course text |
| Notes export to OneDrive (`appFolderPut`) | `packages/connectors/src/graph.ts:1413` | Not called by the app yet; a caller must pass the body through `protectText` first |
| `notes.fill`, `packages/agent-api` | not present on this branch | None needed yet |
| Planning (DARS, transcript, holds) | no path | Hard-blocked for every hosted recipient (`tests/egress.test.ts`, "maySend refuses planning…", and the sweep) |
| Dev trial log, startup errors, worker seal failures | `apps/desktop/src/main.ts:130`, `:1716`; `apps/desktop/src/worker.ts:296` | `redactForLog` |

`tests/privacy-canary-sweep.test.ts` seeds canary identities (names, emails, a phone, a student ID, a card, a signed URL, an address, a date of birth, a Canvas user URL) across a material, an assignment with grader comments, a discussion, mail, OneNote notes and planning. It drives every path above with recording fakes and asserts three things: no canary leaves; quotes returned against the protected text map back to the original sentence; and, as a control, the roster scrubber alone lets the non-roster identifiers through.

### At rest

- **What:** mail preview, gist, sender name and address, and text; notes text and parts; planning captures and record versions. Subjects, dates, categories and links stay in the clear.
- **How:** AES-256-GCM, a fresh IV per value, the column name as associated data. Main creates a 32-byte install secret, wraps it with Electron safeStorage in `privacy-key.enc`, and sends it to the worker over its message channel (never an environment variable, argument or log). HKDF derives the at-rest key and the pseudonym key. Without safeStorage nothing is sealed and pseudonyms use a per-process key.
- **Migration v14** (the lead renumbers at integration) adds `receipts.protection` and marks existing rows. The first key the worker receives seals every plaintext mail, notes and planning row in one transaction, reindexes mail and checkpoints the WAL. A sensitive write made before the key arrives is sealed the same way.
- **Search:** mail is indexed by subject and category only; its preview is decrypted in memory when read. Notes stay searchable for study, so their passage headings and index terms remain in the database.
- **Purge** zeroes the key in the worker, deletes `privacy-key.enc` and sends a new secret.
- **Cost:** 2,000 messages ingest in 390 to 540 ms unsealed and 490 to 580 ms sealed; reading them all takes 56 to 68 ms unsealed and 82 ms sealed; the lazy pass seals 2,000 rows in 266 ms.
- **Limits:** the MCP server process has no key, so it serves sealed mail and notes with empty bodies. A wrapped key that can no longer be unwrapped leaves sealed rows readable only as their clear part; the app never overwrites it. The pre-migration backup (`.pre-v14.bak`) stays a plaintext copy until the next migration or a purge.

## Local model selection

The integrated route uses [llmfit](https://github.com/AlexsJones/llmfit) for hardware recommendations and selects a compatible **already installed** Ollama model. The adapter checks installed tag, quantization, memory fit, and context instead of guessing a fallback. Missing tools or suitable weights produce an unavailable state, never hosted inference.

Automatic installation/downloads are not implemented and are no longer a launch requirement under the paid-AI direction. If pursued later, explain download size and storage before approval and avoid another model-hub account. Hardware fit estimates do not establish tutoring quality. The selector's MIT license does not license model weights: the install shortlist needs separate license and learning-task evaluation. No model was downloaded for this scaffold.

## Provider settings students can use

These instructions apply in the provider's interface, not through Magic Canvas. They describe the existing chat/MCP guidance; do not assume chat-app controls govern a CLI, API key, or OpenRouter intermediary. Route-specific disclosures for the new paid-AI adapters still need verification. Recheck at connection time; account type and interface can change. Feedback can authorize additional processing even after opting out of training.

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

The current gateway uses one owner-paid key. The accepted product direction keeps it for Claude/Codex/Gemini users and adds a separate, unimplemented OpenRouter path where the student pays for Jev through their own OpenRouter key. No OpenRouter key handling or judgment egress exists in the current app. Its future route must disclose OpenRouter and the actual inference recipient, protect the student key locally, and preserve the same consent/minimization gates. Put `TYPESAFE_API_KEY` only in the ignored gateway environment file or deployment secret store; never in a desktop bundle, client environment variable, Markdown, or Git. Devices enroll with opaque bearer credentials stored using OS-backed encryption, without another user sign-in.

The gateway accepts one fixed task, validates bounded input, applies device/global request and concurrency limits, and reserves a persistent daily budget before calling TypeSafe. A 429 response defers assignment enrichment without consuming a job attempt. Its kind-specific cooldown survives restart and applies to newly queued enrichment; unrelated registered jobs continue through their own consent checks. The client honors numeric or HTTP-date Retry-After with a one-minute to one-day bound and a fifteen-minute fallback. This recovery is tested with synthetic responses, not a live provider. Failed attempts consume the budget. Anonymous enrollment does not verify identity; global caps bound spending but do not prevent every abuse pattern. Deployment and a live key-backed request remain unverified.

TypeSafe says Jev is not trained on customer requests or responses. Its privacy policy also excludes training/fine-tuning on inputs and describes service-provider processing and US hosting. Retention is purpose-based: **no fixed default retention period has been verified**. [Jev model documentation](https://docs.typesafe.ai/models.md), [TypeSafe privacy policy](https://typesafe.ai/legal/privacy-policy)

Zero data retention is offered to enterprise customers; we have not established that it applies to this key. Do not promise zero retention, no human access, or terms equivalent to UW-managed Gemini. Confirm the applicable agreement, subprocessors, retention/deletion handling, and hosting policy before broad launch. TypeSafe's policy also excludes knowing collection of under-18 personal data; clarify permitted use before offering hosted Jev to under-18 students. [Legal overview](https://docs.typesafe.ai/legal.md), [processing agreement](https://typesafe.ai/legal/data-processing), [age statement](https://typesafe.ai/legal/privacy-policy)

## Planning stays local

The [planning handoff](planning-upgrade.md#storage-privacy-and-access) defines the current boundary: grades/GPA, holds, audit, history, and other planning records have separate local storage and no hosted, Jev, tutoring-context, or MCP path. Reserved planning/holds/audit flags default off; enabling an existing coursework category does not expose planning records. An audited category projection and actual-payload preview must precede any future sharing. The typed student summary excludes identity fields, but free text is not generally anonymized.

The product uses an app-owned UW session and exposes no enrollment, cart, waitlist, or audit-generation operation. Ben's specifically authorized headless Firefox development check is a separate, temporary evidence-gathering path; it does not introduce personal-cookie import into the product. Its private responses, credentials, and evidence remain outside Git and logs. Clearing the UW session preserves saved planning evidence with disconnected health; local-data deletion removes it.

Native account binding compares UW and Canvas identities locally and stores only opaque scopes/link evidence. It rechecks identity before releasing normalized results; multiple saved accounts block comparison. Clearing the session rotates the scope seed, so old saved accounts may require local removal before comparison can resume. Historical Canvas grades are local course metadata and are not added to existing model/MCP projections; planning grades and DARS stay in the separate no-egress namespace. An existing unofficial transcript was accessed for the authorized private investigation, without a new report request; no transcript payload is committed or sent to hosted AI.
