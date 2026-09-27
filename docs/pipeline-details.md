# Pipeline details and evidence gaps

Checked September 26, 2026 against current code and the official sources linked below. This preserves concrete mechanics without turning earlier conversational assumptions into verified behavior. It is a technical reference, not work ownership or a first-demo build plan.

## Sync resilience integration

The integrated sync resilience implementation adds shared module reads, bounded direct page/file revalidation and durable item-access observations. These changes are in main; the [implementation handoff](archive/sync-resilience-review.md#implementation-handoff--september-26-2026) is the canonical interface, budget and verification record.

## Course-file acquisition (September 27)

Built and tested on synthetic data (tests `fix-acq-*`, perf suite `documents`); not yet run against live UW Canvas. The sync resilience discovery above (`canvas-references.ts`: module File items, in-body `/files/:id` links, Files-list rows, due-soon propagation) decides *which* files; this section is *how* they are fetched and kept.

- **Download path.** In the desktop app (`ACQUISITION_APP` in `apps/desktop/src/ingestion.ts`) a file's bytes come from `GET /courses/:cid/files/:id/download?download_frd=1` in the student's Canvas session. Main follows the redirects itself (`canvas-file-download.ts`) to the Canvas origin, the account's files domain (`*.canvas-user-content.com`), inst-fs (`inst-fs-<region>-<env>.inscloudgate.net`) or legacy S3 (`instructure-uploads.s3.amazonaws.com`). The canvas-lms source lines are cited in `network.ts` beside `canvasFileHost`. Only the Canvas hop carries cookies. The earlier cookie-less download of the API's signed URL stopped at inst-fs (`secret_origin_blocked`), which matches all 248 live reads ending incomplete. Downloads share the sync's request scheduler (6 per host), and extraction runs in 2–3 `worker_threads` (`extract-pool.ts`).
- **Causes.** Every failed or partial read records its cause as the diagnostic code: `redirect_blocked`, `secret_origin_blocked`, `http_<status>`, `too_large`, `extract_failed.<pdf|office|text>`, `needs_ocr`, `unsupported_type`, `reference_only`, `locked` or `needs_sign_in`. Any host goes in `path: ["host", <hostname>]`; a URL, query or file name never does. The trial log (`MAGIC_TRIAL_LOG`) gets one `document` event per file with host class, status, cause, bytes and time.
- **Order and budget.** Syllabus files come first, then due-soon files, then the rest. Within each tier, text and Office files go before PDFs, smaller before larger. The first sync of an account gets 400 files / 300 s. Later syncs keep the 100 files / 120 s caps.
- **Cheap skips.** A Files-list row whose `updated_at` and `size` match the stored document needs no metadata request and no download. An unchanged file reuses its stored text. Course-site documents keep their Last-Modified time and are re-asked with If-Modified-Since. The crawler's six-hour reuse window now reads a document's `fetchedAt` (it read only `observedAt`, so course-site PDFs re-downloaded on every crawl). A 4xx `robots.txt` means no rules (RFC 9309 §2.3.1.3).
- **OCR.** A text-less PDF or an image is a complete read with document status `needs_ocr`, so it no longer keeps its source partial. A background job, never awaited by a sync, OCRs up to 30 pages per run with the OS engine: Windows.Media.Ocr (checked unpackaged on Windows 11) or Apple Vision (macOS, not yet run). The configured Tesseract adapter is the fallback. PDF pages render through pdfjs with `@napi-rs/canvas`.

### What is stored and what is only referenced

| Item | Kept on this device | Fetched or opened on demand |
|---|---|---|
| Readable course files (PDF, Office, text) | extracted text, per-page parts and anchors, passages with offsets, metadata, SHA-256 and size | the file itself; raw bytes are deleted once text is extracted (`retainBytes: "ocr-pending"`) |
| Files waiting for OCR (`needs_ocr`) | metadata and hash, plus the bytes until the OCR job has run | text after OCR |
| Video and audio files, Kaltura media | metadata and link (`reference_only`) | playback; captions are later work |
| Files over the size cap (`maxFileBytes`) | metadata and link (`too_large`) | the file |
| External tools (LTI) | metadata and link | the tool |
| Historical-term courses | metadata only, unless the student opens them (policy; this change does not enforce it) | content |

Not built yet: a size-capped LRU of recently opened files for instant re-open (nothing in the app opens a stored file today), moving file work into the job drain, and the `sync.status` query.

## Canvas: the implemented path

The expanded [course-ingestion reference](ingestion-upgrade.md) is authoritative for current endpoints, metadata/download pools, bounds, source scopes, calendar feeds, retries, and material extraction. [Implementation status](implementation-status.md) distinguishes synthetic verification from live use.

The profile validates the account scope. Account to-do, upcoming events, and activity arrive early. Courses include term/teacher/score metadata and are selected in code; assignments are ordered by due date. Modules, announcements, pages, files, and other course scopes follow. Each scope paginates at 100 with bounded requests. Metadata concurrency defaults to eight and downloads to four; those defaults are not a measured UW optimum. Budget headers and bounded 429/rate-limit-403 retries pace requests. Partial or failed scopes retain previous data.

## Session test and reconnect

The app owns its persistent Electron sessions. The student completes NetID/Duo in the embedded browser; a profile response with a numeric ID closes that window. The connector independently validates identity before capture. Canvas and GitLab each have a fixed-origin session boundary. No personal browser cookies are read, copied, or decrypted.

Expiry marks sources as needing sign-in, retains prior evidence, and pauses Canvas reads for three refresh intervals while credential-free calendar feeds continue. The foreground UI offers sign-in; the app does not pop up a login during background work. No idle keepalive or wake request is used. Exact UW expiry and cross-service SSO remain unmeasured.

Reading content can cause access logs, viewed state, or a must-view completion. Ben accepts this incidental source-side behavior; accessible page bodies are read, with referenced pages first. The product disclosure distinguishes it from explicit submit/post/enroll/completion actions, which the app does not expose. Whether each API read produces a view remains unverified; there is no teacher-controlled test course available.

## Announcements and activity are different coverage

The connector reads both `/api/v1/announcements?context_codes[]=course_:id&start_date=...&end_date=...` with `/api/v1/users/self/activity_stream`, following each endpoint's paging. The announcements endpoint requires course contexts and defaults to a recent date range; permissions, publication, and date filters matter. The activity stream contains several item types and truncates announcement/discussion messages at 4 KiB. Neither is automatically a complete replacement for the other. [Announcements](https://developerdocs.instructure.com/services/canvas/resources/announcements), [activity stream](https://developerdocs.instructure.com/services/canvas/resources/users#method.users.activity_stream)

The concern that announcements may omit a post visible in activity is retained as a **reported scenario requiring reproduction**, not an established UW-wide API defect. Compare IDs, course/section/account, time range, pagination, permissions, and publication state on a known missing example. Fetch full content from the canonical resource before deriving requirements from a truncated stream item. Both endpoints are captured independently by the current connector.

## Outlook / Microsoft Graph

Graph `GET /v1.0/me/messages` defaults to 10 messages; `$top` supports 1–1,000. These are **messages per page**, not a guarantee of 1,000 complete headers. Use `$select` for required metadata and follow the complete `@odata.nextLink`; large full-message payloads can time out. A proposed initial metadata request is `$top=100&$select=id,subject,from,receivedDateTime,conversationId,webLink`. This is a test starting point, not a measured optimum. “Headers” in product discussion means metadata here, not all RFC `internetMessageHeaders`. [Graph list messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0)

No Graph connector or UW consent test exists yet. Establish authorization, scope, paging, throttling, and metadata/body minimization before relying on mail. Do not send private mail to a hosted extractor to bypass an access problem.

## Name scrubbing and exact citations

**Decided policy, not implemented:** before hosted processing, minimize fields and remove student names, NetIDs, email addresses, and unnecessary personal identifiers. Retain instructor and author names when they help interpret the course material; this does not permit retaining student identities from drafts or private messages. Keep the exact outgoing payload inspectable and use the accepted provider-consent/context-receipt flow, with a blocking preview for new sensitive sharing or always-preview; see [AI privacy](ai-and-privacy.md#accepted-disclosure-flow--implementation-pending). Replace identity consistently with local opaque references when relationships matter, keeping the replacement map local. Name scrubbing is not guaranteed anonymization: distinctive prose and course combinations can still identify people.

The current compiler only allowlists bounded course/title/text/policy fields. It excludes credentials and identity fields but does **not** detect names inside free text. Do not describe current cloud requests as scrubbed. Local-only mode blocks hosted context; see [AI and privacy](ai-and-privacy.md).

**Direction, not implemented:** a generated claim must reference a captured source/version and a literal span. Code exact-matches the quote or validates stored offsets against that version before displaying it as a supported fact. Keep original text, normalized extraction, and any redacted model input mapped locally; a quote from redacted text must resolve back to the correct original span. Never use fuzzy quote repair to silently bless a citation.

Presence is only the first gate: validate course, term, section/student applicability, negation, policy exceptions, and whether the evidence supports the claim. Failed checks should remove or visibly qualify that claim and preserve access to evidence. The existing structured deadline resolver does not supply this prose-answer validation. [TypeSafe citation-check pattern](https://docs.typesafe.ai/cookbooks/citation_check.md)

## Link thresholds: a testable starting method

The useful older analogy is record linkage's three-way decision: link, do not link, or defer for review. Fellegi and Sunter formalized thresholds around error constraints and review burden. We borrow that separation; we do **not** treat Jev's distribution as their likelihood ratio or inherit their statistical guarantees. [Original 1969 paper](https://nhis.ipums.org/nhis/resources/Fellegi69.pdf)

1. **Scope before scoring.** Block wrong account/course/term candidates in code. Same short title is insufficient. Keep `same_as` stricter than `supports` or `mentions`; a related document is not necessarily the same assignment. An identity link must remain reversible and preserve both captures.
2. **Start conservatively.** Until evaluation supports fuzzy automation, auto-apply only independently checked exact identity rules. Route useful ambiguous candidates to a small confirmation chip with reason and evidence. Low matches get no automatic link or nag; retain source records and distinguish weak evidence from proven non-match.
3. **Build the right labels.** Hand-label positive, negative, and genuinely uncertain pairs, including same-title different assignments, stale terms, linked specs, duplicate notifications, and several valid supports. Split evaluation by course/assignment family so near-duplicates cannot leak between tuning and testing. Include non-CS formats. Audit candidate generation separately: a scorer cannot choose a missing correct candidate.
4. **Sweep cut points, do not decree them.** Example experiment only: sweep upper scores `.90`, `.95`, `.98`, `.995` and lower review cut points `.50`, `.70`, `.85`, plus observed score quantiles. Track top score, runner-up margin, answer-exists result, and permutation stability where applicable. These are provisional search values, not recommended production thresholds. For multiple valid links use per-candidate judgments. Never multiply correlated model scores.
5. **Select against the real cost.** For each link type, report false automatic links, automatic coverage, missed true links, and review burden. Choose the greatest useful coverage consistent with a separately agreed error tolerance on held-out data. If none passes, keep fuzzy links in review. The current `.9` assignment-kind display threshold is unrelated and must not become the link threshold by convenience.
6. **State sample limits.** With zero errors in 300 independent representative auto-links, the one-sided 95% binomial upper error bound is `1 - 0.05^(1/300)`, about 0.994%; that does not establish 99.9% precision. Course clustering and distribution shift weaken the independence/representativeness assumptions. Report counts and coverage instead of an unsupported “near-perfect” claim.
7. **Learn from corrections carefully.** Preserve confirmed/undone decisions, the reason if voluntarily supplied, evidence hash, question/model/rule version, and time. Silence is not approval; undo may reflect relevance or preference rather than false identity. Review those cases, sample auto-links and suppressed candidates too, retune offline, then check a fresh holdout. Do not silently lower thresholds because users accepted a selected subset of chips.

Acceptance checks: wrong-course P1 never merges; no-match can abstain; multiple supporting documents survive; rejected links are not silently restored; changed evidence invalidates obsolete judgments; uncertain links remain inspectable. The ingestion coordinator implements exact same-course URL/ID links and user overrides. Fuzzy candidate generation, scoring, and threshold tuning remain unimplemented.

## Historical Canvas and academic reconciliation

Canvas discovery now enumerates active and completed enrollments separately, requesting available and completed course workflow states for the historical query. Active coursework does not wait for historical discovery. Historical courses receive metadata and the student's own current/final grade claims without automatically crawling old materials. Restricted entries remain restricted, and failed discovery preserves prior records. This is accessible Canvas coverage, not all university course history.

[Planning integration](planning-upgrade.md) owns the separate UW enrollment/history/DARS pipeline and exact reconciliation rules. Native identity binding, source-specific terms, credit basis, and independent current/final grade claims prevent convenient but unsupported merges. No transcript authority or mastery is inferred from Canvas.

## Course intelligence after capture

`store.ingest` rebuilds the affected account/course profile only when resource dependencies or compiler version change. Schema 5 retains each profile revision. Identical successful reads update source freshness without manufacturing a new content version; failed reads retain claims with degraded coverage. Local semantic candidates are committed only for the current input fingerprint, with exact source-version spans checked again by code. Their model/version provenance is retained and repeated identical results are idempotent. The desktop worker queues this optional local work without blocking the snapshot, retries an unavailable runtime after five minutes, and never installs a model or falls back to cloud processing.

Policy scope is conservative: captured Canvas/fixture syllabus and course assertions apply to the course, assignment assertions to that assignment. A web page, GitLab file, or message cannot become authoritative policy just by containing the same words. Narrow whole-resource prohibitions can be recognized automatically; conditional, illustrative, permissive, or broader prose remains unresolved and receives coaching. A quote's existence establishes provenance, not correct interpretation. [Course intelligence](course-intelligence.md) describes the public types, availability states and tested limits. Hosted policy context still passes the contributing resources' category permissions. Packs, study guides and tutoring now read the same effective policy: a profile restriction blocks generation even when the resource's own policy is unknown. Jev's assignment-kind payload is the title, at most 2,000 characters of the item's own text, and its own stated policy clipped to 500 characters (empty when it states none); quiz and discussion kinds come from Canvas `submissionTypes` in code and never reach Jev. Kind judgments are keyed on the title-and-text hash, so a grade or submission change reuses them.

### Integrated identity and deadline evidence (September 26)

Hosted core context and MCP text use the local manual roster plus Canvas profile and non-teacher author identities captured during normal reads. Automatic identities are scoped by account and course; instructors/authors remain when relevant. Pattern removal covers emails, labelled NetIDs, known IDs and phones. This reduces known identifiers; it is not anonymization or a guarantee of detecting every name. Local content remains original. These helpers do not automatically protect an independent model adapter: each adapter must project its actual full outgoing request before permission, preview, hashing and send.

Necessary profile names/emails are retained only in the private local identity-roster preference, not copied into coursework records, captures or snapshots. This deliberate retention enables scrubbing; it is not a promise of zero personal data on the device. Synthetic ingestion checks inspect decoded historical records as well as current rows and verify Delete local data removes the roster and its persisted bytes. Credentials and capability secrets remain prohibited in these records, including the roster.

MCP derives deadline evidence only from resources permitted by the current account/course/category grant, including calendar links and announcements. Contributing resource IDs/categories enter receipts. Names in labels and nested deadline quotations are scrubbed too. Part offsets explicitly describe original source coordinates; main excerpts describe outgoing coordinates.

Outgoing citations require the projection ID issued with the exact excerpt/context. The local frozen map survives roster changes and validates source hash, literal quote, offsets and the sent range; it never regenerates a map from today's roster. Maps are bounded to 1,000 entries, memory-only and expire on restart/purge/eviction. Reopen context after expiry. Root context and MCP excerpts supply projection IDs; supporting-context citation UI and semantic entailment are not implemented. A `supported` literal-span result establishes occurrence, not truth of a generated claim.

Deadline prose is deterministic, from the assignment and same-account/course announcements, syllabus and pages naming its exact title or unique assignment identifier. Ambiguous dates remain unresolved; code handles Chicago time and source/term anchors. Canonical queries, snapshots and MCP use the same resolver. Conservative integration rule: an explicit prose extension can supersede lower prose tiers, but disagreement with structured Canvas remains a conflict, no asserted due date, and earliest plausible planning date. This does not implement an unconditional instructor-overrides-Canvas rule.

### Study generation at the actual send boundary

The current quiz/card pack handler uses the existing runner's synchronous `beforeCall` hook after it constructs headers and retry feedback. Hosted system prompt/input are scrubbed there; the exact outgoing system prompt, input and JSON schema form the consent preview hash. Every attempt rechecks permission, including retries and escalation. Adapter-added static protocol instructions are outside this preview; other runner consumers must explicitly adopt the hook. Fully local generation keeps original material.

Permissions include all scoped material contributors, including labels and policy text. A frozen map for each sent passage restores literal citations to original source text; ambiguous matches and partial placeholders are rejected. Evidence, roster, route and privacy state affect cache identity. Revalidation after provider awaits prevents storing newly returned results after source changes, revocation, exclusion or purge. Existing cache entries become ineligible under changed fingerprints; this patch does not physically erase each superseded entry. Delete local data removes the production store. Already dispatched provider requests cannot be recalled. These boundaries have synthetic real-runner tests; no live provider or learning-quality claim follows from them.

### Jev batching (proposed, not built)

Status: proposed. Nothing below is implemented; it depends on an unverified capability.

The gateway answers one assignment per request and budgets requests per device and globally, so a course's ambiguous assignments queue behind the hourly limit. Batching would send one request for several assignments and charge the budget per item, not per request.

- **Blocker:** TypeSafe's API must accept several named states in one call (or several questions over one state that is a list). Its documentation has not been checked for this; until it is, the route stays single-item.
- **Route:** `POST /v1/judgments/assignment.kind.v1/batch` with `{ states: [...] }`, at most N items (N set from the upstream's accepted size, not guessed). An oversized batch is refused, never truncated.
- **Budget:** reserve one unit per item atomically before the upstream call; refund the units of items the upstream did not answer, and all of them on an upstream 429 (as the single route now does).
- **Client:** the drain leases up to N ready `enrich.resource` jobs of one course, builds each payload with `context(id, "jev")` (each item keeps its own receipt and permission check), and writes one judgment per item keyed on its text hash. A partial answer finishes the answered items and returns the rest to the queue.
- **Checks:** per-item validation stays as today (kind enum, probabilities, question version); one malformed item fails only itself.
