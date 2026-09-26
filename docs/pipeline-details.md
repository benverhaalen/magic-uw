# Pipeline details and evidence gaps

Checked September 26, 2026 against current code and the official sources linked below. This preserves concrete mechanics without turning earlier conversational assumptions into verified behavior. It is a technical reference, not work ownership or a first-demo build plan.

## Canvas: the implemented path

See [connector](../packages/connectors/src/canvas.ts) and [desktop session broker](../apps/desktop/src/main.ts).

| Order | Current GET request | What we rely on |
| --- | --- | --- |
| 1 | `/api/v1/users/self/profile` | Validate a positive account ID and derive an account scope before trusting captures. Profile names are not copied into course records. |
| 2 | `/api/v1/courses?enrollment_state=active&per_page=100&include[]=syllabus_body` | Enumerate active course objects and included syllabus HTML. Missing syllabus differs from explicit empty content. |
| 3 | `/api/v1/courses/:course_id/assignments?per_page=100&include[]=submission` | Capture structured due/lock fields, points, descriptions, and available submission evidence within each course. |

There is **one connector request in flight**, including pagination and courses. A full pull makes one profile request, the returned course-list pages, and each course's returned assignment pages; the count depends on pagination. Included syllabus text avoids another request per course. First-screen planner/to-do/activity prioritization is still planned, not this implementation's entry path.

Canvas's documented default is 10 items per page. `per_page=100` requests a page size; it does not prove the returned size or completion. The connector follows `Link: rel=next`, with same-origin and endpoint checks, loop detection, a 20-page/2,000-record cap per enumeration, 8 MiB response limit, and 15-second request deadline. Cap/schema failures produce partial results. Only a successful complete scope can establish deletion. [Canvas pagination](https://developerdocs.instructure.com/services/canvas/basics/file.pagination)

Canvas documents cost-based throttling, `X-Request-Cost`, an applicable `X-Rate-Limit-Remaining`, and 429 responses; parallel calls can incur a preflight penalty. **Current limitation:** our connector does not adapt to those headers or automatically back off/retry 429. It preserves old records and reports failure/partial capture. Proposed addition: a per-session queue, bounded jittered retries honoring `Retry-After` when present, and recorded throttling observations. Keep concurrency at one until measurements justify a small increase; there is no established faster UW-safe number. [Canvas throttling](https://developerdocs.instructure.com/services/canvas/basics/file.throttling)

## Session test and reconnect

The app owns a persistent Electron browser partition. A student opens a small sign-in window and completes NetID/Duo. After navigation returns to Canvas, a profile request with a 10-second deadline checks for an OK JSON response and closes the window. **That window check does not validate the profile body.** The ensuing connector pull independently schema-validates the profile ID before ingesting courses. Strengthening the window check remains an improvement, not current behavior.

Connector 401/403, redirects, or HTML where JSON is expected become `needs_sign_in`; malformed JSON/schema becomes partial; other errors preserve earlier evidence. A 403 can mean denied permission as well as expired authentication, so finer diagnosis remains necessary. A scoped login check proves neither SSO access to other UW systems nor future session lifetime.

Current UI keeps an existing sign-in window single-instance, shows source health and a Today warning, and lets the student reconnect. **Direction:** deduplicate failures into one reconnect prompt per session, pause affected source reads, preserve prior data and freshness, and resume authorized reads after the student completes sign-in. Never automate Duo or keep a session alive with idle pings. Multi-source prompt deduplication and timed-expiry recovery still need implementation and live validation.

The authorized headless check of a persisted Firefox session snapshot needed sign-in. That is not proof that the active browser's in-memory session was invalid, and no live capture succeeded in that check. Agent verification stays headless.

## Announcements and activity are different coverage

Future reads should compare `/api/v1/announcements?context_codes[]=course_:id&start_date=...&end_date=...` with `/api/v1/users/self/activity_stream`, following each endpoint's paging. The announcements endpoint requires course contexts and defaults to a recent date range; permissions, publication, and date filters matter. The activity stream contains several item types and truncates announcement/discussion messages at 4 KiB. Neither is automatically a complete replacement for the other. [Announcements](https://developerdocs.instructure.com/services/canvas/resources/announcements), [activity stream](https://developerdocs.instructure.com/services/canvas/resources/users#method.users.activity_stream)

The concern that announcements may omit a post visible in activity is retained as a **reported scenario requiring reproduction**, not an established UW-wide API defect. Compare IDs, course/section/account, time range, pagination, permissions, and publication state on a known missing example. Fetch full content from the canonical resource before deriving requirements from a truncated stream item. Neither endpoint is used by the current connector.

## Outlook / Microsoft Graph

Graph `GET /v1.0/me/messages` defaults to 10 messages; `$top` supports 1–1,000. These are **messages per page**, not a guarantee of 1,000 complete headers. Use `$select` for required metadata and follow the complete `@odata.nextLink`; large full-message payloads can time out. A proposed initial metadata request is `$top=100&$select=id,subject,from,receivedDateTime,conversationId,webLink`. This is a test starting point, not a measured optimum. “Headers” in product discussion means metadata here, not all RFC `internetMessageHeaders`. [Graph list messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0)

No Graph connector or UW consent test exists yet. Establish authorization, scope, paging, throttling, and metadata/body minimization before relying on mail. Do not send private mail to a hosted extractor to bypass an access problem.

## Name scrubbing and exact citations

**Decided policy, not implemented:** before hosted processing, minimize fields and remove student names, NetIDs, email addresses, and unnecessary personal identifiers. Retain instructor and author names when they help interpret the course material; this does not permit retaining student identities from drafts or private messages. Preview the exact outgoing payload. Replace identity consistently with local opaque references when relationships matter, keeping the replacement map local. Name scrubbing is not guaranteed anonymization: distinctive prose and course combinations can still identify people.

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

Acceptance checks: wrong-course P1 never merges; no-match can abstain; multiple supporting documents survive; rejected links are not silently restored; changed evidence invalidates obsolete judgments; uncertain links remain inspectable. The store supports link records and user overrides, but candidate generation, scoring, threshold tuning, and these end-to-end behaviors are not yet a completed linker.
