# AI choices and privacy

Accepted direction and implementation notes, checked September 26, 2026. Provider guidance was checked against live official sources on that date. This is a team reference, not a published privacy policy or a claim that we changed anyone's account settings.

## September 27 retrieval work — proposed data boundary

The local semantic retrieval and caption upgrade is in private baseline/candidate work, not an integrated processing path. Its required boundary is local passage embedding, with no course-text upload for embedding; model-weight downloads are separate network activity. Current account/course/category grants, exclusions, redaction and deletion must apply before indexing and returning evidence, with passage-hash/model-version invalidation. Caption acquisition is limited to already authorized accessible sources. Any bounded answer-repair or MCQ check must retain the actual provider consent, policy, context budget and request receipts. Private evaluation questions/course content are excluded from team commits. See the [adoption status](design-handoff.md#2026-09-27-1131-utc--retrieval-baseline-and-shared-ownership); this proposal does not expand any live data grant.

## Paid AI direction and current implementation

**Current state (September 27, 2026):** generation and the chat's grounded ask run on the student's own signed-in Claude Code or Codex through the app's runner: instant mode, tools off, an allowlisted environment and a tool-use tripwire ([architecture §6](architecture.md#6-the-ai-boundary)). Whether this subscription-CLI route fits each provider's terms is open (H5), and the price is $5 a month ([decision](decisions.md#2026-09-27--price-5-a-month)). The paragraphs below record the September 26 direction.

Ben accepted Nathaniel's $5 one-time app license (the price is now $5 a month: [decision](decisions.md#2026-09-27--price-5-a-month)) plus the student's own paid AI plan or key. Intended routes are Claude Code, Codex, Gemini CLI with a paid key, and OpenRouter. Prefer existing supported client sign-in; guide setup when absent. UW, provider setup, and license activation are the intended prerequisites without a separate Magic Canvas or Jev user account. This supersedes the any-account/local-default launch requirement; see [the recorded resolution](decisions.md#pricing-and-ai-access-resolution--september-26). No payment flow or new provider adapter is implemented by this decision.

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

The default is `local_only`, with hosted sharing off and no MCP grants. Jev requires selective cloud mode and explicit Jev/course-text permission; announcement triage additionally requires communications permission. An MCP read checks its client grant, selected courses, allowed categories, and current global privacy settings each time. A local recipient can use a grant in local-only mode; a hosted recipient also needs its provider selected and each requested category enabled. Label a connection by its actual destination: a local stdio transport does not make the connected AI local.

| Recipient                                                 | Current boundary                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local desktop                                             | Course records, downloaded documents, evidence, preferences, student state, and app-owned UW browser sessions. Grader feedback is collected locally by default. Sessions and feed capabilities remain separate from coursework and model context.                                                                        |
| Local Ollama runtime                                      | Selected course/title, instruction excerpt, directly linked supporting material, policy, and the student's question. The adapter uses loopback only, rejects redirects and remote model aliases, and verifies Ollama cloud functionality is disabled.                                                                    |
| Magic Canvas Jev gateway                                  | Assignment-kind classification receives course name (up to 200 characters), title (500), course text (12,000), and policy text (4,000), plus a device bearer credential for access.                                                                                                                                      |
| Magic Canvas Jev gateway — announcement triage            | For a new course announcement or discussion only: course name (200), message title (500), message text (4,000), and the titles and due dates of up to 10 open assignments in that course due within three weeks. Requires selective cloud, Jev enabled, a Jev consent record, and permission to share communications and course text. Each request writes a receipt. No URLs, account identifiers, grades, comments or planning records. |
| Magic Canvas Jev gateway — email triage                  | For new, unread Outlook mail that code placed in the course, office, organization or general categories (not advisor mail, meeting responses, Canvas notification copies or mail already read): the code's sender role (for example "university office"), the subject (500) and Outlook's own preview (255), identity-scrubbed, plus a code-matched course's name and up to 10 upcoming assignment titles and due dates. Never the sender's name or address, the full message, or attachments. Same gates and receipts as announcement triage. |
| TypeSafe                                                  | Those bounded course fields plus the gateway's fixed classification question. The owner key is attached only by the gateway.                                                                                                                                                                                             |
| ChatGPT / Claude / Gemini through a compatible MCP client | Bounded source passages, citations, due dates, freshness, and changes from the granted courses/categories. Grades and grader comments require their own permissions. The external AI controls its subsequent processing under its account policy; no embedded provider login or hosted answer generation is implemented. |

The Jev compiler excludes source URLs, cookies, account identifiers, grades, comments, and drafts as fields. Selected text can still contain private information. MCP conservatively treats all GitLab content as student work and messages as communications, each with a separate gate. Local feedback collection is independent of cloud permission: switching collection off stops future comment reads but does not erase previously saved feedback.

The decided policy is to remove student identities and unnecessary personal identifiers from outgoing free text while retaining instructor/author names when they help interpret course material. It is implemented as the [protection layers](#protection-layers) below. Never equate it with anonymization: distinctive details can still identify people. The redaction policy and proposed local citation-mapping boundary are in [pipeline details](pipeline-details.md#name-scrubbing-and-exact-citations).

The gateway handles text in memory without persisting bodies. Its database stores device IDs, bearer-token hashes, enrollment IPs, timestamps, and usage counters. Logs contain request metadata, not bodies, authorization headers, or keys. Hosting logs and a deletion schedule need to be set before deployment; current operational records remain until the operator removes them. See [gateway operations](../apps/gateway/README.md).

Local receipts record destination, purpose, category, resource IDs, character count, time, and status without duplicating text. A `sent` receipt means an attempted request or MCP response handoff, not confirmed provider delivery. Deleting local data clears coursework/history, downloaded documents, feed secrets, app-owned UW sessions, and MCP access files. Clearing only the UW session retains coursework. Neither removes UW records, provider copies, or OS backups.

The coursework database and downloads are permission restricted. Mail previews, gists and senders, OneNote/OneDrive notes bodies, planning captures and records, and `life_items` senders and gists are also sealed with AES-256-GCM (see [at rest](#at-rest)); the rest of the database is not app encrypted. Feed capabilities and gateway credentials use OS-backed encryption. Exported MCP access files contain a revocable local credential with restrictive permissions; the database stores its hash. Keep the exported configuration and access file on the device. Exporting again rotates that connection's credential.

## Protection layers

Built and tested in isolation on `feat/privacy-hardening` (September 27). It counts as integrated only once the running app calls it, which needs the lead's merge. Code: `packages/core/src/privacy/`. Tests: `tests/privacy-*.test.ts`.

### What is replaced where, and why teaching content is kept

The operator's correction (September 27): *"ensure that the intelligent model understands content so like be careful with stripping so much."* Protection is for **people and credentials**; it must not rewrite what the course teaches. What a text is decides what is replaced (`classOf` in `privacy/protect.ts`):

| Text | Examples | Replaced | Kept |
| --- | --- | --- | --- |
| **Teaching material** | instructor pages, slides, files, readings, assignment prompts, the syllabus, quiz questions, course policy | names of roster **students** (the student and classmates); emails; phone numbers; URLs carrying a credential or signature; Canvas `/users/<id>` links; labelled NetIDs and student IDs written with a context word | instructor and author names ("Prof. X said", "Keynes (1936)"); anyone who isn't a roster student ("Image by Will Drevo" when the roster has Will Hart); IPs, street addresses, dates, card-like and SSN-like numbers, and every other number, which is course content in a networking lab, a civics reading or a Luhn exercise |
| **Personal content** | discussion posts and replies, announcements, submission comments, grades and feedback, mail, the student's own notes (OneNote and OneDrive), student work in GitLab | everything above, plus card numbers, SSNs, IPs and street addresses **only after a person context word** ("my card is", "I live at", "my SSN is", "my IP is"); dates of birth after born or DOB; campus card numbers after a card word | the same numbers without a person context word |
| **Planning** | DARS, transcript, holds, history | never sent to any hosted recipient | none |

Placeholders are role-typed and consistent within one request (`[STUDENT_SELF]` for the student, `[STUDENT_3]` replied to `[STUDENT_1]`, `[EMAIL_2]`), so the relationships in the text survive. Unknown text is treated as personal, the more protective choice.

**Measured retention** (`tests/privacy-retention.test.ts`; 742 teaching texts, including 730 pages of the local OCW corpus, which is read on the machine and never committed; 696,516 characters). With a roster of five students, the pass changed 0 characters (0.0000%, target at most 0.5%). It made 0 non-person replacements (IPs, addresses, card, SSN or birth-date numbers) in teaching material (target 0). All 14 canaries planted in personal content were removed (target 0 leaks). Before the first-name fix below, the only change in the corpus was one image credit.

### The layers

1. **Roster scrubber** (`identity.ts`, unchanged): the manual and Canvas roster's student names, emails, NetIDs and IDs; instructors are kept.
2. **Code detectors** (`privacy/detectors.ts`), each with a precision guard:
   - email;
   - phone: NANP with separators, or E.164 with a leading `+` and 8 to 15 digits;
   - UW student ID: 10 digits, only after a context word;
   - Wiscard or campus card numbers, after a card word;
   - street address: number, capitalised street name and a street suffix;
   - date of birth: only after born, DOB or date of birth;
   - URLs with a credential or signature parameter (`verifier`, `token`, `sig`, `key`, `access_token`, `code`, `X-Amz-Signature`…), userinfo, or a JWT;
   - IPv4 (octets checked, section and version numbers excluded) and IPv6;
   - Canvas user IDs;
   - card numbers (issuer prefix, length and Luhn);
   - SSN (validity rules);
   - labelled NetIDs.

   The content class limits which detectors run (table above). The roster scrubber's own false positives are fixed: a bare 10-digit number (a timestamp or an ISBN) is kept. A sentence-start common word that is also a first name ("Will this be on the exam?") is kept unless a name cue follows. A classmate's first name followed by another surname is a different person and is kept.
3. **Pseudonyms** (`privacy/pseudonyms.ts`): within one request every person and value keeps one placeholder across all fields. Classmates and values are numbered in HMAC-SHA-256 order, keyed by the install secret and the send context (`pack:<course>`, `guide:<course>`, `context:<recipient>:<course>`, `agent:<grant>`, `notes.fill:<course>`). A repeat of the same material therefore gets the same placeholders, so the pack cache still hits at 0 tokens, while another install or purpose ranks differently and a provider can't follow one classmate across requests. The reverse map lives only in the request's memory. This replaced the roster-order labels on the lead's decision (September 27); three assertions in `identity-scrubber.test.ts` changed with it.
4. **Receipts** record replacement counts per kind (`protection`, for example 3 names, 1 email, 1 phone), counted from the exact payload, never the values. Agent-API and MCP receipts sum the request's counts.
5. **Logs** (`privacy/log.ts`, `redactForLog`): logs need no content, so every detector runs without context. A URL becomes host plus path class with no query; name-shaped words become `[name]`; credential-keyed values become `[redacted]`.

**Cost** (the operator: "if privacy really adds latency it has to be miniscule"; `tests/privacy-budget.test.ts`, `tests/intent-latency.test.ts`; Windows 11, Node 24, a 42-person roster):

| Budget | Before | After | Limit |
| --- | --- | --- | --- |
| Protection pass, 10 KB teaching text, p95 | 0.84 ms | 0.32–0.36 ms | 1 ms |
| Protection pass, 10 KB personal text, p95 | 0.87 ms | 0.84–1.06 ms | 2 ms |
| The same text sent again (cached by text hash and roster version), p95 | 0.08–0.10 ms | 0.03–0.09 ms | close to 0 |
| Command bar: privacy on the critical path (submit to send), measured directly, p95 | not protected | 0.025 to 0.043 ms; 0.027 to 0.030 ms with every core busy | 1 ms (asserted as 6.5x a same-run reference scan) |
| Command bar: protection work on a code hit | none | none (0 calls, 0 sends) | 0 |
| Reading 2,000 messages, sealed vs unencrypted | +20 to +47% | 17 to 28% faster | within 10% |

How: teaching text skips the detectors it would discard; the roster scrubber runs only on windows around a roster word; spans are cached per (roster version, class, text hash); the command bar's roster is rebuilt only when sources or identities change and is warmed when the bar opens. Sealed mail and notes versions are opened once per session (a version never changes) and the cache is warmed when the key arrives (45–50 ms for 2,000 messages at worker start). The outlier is artificial text naming a roster student every 200 characters: about 1.1 ms, spent in `identity.ts`'s whole-text pass. On the command bar, the stable prefix (catalogue, argument glossary, courses) and course labels are protected when the bar opens and cached by content, and the roster's revision is checked then and on a timer after a request; between submit and send only the student's own words are protected. So a roster change (a newly synced classmate) is picked up when the bar next opens or within about 2 s of the previous command. The budget tests assert ratios to a reference measured in the same run (one plain scan of a 10 KB text with the full detector set), so they scale with the machine; `pnpm magic:perf --suite privacy` reports the absolute numbers with the machine named.

### Egress coverage

| Path | Call site | Protection applied |
| --- | --- | --- |
| Explain context and preview (Claude, ChatGPT, Gemini, OpenRouter) | `packages/core/src/index.ts:267` (`context`) | Per field at its class; citation projection; `validate-citations` `index.ts:833`; receipt counts `index.ts:330`, `:346` |
| Jev gateway (assignment kind) | `packages/core/src/jobs/enrich.ts:72` → `packages/ai/src/index.ts:100` | The same `context(…, "jev")` payload; receipt with counts |
| Packs: quiz, cards | `packages/core/src/pack-handler.ts:361`, sent at `packages/runner/src/runner.ts:182` | Each passage at its resource's class; labels and frame as teaching; the assembled prompt again in `beforeCall`; receipt counts `pack-handler.ts:435` |
| Study guides (six kinds) | `packages/packs/guide/src/run.ts:129` | As packs; receipt counts `run.ts:216` |
| `notes.fill` (fill from slides) | `packages/notes/src/fill.ts:122` | Slides at their class, the student's headings as personal, the prompt again in `beforeCall`; quotes mapped back to the original before `findQuote`; receipt counts `fill.ts:153` |
| MCP tools and agent API v1 | `packages/agent-api/src/session.ts:114`, `:168` (MCP is an adapter over it) | Fields at the resource's class; grades and comments as personal; protected projection; receipt counts `session.ts:297` |
| Command bar: intent classify | `packages/core/src/intent/router.ts:131` (only after the code resolver misses) | The command and hints as personal text; the catalogue, courses and course labels as teaching text, protected when the bar opens and cached by content; the model's arguments restored to the student's words; a code hit does no protection work and sends nothing |
| Command bar: grounded ask | `packages/core/src/intent/ask.ts:78` | The question as personal; each passage at its resource's class; quotes and sentences mapped back to the original before code checks them |
| Mail as a hosted prompt (`mail.gist`) | stub, `packages/core/src/jobs/mail-gist.ts:8` | `protectMail`: subject, preview and gist as personal text; sender name and address always pseudonymised (a retained instructor keeps their name); account-wide roster |
| Notes sync to the student's own OneDrive or Google Drive | `packages/notes/src/remote.ts:51`, `:149`, `:159` | Sent verbatim by design: the student's own document to their own account, not an AI recipient. Rewriting it would corrupt their notes |
| Planning | no path | Hard-blocked for every hosted recipient (`tests/egress.test.ts`, and the sweep) |
| Dev trial log, startup errors, worker seal and backup lines | `apps/desktop/src/main.ts:142`, `:1797`; `apps/desktop/src/worker.ts:45`, `:412` | `redactForLog` |

`tests/privacy-canary-sweep.test.ts` seeds canaries across the resource kinds:

- teaching material: people and credentials, plus content that must survive (an IP, an address, a Luhn example, a sample SSN, a birth date, a citation);
- personal content (a discussion, grader comments, mail, OneNote notes): the full set, written with person context;
- planning.

It drives every path above with recording fakes and asserts four things:

- no canary leaves;
- the teaching content reaches the model unchanged;
- quotes map back to the original sentence;
- as a control, the roster scrubber alone lets the non-roster identifiers through.

`tests/privacy-notes-fill.test.ts` covers `notes.fill`.

### At rest

- **What:** mail preview, gist, sender name and address, and text; notes text and parts; planning captures and record versions; `life_items` sender and gist. Subjects, dates, categories and links stay in the clear.
- **How:** AES-256-GCM with a fresh IV per value and the column name as associated data. Main creates a 32-byte install secret, wraps it with Electron safeStorage in `privacy-key.enc`, and sends it to the worker over its message channel, never through an environment variable, an argument or a log. HKDF derives the at-rest key and the pseudonym key from it. Without safeStorage nothing is sealed, and pseudonyms use a per-process key.
- **Migration v14** runs after main's v12 and v13. It adds `receipts.protection` and marks existing rows. The first key the worker receives seals every plaintext row of those columns in one transaction, reindexes mail and checkpoints the WAL.
- **The pre-migration backup** of a database older than v14 is a plaintext copy. After the migration commits, `PRAGMA integrity_check` must return ok, and every table carried over from the backup must keep its row count. The exceptions are the compactions migrations make by design: v6's latest observation per field and v12's capture pruning. If both checks pass, the backup is deleted. If either fails, the backup is kept, `backupCheck()` gives the reason, and the worker logs it. This was the lead's decision on September 27. `restoreMigrationBackup` still works for a kept backup.
- **Search:** mail is indexed by subject and category only; its preview is decrypted in memory when read. Notes stay searchable for study, so their passage headings and index terms remain in the database: an accepted limit.
- **Purge** zeroes the key in the worker, deletes `privacy-key.enc` and sends a new secret.
- **Cost:** 2,000 messages ingest in 390 to 540 ms unsealed and 490 to 580 ms sealed. Reads are 17 to 28% faster sealed than unencrypted, because opened versions are cached for the session and warmed when the key arrives; the lazy pass seals 2,000 rows in 266 ms.
- **Known limits (accepted):**
  - The read-only MCP reader process has no key, so it serves sealed mail and notes with empty bodies.
  - A wrapped key that can no longer be unwrapped leaves sealed rows readable only as their clear part; the app never overwrites the key.
  - Session note bodies (`packages/notes`) are not sealed.

## Accounts and payments

An optional My Magic UW account (built, not yet live) sends the student's **email address** to our Supabase project to sign in, and records whether that account bought the app: the Lemon Squeezy order id, customer id, variant, amount, currency, date, test-mode flag and paid/refunded status. No coursework, course names, grades, UW identifiers or anything read from UW goes there. Lemon Squeezy, as merchant of record, holds the buyer's name, address and payment details; our webhook ignores them. Having an account or paying grants no data access and does not change hosted-sharing consent. Details: [accounts and payments](accounts-and-payments.md).

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

**September 27, 2026:** desktop builds may carry the owner's key, compiled into the main process only, with the gateway running in-process on `127.0.0.1`; this temporarily reverses the server-side-only rule for those builds ([decision](decisions.md#2026-09-27--embedded-jev-key-temporary)). The hosted gateway is not deployed.

The current gateway uses one owner-paid key. The accepted product direction keeps it for Claude/Codex/Gemini users and adds a separate, unimplemented OpenRouter path where the student pays for Jev through their own OpenRouter key. No OpenRouter key handling or judgment egress exists in the current app. Its future route must disclose OpenRouter and the actual inference recipient, protect the student key locally, and preserve the same consent/minimization gates. Put `TYPESAFE_API_KEY` only in the ignored gateway environment file or deployment secret store; never in a desktop bundle, client environment variable, Markdown, or Git. Devices enroll with opaque bearer credentials stored using OS-backed encryption, without another user sign-in.

The gateway accepts one fixed task, validates bounded input, applies device/global request and concurrency limits, and reserves a persistent daily budget before calling TypeSafe. A 429 response defers assignment enrichment without consuming a job attempt. Its kind-specific cooldown survives restart and applies to newly queued enrichment; unrelated registered jobs continue through their own consent checks. The client honors numeric or HTTP-date Retry-After with a one-minute to one-day bound and a fifteen-minute fallback. This recovery is tested with synthetic responses, not a live provider. Failed attempts consume the budget. Anonymous enrollment does not verify identity; global caps bound spending but do not prevent every abuse pattern. Deployment and a live key-backed request remain unverified.

TypeSafe says Jev is not trained on customer requests or responses. Its privacy policy also excludes training/fine-tuning on inputs and describes service-provider processing and US hosting. Retention is purpose-based: **no fixed default retention period has been verified**. [Jev model documentation](https://docs.typesafe.ai/models.md), [TypeSafe privacy policy](https://typesafe.ai/legal/privacy-policy)

Zero data retention is offered to enterprise customers; we have not established that it applies to this key. Do not promise zero retention, no human access, or terms equivalent to UW-managed Gemini. Confirm the applicable agreement, subprocessors, retention/deletion handling, and hosting policy before broad launch. TypeSafe's policy also excludes knowing collection of under-18 personal data; clarify permitted use before offering hosted Jev to under-18 students. [Legal overview](https://docs.typesafe.ai/legal.md), [processing agreement](https://typesafe.ai/legal/data-processing), [age statement](https://typesafe.ai/legal/privacy-policy)

## Course AI policy and the UW–Madison default

A course's own AI policy decides what Magic's AI help may do; a restriction blocks AI help. When a course states no AI policy at all, UW–Madison's general guidance applies ([decision](decisions.md#2026-09-27--uwmadison-default-ai-policy)). The source is the Office of Student Conduct and Community Standards page [Generative Artificial Intelligence](https://conduct.students.wisc.edu/artificial-intelligence/), fetched 2026-09-27: “Students are responsible for knowing their instructor's expectations when it comes to using AI tools. If it is unclear whether AI tools are allowed in a particular course or for an assignment, it is the student's responsibility to ask their instructor before using them. Instructors' expectations will vary from course to course.” The page names unauthorized use as a possible violation of UWS 14.03(1)(b), Use of Unauthorized Materials.

Under the default, study help on course material runs, and Magic never drafts, solves or rewrites graded work: it explains concepts and points to course sources, and every answer touching an open graded item ends with “No course AI policy found, so UW–Madison's guidelines apply: study help is fine; ask your instructor before using AI on graded work.” and the link. The page also warns that “posting queries or text into AI tools may share that information with the broader internet community”; the consent, preview and receipt rules above apply unchanged. The default is guidance applied by code, not a UW endorsement of Magic.

## Planning stays local

The [planning handoff](planning-upgrade.md#storage-privacy-and-access) defines the current boundary: grades/GPA, holds, audit, history, and other planning records have separate local storage and no hosted, Jev, tutoring-context, or MCP path. Reserved planning/holds/audit flags default off; enabling an existing coursework category does not expose planning records. An audited category projection and actual-payload preview must precede any future sharing. The typed student summary excludes identity fields, but free text is not generally anonymized.

The product uses an app-owned UW session and exposes no enrollment, cart, waitlist, or audit-generation operation. Ben's specifically authorized headless Firefox development check is a separate, temporary evidence-gathering path; it does not introduce personal-cookie import into the product. Its private responses, credentials, and evidence remain outside Git and logs. Clearing the UW session preserves saved planning evidence with disconnected health; local-data deletion removes it.

Native account binding compares UW and Canvas identities locally and stores only opaque scopes/link evidence. It rechecks identity before releasing normalized results; multiple saved accounts block comparison. Clearing the session rotates the scope seed, so old saved accounts may require local removal before comparison can resume. Historical Canvas grades are local course metadata and are not added to existing model/MCP projections; planning grades and DARS stay in the separate no-egress namespace. An existing unofficial transcript was accessed for the authorized private investigation, without a new report request; no transcript payload is committed or sent to hosted AI.
