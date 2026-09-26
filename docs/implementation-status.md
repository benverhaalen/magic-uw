# Implementation status

Updated September 26, 2026. This page describes the current code. The broader direction remains in [Product](product.md) and [Architecture](architecture.md); this boundary does not replace it with a smaller product.

## What exists

| Area | Implemented behavior | Current limit |
| --- | --- | --- |
| Desktop | Electron main process, isolated preload/renderer, local utility worker; coursework list, item evidence, Sources, and Data & AI | Development build; no signed Mac or Windows installer |
| Entry state | Empty workspace, cloud sharing off, explicit synthetic fixture or local JSON import | Sample data is not a connected account |
| UW access | App-owned persistent browser partition; student-completed NetID/Duo; Canvas refresh uses that session | Embedded UW sign-in still needs live validation for this implementation; no claim of SSO across all UW services |
| Canvas connector | Bounded GETs for account scope, active courses, assignment/submission fields, and syllabus text; pagination, login detection, partial/error states | No attachments, linked-site crawling, email, PeopleSoft, DARS, ICS fallback, or browser-agent recipe engine |
| Local storage | SQLite migrations, versioned resource payloads and observations, FTS search, deletion markers, source health, completion state, job leases/retries, judgment cache | Resource-level evidence, not the full planned per-field provenance model |
| Deadline evidence | Scoped due claims, separate lock/event kinds, explicit-change precedence, visible conflicts, earlier date for planning only | No prose extraction, quote-offset validator, title-date parser, missing-year inference, or full authority/freshness hierarchy |
| Jev | One fixed assignment-kind judgment through the shared gateway; bounded candidates, validated distributions, cache and background jobs | Provisional display threshold; no measured accuracy, calibration, or general tagging/linking/routing engine |
| Privacy | Hosted AI off by default; category/service gates; prepared-context preview; metadata receipts; dated provider settings guidance; revocation cancels work and rejects late responses; local data deletion | Turning off sharing cannot recall data already sent; deletion does not erase provider records or OS backups; provider settings are changed in the provider's app |
| Links and practice state | Stored typed links with user decisions and source-version guards; stored practice attempts | No automatic link producer, tutoring assessment loop, skill map, or readiness estimate |
| Local AI | Desktop setup check and per-item local question form; llmfit hardware recommendations; exact installed Ollama model/quantization checks; cloud-disabled checks; bounded local tutoring request | Requires installed tools and weights; no managed installation or real local-model run yet; automatic fit ranking does not establish best learning quality |
| ChatGPT, Claude, Gemini | Provider preference and context-preview recipient | No provider sign-in, subscription-backed inference, MCP connection, or hosted answers |
| Website | Informational HTML page and GitHub link | No installer download is advertised; no iOS app or relay |

Ben reports having tested the described Canvas pipeline. That is useful project context, but it is distinct from live validation of this newly implemented connector and embedded browser. Our headless check with an authorized existing session reached Canvas, received an authentication failure, and emitted `needs_sign_in` without importing false empty course data or making cloud calls. Successful live ingestion is still unvalidated for this implementation.

## Data behavior that teammates should preserve

Local storage and local inference are separate promises. By default, course data stays in local storage and no context goes to Jev or a hosted LLM. Refreshing Canvas still contacts UW. If Jev is enabled, the current allowlist prepares course name, item title, instruction text, and policy evidence. The gateway operator and TypeSafe can process that selected text. Cookies, credentials, source URLs, account IDs, grades, and drafts are not fields in that request. Source text itself can still contain personal information; allowlisting fields is not anonymization.

Previewing context does not send it. Receipts record recipient, purpose, categories, character count, and status without copying the payload. A `sent` receipt represents a send attempt, not proof the recipient processed it. Changing data settings blocks future requests and prevents obsolete results from updating the workspace.

The SQLite coursework store is not encrypted by the app. File permissions restrict access on supported systems; device/OS security and backups remain separate. The gateway device credential uses OS-backed encryption.

Deleting local data removes saved coursework, history, judgments, links, and student activity. UW browser-session removal is a separate **Clear UW session** action. Neither action changes records held by UW. A read request may still have server-side effects such as access logging; “no submit/enroll/post capability” is the precise current promise.

## How evidence is represented today

The current `CaptureBatch` scopes a source to an account, course, and endpoint. Each resource keeps its source identifier, content hash, version, observation time, and captured payload. Only a successful complete capture establishes that a previously present item disappeared. Failed or partial reads preserve earlier records. A successful capture is a historical observation, not a guarantee that the source has remained current.

Dates arrive as normalized, scoped claims. The resolver never treats a lock time as a due time. Conflicting due claims remain visible; the earliest plausible time is labeled for planning. The future evidence contract adds source locations, authored times, per-field observations, exact prose quote validation, and explicit resolution-rule versions. Those are requirements, not fields silently supplied by the current implementation.

The context compiler currently selects bounded fields from one resource for assignment-kind classification. Local tutoring likewise receives a bounded excerpt from the selected item, its policy, and the student's question, with an exact excerpt preview. This is not yet a task-wide retrieval system with course coverage, conflicting evidence selection, or a general context budget optimizer.

## Verification scope

The current implementation passed `pnpm test` (64 tests) and `pnpm build` on September 26, 2026. These tests use synthetic captures, fake transport responses, and temporary databases. They target material failure cases: wrong scope, partial capture deletion, stale judgment writes, privacy revocation, malformed upstream output, gateway spend limits, and local-runtime cloud fallback. They do not make paid Jev calls.

The hidden Electron smoke check passed through renderer → preload → utility worker → SQLite with a synthetic capture and no visible window. The headless browser check exercised empty entry, explicit sample import, source/deadline evidence, blocked hosted context, local completion, privacy persistence after reload, and local-data deletion using the same core/store with temporary data. An injected connection failure retained coursework and surfaced a sign-in warning on Today. Browser page errors were empty. These runs used synthetic records, not a working school session or a real model.

Live Jev accuracy/latency/billing, real local-model inference, broad non-CS course coverage, Windows operation, signed distribution, and production gateway abuse resistance remain unestablished.

## General rules for the next additions

- Optimize the student's effort across setup, daily use, failure, and recovery. An instant screen that hides incomplete data is not success.
- Keep exact IDs, dates, counts, permissions, and budgets in code. Judgments suggest meaning; they cannot authorize an action.
- Preserve unknown, empty, stale, partial, and inaccessible as different states. Retain usable local evidence through failures.
- Keep first paint independent of a model. Cache accepted judgments, and reject responses for old data or revoked permissions.
- Select dependencies using the current task, license, maintenance, data destinations, and benchmark provenance. An untested new tool remains a candidate.
- Add a source or model behind a narrow interface and test the failure that matters before broadening claims. Keep private captures outside git.

The full [engineering principles](engineering-principles.md) explain the reasons and evidence expected behind these decisions.
