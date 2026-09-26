# Implementation status

Updated September 26, 2026. This describes the code and observed checks, not completion of the broader [product](product.md). The detailed [ingestion handoff](ingestion-upgrade.md) covers scopes, bounds, evidence, and primary references.

## What exists

| Area                        | Implemented behavior                                                                                                                                                                      | Current limit                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Desktop                     | Isolated Electron renderer, preload, native session broker, utility worker, local SQLite; Today, evidence, Sources, Data & AI                                                             | Development build; no signed Mac or Windows installer                                                                              |
| UW access                   | App-owned sign-in window; student completes NetID/Duo; strict Canvas GET boundary; separate GitLab session                                                                                | No personal browser-cookie import. Embedded sign-in, SSO between services, and session lifetimes need live validation              |
| Canvas                      | Account activity first; academic-course selection; assignments/submissions, details/syllabus, modules/items, pages and bodies, files/folders, groups, quizzes, discussions, announcements | Bounds can produce partial coverage. Page reads may register views or satisfy must-view requirements; accepted and disclosed       |
| Refresh                     | Open-app background scheduler, quiet hours, jitter, activity-summary shortcut, expiry backoff, independent feeds, suspend/resume                                                          | No waking sleeping devices or keeping sessions alive. Actual UW timing/rate costs remain unmeasured                                |
| Materials                   | Folder-scoped public crawling, redirects/robots/DNS checks, embedded JSON, local document downloads and extraction, exact supporting links                                                | No JavaScript rendering fallback; unknown file hosts remain partial; fuzzy association is not implemented                          |
| Documents                   | PDF text/page anchors; local Office/HTML/text extraction; unchanged-file reuse; bounded local OCR adapter                                                                                 | OCR needs explicitly configured local tools and trained data; not bundled or demonstrated on a real scan                           |
| Calendar and GitLab         | Encrypted feed capabilities; independent event/date evidence; linked UW GitLab project and work evidence                                                                                  | Recurrence expansion, manual repository selection, and real UW feed/GitLab validation remain open; commits do not prove submission |
| Storage                     | Versioned captures, field observations, FTS, source baselines/drift signals, typed changes, deletion markers, durable jobs and judgments                                                  | Heuristic drift detection has not been tuned on representative real course loads                                                   |
| MCP                         | Six local stdio tools; per-client course/category grants, credential export, live revocation/privacy checks, receipts                                                                     | Requires a compatible local MCP client. This does not establish support for every ChatGPT/Claude/Gemini account or subscription    |
| Jev                         | Shared server-side key; bounded assignment-kind judgment, gateway limits, caching and background jobs                                                                                     | No measured accuracy, latency, cost, or broader semantic tagging/linking engine; gateway deployment still separate                 |
| Local AI                    | Installed Ollama/llmfit checks, automatic fit ranking, bounded local tutoring, exact context preview                                                                                      | No managed model installation or real inference demonstration; hardware fit is not measured teaching quality                       |
| Learning and other surfaces | Stored attempts and typed links; informational website with GitHub link                                                                                                                   | No readiness model, full tailoring loop, iOS relay, or advertised installer                                                        |

## Data and access promises

Hosted sharing is off by default, including Jev. Grader feedback is collected locally by default; grades and comments require separate sharing permission. MCP also requires an explicit recipient, courses, and categories. GitLab content is conservatively classified as student work. Messages require communications permission. Rechecks apply on every MCP read.

The current Jev payload remains course name, title, bounded instruction text, and policy evidence for one assignment. It excludes structured credentials, account identifiers, grades, comments, and drafts. Local tutoring and selected-provider previews can include directly linked supporting material. Field allowlists and capability-URL removal do not anonymize free text; the planned identity scrubber is still missing. Relevant instructor/author names should survive that future scrubber, while unnecessary student identifiers should not.

The coursework database and downloaded files are local and permission restricted, but not app encrypted. Source capabilities use OS-backed encryption. MCP connection credentials live in private local files; the database stores their hashes. Exported configuration is meant to remain local.

Deleting local data removes coursework/history, cached documents, feed secrets, app-owned UW sessions, and MCP access files. Clearing only the UW session retains coursework. Neither action removes UW records, provider-retained data, or OS backups. Reading may cause access logs, viewed status, or must-view completion on the source system. The app provides no submit, post, enroll, or explicit completion command to UW.

## Evidence and context

Only a complete successful scope can establish removal. Malformed records are isolated; restricted, unpublished, stale, empty, partial, and unavailable states remain distinct. Excluded courses remain visible with reasons and cannot enter enrichment or MCP output. An inaccessible course cannot be reopened by a local inclusion override.

Exact URLs within one account/course connect supporting material; exact calendar assignment IDs connect independent date claims. Source changes invalidate stale links. User rejection persists. Fuzzy matching and general assignment-to-module inference remain future work: an empty assignment with no explicit relation is not silently linked to arbitrary course content.

The deadline resolver separates due, lock, and event claims, preserves conflicts, and labels conservative planning dates. Prose extraction, literal-span validation, title-date inference, and the full authority hierarchy are not implemented. MCP answers are source passages with citations; they make no language-model call or claim to solve the question.

## Verification

The upgrade passed **119 automated tests** and the TypeScript/desktop build on September 26. Tests use synthetic transports and temporary databases, with no paid model calls. They include:

- Synthetic university: five academic courses, five noncourse sites, a restricted course, 205 paginated assignments, linked instructions, changed/graded/removed/restored items, rate limits, and mid-sync expiry.
- Real ingestion coordinator → SQLite → core context: course exclusion, exact support links, independent conflicting calendar dates, stale-data preservation, continued feeds after expiry, and no capabilities in snapshots or SQLite/WAL.
- Actual generated PDF/Office extraction, bounded downloads, redirect/SSRF/robots checks, cache reuse, and capability removal in captured HTML/JSON/GitLab material. OCR selection uses a fake adapter, not a real scan.
- MCP service and SDK stdio integration: category/course/privacy gates, invalid tokens, revocation, removed events, late-document passages, source coverage, and restrictive access-file permissions.
- Hidden Electron: renderer → preload → utility worker → SQLite, private MCP configuration export, and local-data purge. Headless browser checks cover empty entry, synthetic import, refresh settings, local feedback versus cloud defaults, and creating/revoking an MCP connection.

Scope/request timing and remaining-rate headers are recorded. `firstValueMs` measures arrival of the first assignment/event during a run. `nextWeekInstructionsMs`, when present, measures when all captured assignments due within seven days have text or exact supporting text; it is not proof of complete course coverage. Neither establishes live speed. Missing timings are not zero.

An earlier authorized private pull verified the previous thin connector against live Canvas and persisted its results; no private content is committed. That adapter is retired under the newer no-personal-cookie-access requirement. The expanded app-owned path has not yet been demonstrated on a live UW account. No teacher-controlled course is available to isolate view-tracking effects; that incidental effect is accepted rather than used as a blocker.

Windows behavior, signed distribution, production gateway deployment, provider-account compatibility, non-CS coverage, real OCR, and live model quality/cost remain unverified.

## Preserve these principles

- Reduce setup and recovery effort while keeping coverage/freshness visible.
- Keep exact facts, permissions, budgets, and change detection in code.
- Render saved evidence immediately; never wait on a model for ingestion or first paint.
- Treat source content as evidence, never authorization to execute an action.
- Record what the check actually established; synthetic success cannot become a live claim.

See [engineering principles](engineering-principles.md) for the wider selection and reference method.
