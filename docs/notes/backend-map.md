# Backend map: what the current code gives learning features, and what they still need

A map of `main` for anyone building features on top of it. It is refreshed when `packages/**` or `apps/**` change.
**Status: Proposal.** Nothing below is agreed with the team until it's proposed in `packages/contracts` (the team's stated rule in `docs/development.md`).

**Last mapped:** 2026-09-26 against `9a83655` (branch `feat/course-backend`; code == `origin/main` `9302865`, this branch is docs-only on top). Since the last map (`7962d4e`): `ce999ec`/`42aaf8b`/`d58e4a5`/`9302865` add My UW, DARS, Course Search & Enroll planning, schema v4, `signInUW`, historical Canvas — 31 files, +4,286/−81. Previous: `7962d4e` (which itself mapped `27782e9`, 57 files, +12,959/−861 since `73ff7a6`). **Validated against the code on 2026-09-26:** confirmed 46, wrong 1, stale-ref 15, unverifiable 5, not-found 4.
Legend: **code** = read in the source at `9a83655`, validated against the code on 2026-09-26 (confirmed 46, wrong 1, stale-ref 15, unverifiable 5, not-found 4); **test** = `pnpm test` run on Windows at this commit: 254/255 (the one failure is the known Windows file-mode case in `tests/storage.test.ts:129`, 438 vs 384 — unrelated to planning); **doc** = a claim in the repo's docs, not checked. Paths are relative to the repo root. Short refs: `contracts:N` = `packages/contracts/src/index.ts:N`; `storage`, `domain` likewise; `core:N` = `packages/core/src/index.ts`; `core/mcp`, `core/access`, `core/evidence`, `core/refresh`, `core/planning` = the sibling files; `documents`, `external`, `network`, `gitlab`, `calendar`, `canvas`, `canvas-http`, `canvas-models`, `planning-public`, `uw-planning-*` = `packages/connectors/src/<name>.ts`; `ingestion`, `worker`, `main`, `mcp-server`, `secrets` = `apps/desktop/src/<name>.ts`.

## What changed since 7962d4e, in one screen (code)
- **A whole planning subsystem lands, isolated from the coursework Store:** `@magic/contracts/planning.ts` (13 record kinds: term, subject, crosslist, course_history, audit, catalog_course, enrollment_package, hold, appointment, advisor, student_summary, grade_distribution, account_link), a second storage repository (`planning_sources`, `planning_captures`, `planning_records`, `planning_versions` — schema v4, `packages/storage/src/planning.ts`), five new connectors (`uw-planning-{http,catalog,enrollment,history,profile,sync,audit}.ts`, `planning-public.ts`), and a comparison engine (`packages/core/src/planning.ts`, `comparePlanning`).
- **Sign-in gains two new UW services:** `signInUW("enroll" | "myuw")` alongside `"canvas" | "gitlab"`, each its own login origin in the same `persist:uw` partition; unlike Canvas/GitLab sign-in, a My UW/enroll sign-in does **not** verify a profile response before closing (main.ts: `if (planning) return;` skips the check) — the student closes the window themselves.
- **Three new privacy categories:** `sharePlanning`, `shareHolds`, `shareAudit` (contracts, domain `maySend`), all default `false`. Planning records never pass through `core.context`, `core/access.ts` `contentCategories`, or `core/mcp.ts` — grep confirms none of those files import `@magic/contracts`'s planning types. **Planning is unreachable from Jev, the local-AI context builder, or the MCP server.**
- **Five new `Command` variants:** `planning-guide`, `planning-search`, `planning-sections`, `planning-compare`, `planning-import` (core:264-309), still without an exhaustive switch.
- **`AppBridge` gains `syncPlanning()`.**
- **Canvas grade evidence:** `courseMetadataSchema.gradeEvidence[]` (LMS-calculated current/final grade and score) — explicitly "never official transcript grades" per its own comment.

## What changed since 73ff7a6, in one screen (code) (history, at 73ff7a6)
- **Canvas reads almost the whole course now:** modules and their items, pages with bodies, files (downloaded and extracted locally), folders, quizzes, discussions, announcements, assignment groups, submissions with grader comments, plus the account's to-do, upcoming events and activity stream. Calendar feeds, public course websites and UW GitLab are new connectors.
- **Local document extraction exists:** PDF by page (PDF.js), PPTX/ODP by slide, DOCX/XLSX/ODT/ODS/HTML/text/notebooks by section. Results land in `Resource.text` + `Resource.parts` + `Resource.document.pages`.
- **A read-only MCP server exists:** six tools over stdio, per-client grants (recipient, courses, categories), a hashed token, live revocation and one egress receipt per call.
- **Storage is at schema v3** (field observations, change events, drift baselines, course overrides, sync runs, MCP grants). Ingest now isolates malformed records and merges omitted fields with the previous observation.
- **Background refresh** runs in the worker every 10 min by default (jitter, quiet hours, activity-summary shortcut, sign-in backoff).
- **Privacy gains three categories** (`grades`, `comments`, `communications`); `maySend` now refuses any category it doesn't know.
- **Unchanged:** `packages/ai` (local Ollama + Jev client), `apps/gateway`, `Link.type`, `Attempt`, the job queue, `core.context` purpose "Classify assignment kind".

## What exists (read from the code)
| Package / app | State at 7962d4e (code) | What a feature can use today |
|---|---|---|
| `@magic/contracts` (new: `planning.ts`) | 13 `PlanningRecord` kinds (discriminated union, contracts/planning.ts:73-241): `term, subject, crosslist, course_history, audit, catalog_course, enrollment_package, hold, appointment, advisor, student_summary, grade_distribution, account_link`. Each carries `provenance{sourceUrl, observedAt, scope}`. `planningCaptureSchema` (source: `uw_public\|uw_enroll\|uw_myuw\|uw_dars\|madgrades\|normalized_import`; status/completeness; `.strict()`). `Prerequisite` is a bounded recursive tree (depth ≤16, ≤500 nodes). `Store` gains `ingestPlanning`, `planningRecords`, `planningSources`; `Snapshot.planning?` (`PlanningSnapshot`); five `Command` variants (`planning-guide/search/sections/compare/import`); `PrivacyPreferences` gains `sharePlanning/shareHolds/shareAudit` (default false); `AppBridge.signInUW` accepts `"enroll"\|"myuw"`; `AppBridge.syncPlanning?()` | `store.ingestPlanning/planningRecords/planningSources`; `comparePlanning` (core/planning.ts) |
| `@magic/contracts` | zod 4. `resourceInputSchema` (264-372, still `.strict()`) gains optional `rawHtml`, `contentType`, `links` (URLs or `{url,text,rel}`), `parts`, `createdAt/updatedAt/unlockAt/dueAt/lockAt`, `workflowState`, `submissionTypes`, `assignmentGroupId`, `rubric`, `submission`, `course`, `moduleItem`, `module`, `assignmentGroup`, `file`, `calendar`, `crawl`, `gitlab`, `provenance`, `document`. `url` is now `evidenceUrlSchema` (22-49: http(s) only, rejects credential-like query keys). `captureBatchSchema` (384-403): source kinds + `calendar`, `gitlab`; statuses + `inaccessible`, `not_published`, `needs_attention`; optional `readId`, `diagnostics`, `stats`, `progress`. New: `captureEnvelopeSchema` (416), `Resource.fieldLastSeen` (419), `ingestionSettingsSchema` (552-558), `courseOverrideSchema` (578), `mcpCategorySchema` (582), `mcpGrantSchema` (590), `syncRunSchema` (607), `ResourceChange`/`ChangeType`/`ChangeFilter` (611-640), `ScopeBaseline` (641), `AppBridge.exportMcp` (848) | Everything below is typed here |
| `@magic/storage` | `createStore(path)` (storage:94) on `node:sqlite` `DatabaseSync`, WAL, `busy_timeout 5000`, `secure_delete`, mode 0600. **`SCHEMA_VERSION = 4`** (storage:31); v4 adds `planning_sources`, `planning_captures`, `planning_records`, `planning_versions` (`planning.ts` `planningMigration`) — a fully separate table set from the coursework Store, purged in the same `purge()` call. Content hash = sha256 of a **canonical** (sorted-key, undefined-dropped) `ResourceInput` (41-53) | Every `Store` method (table below); `store.ingestPlanning(batch)`, `store.planningRecords()`, `store.planningSources()` |
| `@magic/core` | `createCore` (core:29). `snapshot()` (37-81) now also returns `ingestionSettings`, `courseOverrides`, `changes` (last 100), `syncRuns`, `mcpGrants` (token hash stripped). `context()` (93-127) adds **supporting material** reached through accepted `specifies` links (depth 2) for every recipient except Jev, gated by course inclusion and per-category `maySend`; text ≤12,000, purpose still "Classify assignment kind". New modules: `access.ts` (course inclusion at use time, content categories), `evidence.ts` (exact-URL links, deadline merge), `refresh.ts` (scheduler), `mcp.ts` (MCP tools). **`index.ts` doesn't export them**; the desktop imports them by relative path | `courseInclusion(store)` core/access:7, `contentCategories(r)` core/access:56, `evidenceFor(store).supporting/deadlines` core/evidence:84, `createMcpService` core/mcp:46 |
| `@magic/domain` | `resolveDeadline` unchanged. `maySend` (domain:34) refuses unknown categories (40-54) and gates `grades`/`comments`/`communications` on `shareGrades`/`shareComments`/`shareCommunications` (67-72) | `local` is still always allowed |
| `@magic/ai` | **Unchanged** since 73ff7a6 (Jev `assignment.kind.v1` client; local Ollama `generate()` with the fixed coaching prompt). Grep of `packages/ai`, `core/index.ts` context builder and `core/mcp.ts` shows **no planning import anywhere in the AI or MCP path** | As before; planning stays out of AI/MCP entirely |
| `@magic/connectors` | `canvasConnector` rewritten (canvas:178, plus `canvas-http`, `canvas-models`, `canvas-content`, `canvas-selection`, `canvas-fixture`); new `externalCourseConnector` (external:357), `calendarConnector` (calendar:163), `gitlabConnector` (gitlab:291), `createPublicClient` (network:171), `createDocumentManager` + `createLocalDocumentExtractor` + `createLocalOcrAdapter` (documents:433, 176, 358). Dependencies: `pdfjs-dist` 6.3.289, `fflate` 0.8.3, `htmlparser2` 12.0.0, `node-ical` 0.27.2 | Connectors below |
| `apps/desktop` | Canvas and GitLab reads moved **into the worker** (`ingestion.ts`), which asks main for each authenticated fetch (`source-fetch`, main:204) so only main touches the app-owned sessions. IPC channels: `execute, open, import, signin, sync, signout, local-status, local-ask, local-cancel, mcp-export`. New `mcp-server.ts` built to `mcp-server.cjs` (scripts/build.ts) | The worker is still the only in-app path to the Store; the MCP process is a second one (below) |
| `apps/gateway` | **Unchanged** | One Jev question |

### New resource fields that matter for learning features (code, contracts:264-372)
| Field | Shape | Who fills it (code) |
|---|---|---|
| `parts` (280-294) | `{text ≤200k, page?, slide?, section?, start?, end?}[] ≤5000` | The document extractor: PDF `{page, text}`, PPTX/ODP `{slide, text}`, DOCX one `{section:"Document text (pagination depends on layout)"}`, XLSX `{section:"Worksheet N"}`, HTML/text one section. **No producer sets `start`/`end`** (grep of `packages/connectors` and `apps/desktop`). `text` is the parts joined with `"\n\n"` (documents:252, 306), so offsets are derivable but not stored |
| `document` (340-366) | `{fileId?, localPath?, sha256?, sizeBytes?, updatedAt?, extractionStatus?: ok\|partial\|unsupported\|error\|needs_ocr, pages: {page, text, anchor:"#page=N"}[]}` | PDF pages only get `pages`; other formats get `parts` only |
| `file` (186-207) | Canvas file metadata: `id, folderId, displayName, contentType, size, updatedAt, locked, hidden` (+ `localPath`, `sha256`, `extractionStatus` in the schema) | `fileResource` (canvas-models:468) |
| `module` (307-317) | `{id, position, state, prerequisiteModuleIds, unlockAt, itemsCount}` on the module's own resource | `moduleResource` (canvas-models:378) |
| `moduleItem` (157-185) | `{type, title, position, externalUrl, pageUrl, contentId, dueAt, points, completionRequirement, lockInfo}` | `itemResource` (canvas-models:398). The item's module is only in its **source scope** `module-items:<moduleId>` (canvas:877), not a field |
| `course` (142-156) | `{courseCode, termId, termName, workflowState, accessRestricted, accessState, startAt, endAt, selection{score, included, reasons}}` | Only on the `kind:"course"` resource; other resources join by `courseId` |
| `submission`, `rubric`, `assignmentGroup` | Submission state, score/grade, late/missing/excused, grader comments; rubric criteria and ratings; group weight and drop rules | Canvas assignments/submissions/groups |
| `calendar` (209-220) | `{uid, start, end, allDay, timezone, lastModified, assignmentExternalId, recurrenceId}` on `kind:"event"` | Calendar feed (calendar:118) |
| `crawl`, `provenance` | `{discoveredFrom, depth, contentType, contentHash, observedAt, fetchedAt}` | External crawler |
| `gitlab` (231-253) | `{projectId, defaultBranch, commitSha, blobSha, state, path, submissionEvidence, evidenceKind}` | GitLab connector |
| `contentType` | Free string (HTTP content type) | Crawler and documents |
| `policy` | **Unchanged**: no connector sets it; the schema default `{mode:"unknown", evidence:""}` (370) applies to every resource | Nobody |

Not present: `role`, `term` on each resource, `format` enum, `assessment` type (quizzes arrive as `kind:"assignment"` with no quiz type, canvas-models `quizResource`).

### Document extraction (code: documents.ts; test: materials)
- **Formats:** PDF by magic bytes `%PDF-` → `pdfjs-dist/legacy` (documents:195-260), ≤500 pages, text ≤200,000 chars, `page_limit`/`text_limit` → `partial`. `.docx .pptx .xlsx .odt .odp .ods` → `fflate.unzipSync` with a 20 MiB-per-entry / 50 MiB-total expansion guard, XML text through `htmlparser2` (63-175). `.html .htm .txt .md .csv .json .ipynb` or a `text/*`/JSON/XML content type → `extractLinkedText` (external:104; notebooks by cell). Anything else → `unsupported`. Files >100 MiB refused.
- **Anchors:** PDF → `parts[].page` + `document.pages[].anchor = "#page=N"`; slides → `parts[].slide`; others → `parts[].section`. No character offsets.
- **OCR:** `createLocalOcrAdapter` (358) runs configured `pdftoppm` + `tesseract` binaries (absolute paths, local traineddata) for a **textless PDF page only when the file is due soon or opened**; otherwise the status is `needs_ocr`. The worker wires it only when `MAGIC_PDFTOPPM_PATH`, `MAGIC_TESSERACT_PATH`, `MAGIC_TESSDATA_DIRECTORY` are set (worker:109-120). Doc: not demonstrated on a real scan.
- **Caching:** `createDocumentManager.capture` (433) skips the download when Canvas `updatedAt` equals the previous `document.updatedAt` and the local file still exists, and skips re-extraction when the previous status and cache are both `ok` (462-493). Files are stored as `<data>/documents/<hash(id)[0:20]>-<sha256>`, mode 0600; download concurrency ≤8 (default 4).
- **Where the text ends up:** for a Canvas file, `ingestion.documents()` (ingestion:160-315) writes a **second resource** under source `documents:<accountScope>:<courseId>:<externalId>`, scope `document:<externalId>`, copying the file's metadata resource and adding `text`, `parts`, `document`. The metadata resource under scope `files` keeps `text: ""`. Due-soon linked files download first. On a failed extraction the previous good text is re-saved.

### Connectors (code)
| Connector | Reads | Notes |
|---|---|---|
| Canvas (canvas:178) | Profile (account scope, hashed), to-do, upcoming events, activity stream + summary; active course catalog with syllabus, term, teachers, scores; per course: assignments + submission, modules → items (`include[]=content_details`), announcements (explicit date window), pages → bodies, details, submissions with comments, files, folders, assignment groups, quizzes, discussion topics | Every scope is its own `CaptureBatch` source (`canvas:<acct>:<course>:<scope>`). GET allowlist in `checkedCanvasUrl` (canvas-http:65). Throttling: reads `X-Rate-Limit-Remaining` and `X-Request-Cost`, slows below 100 remaining, retries 429 / rate-limit 403 up to 4 times honouring `Retry-After` ≤30 s (canvas-http:283-345). Metadata concurrency default 8 (max 16). 20 pages / 2,000 records per list, 8 MiB per response, 15 s per request, 2 min per scope. Course selection score and overrides in `canvas-selection.ts` |
| External course sites (external:357) | Folder-scoped crawl from seeds in course content: HTML, text, embedded schedule JSON, documents via the document manager | Credential-free client with DNS pinning and public-address checks (network:61-171), robots.txt (external:270), social/login hosts skipped, 2 streams per host, depth 6 / 300 pages, 6-hour reuse (451-456), a page losing >75% of its text keeps the old copy |
| Calendar feed (calendar:163) | Canvas ICS feed; `kind:"event"` with typed `calendar` and date claims | The feed URL is a capability kept in the OS-encrypted vault, never in the Store |
| UW GitLab (gitlab:291) | Project, issues, merge requests, pipelines, wikis, recursive tree, latest commit, instruction-like files (README/spec/lab/hw…, ≤100) | Own session or token; issues and MRs are `kind:"message"`; everything GitLab is classed `student_work` for sharing |

Canvas coverage gaps (not found or only partly followed):
- No `/tabs` request: course navigation tabs (hidden, reordered or renamed) aren't read.
- No `ExternalTool`/LTI or `SubHeader` module-item handling: these item types are stored as generic `moduleItem` rows with no distinct branch.
- Body links are extracted and stored (`canvas-content.ts:49-149`), but only same-course `/pages/{slug}` links are followed to fetch the linked page (`canvas.ts:859-881, 951-963`); links to assignments, files, external sites or other courses are stored in `links` but never fetched by the Canvas connector itself.

### Refresh (code: core/refresh.ts, ingestion:523-605, worker:129)
`createRefreshCoordinator` (core/refresh:43): the worker ticks every 30 s; a background run starts only if enabled, a Canvas source exists, the jittered interval (default 10 min ±20%) has passed and it's outside quiet hours (default 1–6 a.m.). Each run: calendar feeds → (unless in sign-in backoff) the activity-summary probe → a full Canvas read only if the summary signature changed, feeds changed, or it's manual → documents → external sites (own 6 h TTL) → a `SyncRun` row. Sign-in expiry backs off 3 intervals. Suspend/resume from `powerMonitor`. Manual refresh (`magic:sync`) bypasses the shortcuts; main caps it at 10 minutes. After each save, `linkExactEvidence(store)` (ingestion:496) writes exact-URL `specifies` and calendar `same_as` links.

### The MCP server (code; test: `tests/mcp.test.ts` incl. a real SDK stdio client)
- **Transport:** stdio, `@modelcontextprotocol/server` 2.1.0 (`McpServer`, `StdioServerTransport`). Server name "Magic Canvas", version 0.2.0. Entry `mcp-server.ts` → `mcp-server.cjs`, run by the Electron binary with `ELECTRON_RUN_AS_NODE=1`.
- **It opens the workspace database itself:** `createStore(config.databasePath)` (mcp-server:27), a **second process** on the same SQLite file as the worker (WAL + busy timeout), and it writes receipts.
- **How a CLI connects:** Data & AI → create a connection (recipient, courses, categories) → the `mcp-grant` command stores it (core:272-281, token hash preserved on edits) → **Export** (`magic:mcp-export`, main:387-431) writes `<userData>/mcp/<id>.json` = `{databasePath, clientId, token}` (mode 0600; token = 32 random bytes hex), stores `sha256(token)` in the grant, and returns `{"mcpServers":{"magicCanvas":{"command":<Electron exe>,"args":[<app>/mcp-server.cjs,"--connection",<file>],"env":{"ELECTRON_RUN_AS_NODE":"1"}}}}` for the student to paste into a client. Each export rotates the token. The server refuses a connection file that isn't absolute, is >16 KB, or (non-Windows) is group/world readable (mcp-server:9-26). Doc: client/account compatibility is unverified.
- **Tools** (all `readOnlyHint: true`, one shared strict input schema, core/mcp:14-23): `{query? ≤1000, courseId? ≤256, id? ≤256, days 1–90 = 14, since? ISO-with-offset, limit 1–50 = 20}`. Output is one text block of JSON.

| Tool | Returns |
|---|---|
| `search` | `Item[]`: every permitted resource scored in memory (+4 per term in title, +1 per term in text; terms = words ≥2 chars minus 12 stopwords; any hit counts), best first, `limit`. **No FTS** |
| `due_soon` | `Item[]` whose resolved `planningAt` is within `days`, soonest first |
| `recent_changes` | `{id, resourceId, type, observedAt, oldValues?, newValues?}[]` from `store.changes({since})`; values only for `date_changed` (due/unlock/lock); includes removed items |
| `course_overview` | `{items, kinds{assignment,material,event,message,course}, coverage[{source,status,complete,lastSuccessAt}], itemsWithNoDueDate}` |
| `get_item` | one `Item` for `id` |
| `answer_course_question` | `{mode:"source_passages", answer:<fixed sentence>, evidence: Item[]}`; ranked like `search`; **no model call** |

`Item` (core/mcp:114-169) = `{id, courseId, course, title, kind, text (≤8,000-char window; for search/answer it starts 500 chars before the first term hit, else at 0), excerpt{start,end} (offsets into Resource.text), deadline (DeadlineResolution), citation{url? (only if evidence-safe), version, observedAt, source (label)}, parts?[≤40]{page,slide,section,start,end,text ≤2,000}, freshness{status,complete,lastSuccessAt}, grade?{score,grade,late,missing,excused} (only with the grades grant), comments? (only with the comments grant)}`. No raw HTML, local paths or account IDs. A result over 200,000 chars is refused. Any failure returns `isError` with one fixed message.
- **Permission model, rechecked on every call** (core/mcp:52-87): the token's sha256 must timing-safe-match an **enabled** grant; a category is usable only if the grant lists it **and** `maySend(privacy, grant.recipient, [category])` allows it; a resource is visible only if it's live (except in `recent_changes`), its course passes `courseInclusion` (term filter, access state, override, selection), the grant lists its `(accountScope, courseId)`, and every category of the resource is usable (`message` → `communications`, GitLab → `student_work`, else `course_text`). One receipt per call: `{recipient, purpose:"MCP <tool>", categories, resourceIds, characters, status:"sent"}` (316-325). Revocation: disable the grant, re-export, or purge (deletes `mcp_grants` and the `mcp/` folder, main:375-384).

### `Store` methods (packages/storage/src/index.ts)
| Method | How (code) | Note for features |
|---|---|---|
| `ingest(batch: unknown)` (335-770) | Envelope parsed first; **each record validated separately**, invalid ones counted in `rejected` with path-only diagnostics (350-377); a record's `courseId` must match the source. A batch not newer than the source's last attempt is ignored (399). **Omitted fields keep the previous observation** (`mergeObserved`, 55-66; explicit `null`/`[]` overwrite). Drift checks can downgrade a complete batch to `needs_attention` (410-471: record count <30% of baseline, empty-text or date-coverage collapse, web text loss). Writes `resource_versions`, `observations`, `field_observations`, `resource_changes` (`new, updated, date_changed, requirements_changed, submitted, graded, removed, restored`), FTS, and queues `enrich.resource` (731). Only a complete `ok` batch deletes absent items | Re-importing a resource without a field does **not** clear it |
| `resources(search?)` (772-797) | FTS5 prefix-AND (`"term"*`), `ORDER BY rank`; whole `Resource`s; now one extra `field_observations` query **per row** (`readResource`, 250-258) | Still no snippets, scores or offsets |
| `resource(id)` (798) | Includes deleted rows | |
| `changes(filter?)` (864-903) | By resource, source, course, account, `since`; newest first; limit ≤2,000 (default 200) | A ready-made "what changed" feed |
| `scopeBaselines()` (904), `syncRuns()` / `addSyncRun` (918-939, keeps 100) | Drift baselines and refresh history | |
| `ingestionSettings()` / `setIngestionSettings` (826-839) | In `preferences` key `ingestion` | Purge resets them |
| `courseOverrides()` / `setCourseOverride` (840-863) | `null` deletes the override | |
| `mcpGrants()` / `setMcpGrant` (940-950) | JSON payload per grant | |
| `putJudgment` / `judgment` / `judgments`, `addAttempt` / `attempts`, `putLink` / `decideLink` / `links`, `enqueue` / `lease` / `finish` / `jobs`, `addReceipt` / `receipts`, `privacy` / `setPrivacy`, `setCompleted`, `sources()` | **Unchanged semantics.** `putLink` still allows only `specifies · supports · same_as` (991); `lease` still has no kind filter (1060); `addReceipt` still silently drops a receipt naming a non-live resource (1271); `sources()` now spreads `details` (`readId`, `diagnostics`, `stats`, `progress`) | `putLink` now has a production caller (`linkExactEvidence`); `addAttempt` still has none |
| `purge()` (1302-1311) | Deletes receipts, preferences, course overrides, sync runs, MCP grants, FTS, sources (cascading to every resource-keyed table, including the v3 ones), then checkpoint + `VACUUM`. Main also deletes `documents/` and `mcp/` and clears both sessions and the vault | |

**Migrations:** v1 (124-193) and v2 (195-201) unchanged. **v3 (203-227):** `sources.details`, `field_observations`, `resource_changes` (+ time index), `scope_baselines`, `course_overrides`, `sync_runs`, `mcp_grants`. **v4 (new, storage:31, `planning.ts` `planningMigration`):** `planning_sources`, `planning_captures`, `planning_records`, `planning_versions` — a separate table set for the planning subsystem, not touched by the coursework `ingest()`. A DB newer than v4 is refused (storage `schemaVersion` guard).

### `Command` union (contracts:740-766; handled at core:255-320)
12 variants: `snapshot{search?}` · `import{batch}` (now the envelope schema) · **`ingestion-settings{value}`** · **`course-override{value}`** · **`mcp-grant{value}`** · `fixture` · `complete{id,completed}` · `privacy{value}` · `context{id,recipient}` · `enrich{id}` · `link{id,status}` · `purge{confirmation}`. The switch **still has no default or exhaustive check**. Canvas sync is an IPC call (`syncCanvas` → `magic:sync`), not a command.

### Paths
- **IPC (code):** renderer → `preload.ts` → `main` (`validateSender`, main:42) → `utilityProcess` worker (main:102) → `core.execute`. The worker also owns ingestion, refresh and local AI; main answers its `source-fetch` / `source-secret` requests (main:161, 204).
- **Local AI (code):** unchanged; `core.context(id, "local")` now includes supporting material, bounded to 6,000 chars by `localContextPayload`.
- **Jev (code):** unchanged: gateway → TypeSafe, pinned model, one `assignment.kind.v1` choice question, validated, cached as a `Judgment`, shown as `kindLabel` at p ≥ 0.9. Global and per-device caps live in `apps/gateway/src/gateway.ts:38-51`. `drain` still handles only `enrich.resource` (core:167).
- **Privacy and receipts (code):** default `local_only`, every share flag false (contracts:475-484). Categories: `course_text`, `student_work`, `grades`, `comments`, `communications`. `core.context` and MCP both apply course inclusion and per-category `maySend`. `local` passes `maySend` in every mode.

### Doc claims (not verified here)
- 119 automated tests pass plus the desktop build (docs/implementation-status.md). I ran 30 of them.
- The expanded app-owned UW path, live rate costs, real OCR, provider/account MCP compatibility and Windows behaviour are unverified (the repo's docs say so).
- Reading pages may register views or satisfy `must_view` requirements; the team accepts this and the app must disclose it (AGENTS.md diff).

### Sign-in and session (code: main.ts, secrets.ts, worker.ts, refresh.ts)
- **Sessions:** `studentSession = session.fromPartition("persist:uw")` (main.ts:89) is shared by Canvas, My UW and Course Search & Enroll sign-in; GitLab gets its own `persist:gitlab` (main.ts:106). `magic:signin` (main.ts:584) opens a `BrowserWindow` on `partition: gitlab ? "persist:gitlab" : "persist:uw"` (main.ts:618) — enroll/myuw share Canvas's cookie jar.
- **`signInUW(service?)`:** `preload.ts:7` → `ipcMain.handle("magic:signin", …)` (main.ts:584); accepted values now `"canvas" | "gitlab" | "enroll" | "myuw"` (main.ts:585-592, contracts `AppBridge.signInUW`). Login origin: `https://canvas.wisc.edu` | `https://git.doit.wisc.edu` | `https://enroll.wisc.edu` | `https://my.wisc.edu` (main.ts:598-602). Navigation is fenced by `allowedLogin` (main.ts:68, checked at 630/635/639).
- **Profile check (Canvas/GitLab only):** on `did-finish-load`, back at the login origin, a `GET .../users/self/profile` (Canvas) or `/api/v4/user` (GitLab) must return JSON with a numeric-looking `id` before the window closes and `worker.postMessage({kind:"reconnected"})` fires (main.ts:649-690). **For `enroll`/`myuw` this check is skipped outright** (`if (planning) return;`, main.ts:650) — the student closes the window themselves once done; nothing in-app confirms the sign-in succeeded.
- **Planning account scope:** a random `uw-session:<uuid>` (main.ts:94-97), persisted at `<data>/planning-session-scope` mode 0600 (main.ts:90, 724) and reset with the file deleted on sign-out (main.ts:196-197). It is separate from Canvas's account-scope hash and never touches `secrets.ts`.
- **`secrets.ts` (unchanged since `7962d4e`):** `createSecretVault(path, encryption)` is a single JSON blob, OS-encrypted (`encryption.available()` throws if unavailable), atomic write via temp-file rename, mode 0600/0700. Holds capability URLs (e.g. the calendar ICS feed) and tokens — not session cookies, which stay in Electron's own partitions.
- **Sign-out / expiry:** `magic:signout` clears `studentSession` storage and cache (main.ts:467, 753-754) and (for the relevant service) resets the planning scope. No dedicated "Sign in again" prompt was found for enroll/myuw failures in the diffed files; a failed planning read surfaces as a source-health `status` (`blocked`/`failed`) via `store.planningSources()`, not as a forced re-auth. No "Sign in again" prompt exists in `apps/desktop/src` or `packages/core/src` (not found).
- **Refresh backoff (unchanged):** Canvas sign-in expiry still backs off background refresh 3 intervals (`core/refresh.ts:155` `reconnected()`); planning's own refresh loop (`worker.ts:132-209`, `planning-sync`/`planning-cancel`/`planning-scope` messages) is a separate abortable run, generation-counted, not tied to the Canvas backoff.

## Features can start now, against the contracts as they are
- **Everything the old map listed** (pure engines, eval harness on `createStore(":memory:")`, FTS retrieval), now over much richer captures.
- **Lecture-level grounding:** read `parts` (page/slide/section) and `document.pages` from the `documents:` resources; compute offsets by replaying the `"\n\n"` join (verify against `text`, don't assume).
- **Course scope and exclusion for free:** `courseInclusion(store)` (core/access:7) is the same gate the MCP server and `core.context` use.
- **Change-driven work:** `store.changes({since, courseId})` gives typed events (`requirements_changed`, `date_changed`, `removed`…) to invalidate or rebuild feature artifacts.
- **An MCP route for a CLI today:** export a grant and point the CLI at it; the six tools already enforce grants and write receipts. It's extractive only.

## Gaps: what the learning features need that the contracts don't carry yet
Propose each as **additive and optional**, with a fixture and a test; tell the team in the PR. `resourceInputSchema` is still `.strict()` (contracts:372): an old build rejects a capture that carries a new field (now per record, not per batch).
| Need | Status at 7962d4e | Smallest proposal now |
|---|---|---|
| **Location anchors in `text`** | **changed (half closed):** `parts[]` exists (contracts:280-294) with `page`/`slide`/`section` and optional `start`/`end`; the extractor fills page, slide and section (documents:251, 96-99, 83-88, 157) but **never `start`/`end`**; `document.pages[].anchor` = `#page=N`. Canvas HTML (pages, assignments) has no `parts` | Fill `start`/`end` in `createLocalDocumentExtractor` (a few lines where `result.text` is appended) |
| **Material role** | **open:** no `role`; nearest signals are `moduleItem.type`, `file.contentType`, `gitlab.evidenceKind`, the source scope | `role?` as before, or derive in feature code from those signals |
| **Term of origin** | **changed:** `course.termId`/`termName` on the `kind:"course"` resource (contracts:145-146) and `ingestionSettings.selectedTerm`; `parseAcademicTerm` (canvas-selection:29) | Join by `courseId` in feature code; no per-resource field needed for this term |
| **Assessment type** | **unchanged in kind:** Jev `kindLabel` only; quizzes captured as `kind:"assignment"` without a quiz type; `submissionTypes` and `assignmentGroup` (weight, drop rules) now captured | `assessment?` captured field; or read Canvas `quiz_type` into it |
| **Coverage links** | **open:** `Link.type` unchanged (contracts:501), enforced at storage:991 | add `'covers'` in both places |
| **Modules and order** | **closed:** `module` (contracts:307-317) on module resources; `moduleItem` with `position`, `type`, `contentId`, `pageUrl`, completion and lock info on items. The item's module is only its source scope `module-items:<id>` | Optional `moduleItem.moduleId` would save parsing the scope |
| **Source format** | **changed:** free-string `contentType` + `file.contentType` + `document.extractionStatus`; no `format` enum | Derive in feature code; drop `format` from B01 |
| **Class sessions** | **changed:** calendar-feed events (`kind:"event"`, `calendar{uid,start,end,allDay,timezone}`) and Canvas upcoming events; no location; lectures aren't told apart from assignment events | `session?` only if a lecture schedule source appears |
| **Course AI policy** | **open:** no connector sets `policy`; the schema default `{mode:"unknown"}` (contracts:370) applies to every resource | Our N27 in feature code first; connector side later |
| **Generated study items + reviews** | **open, and v3+v4 are taken:** v3 holds ingestion tables (storage:203-227), v4 holds the new planning tables (`planningMigration`); no item, review or FSRS tables | Migration v5 or the storage extension hook (B02) |
| **Older versions of a resource** | **open:** `resource_versions` keeps every payload but `Store` has no accessor | `Store.resourceVersion(id, version)` (B12) |
| **Text-only hash** | **open, and wider:** the hash covers the whole merged input, which now includes `submission` (score, grader comments), `rawHtml` and `links`, so a new grade or comment re-versions the resource and hides its judgments and links | `text_hash` in feature code |
| **Feature commands** | **open:** 12 variants, none for learning; no exhaustive check | `{type:'learning', request}` (B01/B03) |

## Overlap with our spec
Against `docs/plans/2026-09-26-notebook-and-study-tracking/spec.md` + `tasks.md` and `docs/plans/2026-09-26-backend-optimization/plan.md`. **Built** = the current code does it; **partial** = some of it; **conflict** = the current choice and ours can't both stand as written; **ours** = still ours to build.

| Our item | Verdict | Where, what's missing, or how it conflicts |
|---|---|---|
| Canvas coverage: modules, pages, files, announcements (B05, first half; spec risk row 1) | **built** | canvas:853-1090. Drop these from B05 |
| Extraction with parts (B05 `extract.ts`; PDF by page, PPTX by slide) | **built / conflict on file** | documents.ts does it with PDF.js + fflate. B05's new `packages/connectors/src/extract.ts` would duplicate it: extend `documents.ts` instead. Missing: `start`/`end` on parts |
| O6 extraction cached by file hash; text first, OCR only for empty pages | **built (mostly)** | documents:462-493 reuse keyed by Canvas `updatedAt` + prior `ok` status, not by content hash; OCR only for textless PDF pages that are due soon or opened (documents:228-240) |
| NB-3 / N01 passages with offsets + quote validator | **partial** | The current code gives page/slide/section parts and MCP `excerpt{start,end}` windows. No splitter, no `textHash`, no quote validator. Ours, now seeded from `parts` |
| O4 passage FTS + OR query | **ours** | `resources(search)` is still prefix-AND over whole documents. the current MCP search is OR-like but a substring scan with no FTS |
| N02 course-scoped retrieval + not-found | **partial** | Course scoping and exclusion exist (`courseInclusion`, grant courses). Missing: BM25 over passages, the support threshold / `not_found`, `scope{searched,excluded,missing}`. `answer_course_question` always returns passages or a fixed "none found" sentence |
| N27 / NB-18 course AI policy from the syllabus (and B05's policy half) | **ours** | Syllabus is captured (`externalId:"syllabus"`); policy is never set |
| N04 policy gate | **ours, with a conflict** | The current MCP tools apply no course/item policy gate: a granted client gets open graded assignment text and `answer_course_question` passages regardless of `policy.mode`. Our rule "one gate used by chat, generation and the MCP tools" needs the current tools to call it, or ours to replace them |
| N18 tool handlers | **partial / conflict** | The current `createMcpService.call` (core/mcp:64) is handler + schema + receipt in one. Overlaps: `deadlines` ≈ `due_soon`; `course_list`/`course_outline` ≈ `course_overview` (no outline, units or policy); `materials_search` ≈ `search`; `passage_get` ≈ `get_item`. Conflicts: its outputs carry `citation.url` and, with grants, grades and comments (our N18 forbids URLs and grades); one shared input schema vs our per-tool schemas; no write tools (`artifact_save`, `items_submit`, `concept_map_submit`) |
| N19 stdio server | **built / conflict** | `mcp-server.ts` with SDK v2 over stdio. Conflicts with N19's "the server process never opens a database": the current server does (mcp-server:27) |
| N26 MCP-to-worker bridge | **conflict** | The current code chose direct DB access from the MCP process, authenticated by a per-grant token in a 0600 file. Our bridge exists to keep one writer and keep the file away from the CLI; the current design has two writers, and the connection file holds the DB path and token. Decide: adopt the current model and drop N26, or propose the bridge as a PR to `main` |
| N20 Claude route tool allowlist `mcp__magic__*` | **conflict (naming)** | The current exported server key is `magicCanvas`; if we reuse the current server the allowlist pattern changes. The built-in-tool lockdown is still needed either way |
| O10 coarse tools (`notes.build_course_tree`, `artifacts.build`, `materials.search`) | **partial** | The existing six are coarse reads; ours don't exist. Add them to the current server (one server) or run a second one |
| Receipts for tool egress (spec §8.3; decision 7) | **built** | One receipt per MCP call (core/mcp:316). One receipt-coverage edge case was reported to the team privately |
| Per-client grants (courses × categories × recipient) | **built (not in our plan)** | Stronger than our spec's route-level consent. Our `learning_state` category would join `mcpCategorySchema` (contracts:582) |
| B01 optional fields `parts, role, term, module, format` | **partial** | `parts` and `module` built (different shape: `module` + `moduleItem`); `term` via the course resource; `role`, `format` open (`contentType` exists). Shrink B01 to `role` (+ maybe `assessment`) |
| B01 `covers`, `{type:"learning"}`, `learning_state`, `hostedProvider:"openrouter"` | **ours** | None present |
| B02 storage extension hook / feature migration | **ours; changed** | v3 and v4 are taken (ingestion, then planning). Option B becomes "v5". Purge now also clears the v3 **and v4** tables (`planning_sources`/`planning_captures`/`planning_records`/`planning_versions`, storage:index.ts `purge()`); our purge-completeness test must count them |
| B03 exhaustive switch in core | **ours** | Still missing, now over 12 variants |
| B06 dependencies | **partial** | MCP SDK built (`@modelcontextprotocol/server` + `client` 2.1.0, root package.json). `ts-fsrs`, markmap, docx and our path aliases still ours |
| B09 Windows file-mode guard | **ours** | `tests/storage.test.ts:129` still asserts 0600 unguarded (only the MCP test is guarded, mcp.test.ts:567) |
| B11 `learning_state` + always-preview | **ours; changed** | `maySend` now refuses unknown categories, so `learning_state` must be added to its allowlist (domain:40-54). The new share flags are `.optional()`, not `.default(false)`: follow the current pattern |
| B12 `covers` allowlist + `Store.resourceVersion` | **ours** | Neither present |
| O1 scoped queries instead of full snapshots | **ours; more urgent** | `snapshot()` now adds changes (100), sync runs and grants; `resources()` does a query per row; `snapshot()` reads all resources twice (`evidenceFor` + `resources`) |
| O2 prepared-statement cache | **ours** | Still inline `prepare` in loops; ingest does more statements per record now |
| O3 `synchronous = NORMAL` | **ours** | Not set (storage:99-101). With two processes on the DB, test it with the MCP server attached |
| O5 `text_hash` | **ours** | Unchanged hash coupling |
| O7 job kinds + priority | **ours** | `lease` has no kind filter, `drain` handles one kind. Precedent for priority: due-soon files download first (ingestion:181-193) |
| O8 stable-prefix sessions | **ours** | Agent runtime |
| O9 / B07 Jev batching and endpoints | **ours** | Gateway unchanged |
| O11 Canvas throttling | **built** | canvas-http:283-345. Drop from our plan |
| M1 Canvas concurrency 2–4 | **conflict (measure)** | The current code ships metadata concurrency 8 (max 16), unmeasured live. Our M1 adopt/kill rule applies to the current default |
| M2 incremental sync by watermarks | **partial** | Activity-summary signature skips a full read; page bodies and files reuse on `updated_at`; external sites have a 6 h TTL. No per-list watermarks |
| M3–M7 | **ours** | Nothing built |
| Planning subsystem (My UW, DARS, Course Search & Enroll, `comparePlanning`) | **built, out of our plan's scope** | New since `7962d4e` (contracts/planning.ts, storage/planning.ts, core/planning.ts, connectors/uw-planning-*.ts). Not in `docs/plans/2026-09-26-notebook-and-study-tracking` or `docs/plans/2026-09-26-backend-optimization`; no conflict found because it never touches `Resource`, `core.context`, or `core/mcp.ts` (grep-confirmed). If a later plan wants planning data in chat/MCP, it needs its own gate — `sharePlanning/shareHolds/shareAudit` exist in `maySend` but nothing calls them from the AI or MCP paths yet |

## Extension points for learning features today (no edit to the current files)
| Plug-in | Where | Limit |
|---|---|---|
| New workspace package `packages/<feature>` | `pnpm-workspace.yaml`, `tsconfig.json` | Path alias needs a shared-config line |
| Read and write through the `Store` interface | contracts:665-688, `createStore` storage:94 | In-process only (worker, tests, harness) |
| Lecture-level text | `parts`, `document.pages` on resources from `documents:` sources (ingestion:214-222) | No offsets; PDF anchors only for PDFs |
| Course inclusion + categories | `courseInclusion` core/access:7, `contentCategories` core/access:56 | Imported by relative path (not exported from `@magic/core`) |
| Supporting material for an assignment | `evidenceFor(store).supporting(r)` core/evidence:103 | Exact-URL `specifies` links only, depth 2 |
| Change feed | `Store.changes(filter)` storage:864 | Newest first, ≤2,000 |
| Practice evidence, judgment cache, candidate links, receipts | As in the old map (`addAttempt` 1193, `putJudgment` 1144, `putLink` 988, `addReceipt` 1256) | Same limits; no `covers` |
| A new capture source | `Connector` contracts:890; `import` command or the file dialog | Must fit the strict `ResourceInput`; `url` must pass `evidenceUrlSchema` |
| MCP from a CLI (read-only, extractive) | Export a grant (`exportMcp`), point the CLI's MCP config at the returned JSON | Six fixed tools; no learning tools; `get_item` text capped at 8,000 chars with no offset argument |
| Document extraction in feature tests | `createLocalDocumentExtractor().extract(file, opts)` documents:176 | Local files only |

## Would require changes to the current packages
| Change | Files and lines |
|---|---|
| Learning `Command` variant + exhaustive switch | contracts:740-766, core:255-320, renderer |
| New MCP tools on the current server, or a policy gate in the current tools | core/mcp:24-43 (names), 64-327 (`call`), 328-363 (registration); `mcpCategorySchema` contracts:582 for `learning_state` |
| MCP via a worker bridge instead of a direct DB handle | mcp-server:27, main:387-431 (export), worker message loop |
| `start`/`end` on parts | documents:251, 295-307 |
| Syllabus policy in the connector | the syllabus resource in canvas.ts (~473-520) and `resourceInputSchema.policy` |
| Feature tables | `SCHEMA_VERSION` storage:31 (now 4) + a `schemaVersion < 5` block after the new planning migration, or the extension hook; `Store` contracts:666-669; purge storage `purge()` |
| Feature job kinds | core:167 fails other kinds; `lease` storage:1060 has no kind filter; `drain` needs a gateway and Jev permission (core:159-164) |
| New privacy category | `mcpCategorySchema` contracts:582, `privacySchema` 465-466, `maySend` allowlist domain:40-54 |
| `covers` link type | contracts:501, storage:991 |
| `Store.resourceVersion` | contracts:665-688, storage (read `resource_versions`) |
| Snapshot scoping (O1) | contracts:703-719, core:37-81, storage `readResource` 239-260 |
| A new Jev judgment, local structured generation, multi-resource context | As in the old map (gateway, `packages/ai`, `core.context` 82-127) |

## Breaks for feature code
**Types: additive except these.**
- `resourceInputSchema.url` is `evidenceUrlSchema` (contracts:261): a fixture URL with `token`, `signature`, `key`-like query keys or a non-http(s) scheme is now rejected (per record).
- `CaptureBatch.source.kind` and `status` gained members; an exhaustive switch over them stops compiling.
- `Store.ingest` takes `unknown` and returns `rejected` + `diagnostics` instead of throwing on a bad record: a test that expected a throw for one bad resource now gets a partial ingest.

- `Store` interface (contracts:666-669) gained three required methods (`ingestPlanning`, `planningRecords`, `planningSources`): any hand-written mock of `Store` outside `createStore` now fails to type-check. Grep of `packages/` and `tests/` found none (only `createStore` implements it; `apps/gateway/src/gateway.ts` references `Store` by type, not by implementing it) — no break found in practice, but a future feature-package mock must add the three methods.

**Runtime rules code written against the old map must respect:**
- `maySend` returns `allowed:false` for any category outside the five (domain:40-54): a feature category such as `learning_state` is blocked until added.
- Omitted fields keep their previous value on re-ingest (storage:55-66). To clear, send `null` or `[]`.
- A complete batch far smaller than the source's baseline (≥5 records) becomes `needs_attention` and deletes nothing (storage:422-471): synthetic fixtures that shrink between imports into the same source will trip it.
- A batch whose `observedAt` isn't newer than the source's last attempt is ignored (storage:399).
- A Canvas file is two resources: metadata (scope `files`, empty text) and the extracted document (source `documents:…`). Read the second.
- Every earlier rule still holds (`addAttempt`, `putJudgment`, `enqueue`, `links()` staleness).

## Open with the team
- Where feature state lives: a Store migration (now **v5**, since v3 is ingestion and v4 is planning; purge covers whichever version lands) versus the extension hook versus a feature-owned DB (purge would miss it). Goes to `main` as a PR.
- **MCP architecture:** extend the current server (one server, its grants, its direct DB handle) or keep our bridge design. Either way, the current tools need our policy gate before learning use.
- **A permission-model issue** in the MCP grant checks was found in review and reported to the team privately. Details will be published after the fix.
- Whether `generate()` gets a task parameter (prompt + JSON schema) or a sibling function for practice items.
- Jev budget: the per-device cap cannot carry a per-item verification pipeline; local verification or a raised cap is a product decision.
- Canvas concurrency default 8 vs our measure-first 2–4 (M1).
- **New:** the planning subsystem's My UW/enroll sign-in skips the profile-JSON check that Canvas/GitLab sign-in does (main.ts:650) — worth flagging in the sign-in review, since a failed or wrong-account sign-in for enroll/myuw isn't caught the same way.
- **New:** `sharePlanning`/`shareHolds`/`shareAudit` exist in `maySend` but nothing in `core.context` or `core/mcp.ts` calls them yet — planning is safe today only because nothing reads it, not because a gate enforces it. Any feature code that later surfaces planning records to AI or MCP must add that gate itself.
