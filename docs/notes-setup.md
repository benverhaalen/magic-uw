# Session notes: backend, commands and sync setup

Status: **built and tested in isolation** (synthetic tests in `tests/notes-*.test.ts`). The worker and main wiring compiles and builds; it has not been demonstrated in the running app, and the renderer does not call it yet. Remote sync has not been run live.

Every scheduled lecture, discussion and lab gets an organised notes page. Code builds each page at 0 tokens; the student edits it freely; an optional "fill from slides" runs one checked AI call when the student asks; and notes can sync two-way with Word (the app's OneDrive folder) or Google Docs (`drive.file`), where the student may prefer to write.

## How a note comes to exist

- **Batch scaffolds (the rolling window).** On the worker's 30-second tick, `refresh()` makes sure every lecture, discussion and lab this week and next (Monday-based, America/Chicago) has a note. The tick is skipped when nothing it reads has changed (a fingerprint of source reads, planning reads, course-map rows and course overrides).
  - An **untouched** scaffold is rebuilt when its inputs change; each rebuild is a new version.
  - A note the student **edited** is never rebuilt. Only its session details (time, place) follow the schedule.
  - A session that disappears from the schedule keeps its note, marked `scheduled: false`.
- **Lazy open.** `notes.open` with a session outside the window creates that note on first open.
- **Separate notes.** `notes.create` makes a note that isn't tied to a session.

## Where sessions come from (`packages/notes/src/sessions.ts`)

`SessionsPort.sessions(courseId, range)`. The adapter over today's data, most exact first:

1. **The planning enrollment's class meetings.** These are local-only. Code uses them, and they are never sent to AI. The Canvas course is matched to its enrollment package through the Guide's subject table (`resolveCourseIdentity`), or else by catalog number plus exact catalog title. Session type comes from the package's section components: a single component names the type. Otherwise the meeting on the most days is the LEC, a meeting of 100 minutes or more is the LAB, and the rest are DIS. The rule used is kept as `typeBasis`.
2. **Course-map sessions** (`course_sessions`, v6). They add a title and readings (`map_links`) to a meeting.
3. **Timed Canvas calendar events** whose title names a lecture, discussion or lab. Assignment events and all-day events are never sessions.

There is one session per course, local date and type, with id `<courseId>/<YYYY-MM-DD>:<type>`. When `agenda(date)` from `feat/material-pipeline` lands, it becomes another adapter behind the same port.

## Templates and `suggestTemplate`

Each template is a typed block schema (`noteBlockSchema` in `packages/contracts/src/notes.ts`). Every note starts with four scaffold blocks: Session, Slides and readings, Key terms, Due next. The template's own blocks follow.

| Template | Blocks | Suggested for |
|---|---|---|
| `cornell` | cues, notes, summary | lectures in humanities, social science, life science, arts |
| `worked-problem` | ideas and formulas, worked problems, mistakes, summary | math, physical science and engineering lectures and discussions |
| `concept-code-pitfalls` | concepts, code, pitfalls, questions | computing lectures and discussions |
| `lab-notebook` | objective, procedure, data, results, questions | every lab except a language lab |
| `vocab-grammar` | vocabulary, grammar, phrases, practice | language courses (lectures, discussions, labs) |
| `reading-response` | claims, response, questions, takeaways | humanities and arts discussions |
| `discussion-prep` | before, questions, during, takeaways | social and life science discussions, and unknown families |
| `case-method` | facts, decision, analysis, options, recommendation | business |
| `outline` | outline, summary | an unknown subject family with no session type |

`subjectFamily(course)` works in this order:

1. The UW subject code from Canvas's course code, looked up in a table.
2. If the code isn't in the table, keywords in the course title.
3. One override: a computing course whose title is mathematics (for example "Discrete Mathematics") counts as math.

The student can switch templates with `notes.setTemplate`. Their content moves into the new template's matching blocks, and anything without a match is kept as its own block. The choice is remembered per course and session type.

## The scaffold (0 tokens)

- **Session:** the date and time, the module, the section and the location.
- **Slides and readings (at most 5), each with code's reason.** Candidates are:
  - a course-map `covers`/`reading` link;
  - a title that names the session date (`9/28`, `Sep 28`);
  - a title that names the session's ordinal (`Lecture 12`);
  - a slides or reading title posted 0–3 days before the session.
- **The module:** a module named for the date or the term week ("Week 5"), else the latest module unlocked in the past 6 days. Canvas items don't record their module, so the module itself is linked.
- **Key terms (at most 8):** the linked materials' `material_facts` terms. If there are none, the course profile's topic claims are used. Both may be empty until the material pipeline lands.
- **Due next (at most 3):** assignments with confirmed due dates after the session.

## Storage (v9, `packages/storage/src/notes-v9.ts`)

- **The tables are additive:** `notes`, `note_versions`, `note_links`, `note_template_choices`, `note_suggestions`, `note_remotes`, `note_sync_settings`. `SCHEMA_VERSION` is 9.
- **Versions:** the last 20 are kept. A version kept for a sync conflict is never pruned.
- **Purge:** the generic purge order empties every table here, and main's purge clears the vault, including the Google token.
- **Passages:** an **edited** note's text becomes one resource of the course's `notes` source. That resource has kind `material`, URL `https://local-note.invalid/<noteId>`, and source kind `notes`. Search, the notebook and analytics therefore read notes through the passage index. For `maySend` it counts as `course_text`, so it is sent only under the existing consent. Untouched scaffolds are not indexed, because they only repeat what the materials say.
  - **For the frontend:** filter source kind `notes` out of material lists and the change feed.

## Commands and queries (for the frontend)

Send `{ type: "notes", request }` through `window.magic.execute`. The typed answer arrives as `CommandResult.notes` (`NotesResult`). Request shapes are `notesRequestSchema`; result shapes are `NoteTree`, `NoteSummary`, `NoteDetail`, `NoteSuggestion`, `NotesSyncStatus` and `NoteTemplateInfo`, all in `packages/contracts/src/notes.ts`.

| op | Does |
|---|---|
| `notes.tree {courseId}` | The course, then each module, then its sessions and notes: from the term start through next week, plus separate notes. |
| `notes.recent {courseId, limit=5}` | The course page's compact list. Edited notes come first, by last edit, then upcoming scaffolds. Each has a title (session and date), `editedAt`, a first-line `preview`, `state` (untouched or edited) and `sync` (local, synced, pending or conflict). |
| `notes.open {sessionId \| noteId}` | Opens the note, creating it lazily. `created` tells whether it is new. |
| `notes.save {noteId, blocks, revision}` | Saves a new version. A stale revision returns `stale_revision` with the current note; nothing is merged silently. |
| `notes.setTemplate {noteId, template}` | Switches the template (content moves) and remembers the choice. |
| `notes.fill {noteId, resourceIds?}` | One checked AI call; returns `suggestions`. Nothing is written into the note. |
| `notes.suggestion {noteId, suggestionId, accept\|dismiss}` | Accepting appends the bullet to its block (origin `fill`, linked to its source). |
| `notes.append {noteId, text}` | Adds a line to the first writing block. |
| `notes.create {courseId, title}` | Makes a separate note. |
| `notes.version {noteId, version}` | Restores an old version as a new version. The note's current template label stays. |
| `notes.templates` | Lists the templates and their blocks. |
| `notes.sync.enable/disable {provider}` | Turns sync on or off. For Google, enabling runs the sign-in. |
| `notes.sync.status` | Per provider: whether it is enabled and connected, and its note, conflict and error counts. |
| `notes.sync.export {noteId, provider}` | Puts this note in Word or Google Docs and returns `webUrl`. This is the only way a remote file is created. |

## Command-bar actions (`packages/notes/src/actions.ts`)

`notesActions` is a set of plain objects for the shared intent router: `name`, `description`, `argsSchema` (zod), `examples`, `patterns` (the code fast path) and `run(args, ctx)`. It imports no router type.

| name | args | example |
|---|---|---|
| `notes.open` | `courseRef`, `when`, `type` (lecture by default) | "notes for today's CS 400 lecture" |
| `notes.append` | `courseRef?`, `text` | "add to my CS 400 notes: …" (targets the open note, else today's or the next session) |
| `notes.fillFrom` | `material`, `courseRef?` | "make notes from the week 4 slides" |
| `notes.new` | `title`, `courseRef` | "new note midterm review in MATH 234" |
| `notes.setTemplate` | `template` | "switch template to Cornell" (the open note) |

**The context `run` assumes (`NotesActionContext`):**

- `ctx.notes.handle(request)`: the notes seam.
- `ctx.notes.sessionOn(courseId, date | "today" | "next", type?)`.
- `ctx.resolve.course(ref)`, `ctx.resolve.when(text, courseId)` and `ctx.resolve.material(ref, courseId?)`. Each returns either `{ status: "resolved", … }` or `{ status: "needs_clarification", message, candidates }`. `when` may resolve to `"next"`.
- `ctx.currentNoteId?`: the note open in the UI.

`courseRef`, `when` and `material` stay raw strings. The router resolves them, and anything unresolved comes back as `needs_clarification` with candidates; `run` never guesses.

## Fill from slides (`notes-fill` pack, v1)

- **Sent:** the session's linked slides and readings as passages (at most 16 passages, about 4,000 tokens) and the template's block headings.
- **Never sent:** the class meeting's time, place or section, or the student's notes.
- **Checked by code:**
  - Every bullet's quote must appear verbatim in its passage (`quotesGrounded`).
  - Each `blockId` must exist.
  - `findQuote` must find the quote exactly once in the resource text.
  - Bullets the student already wrote are dropped.
- **Consent and receipts:** as for the other packs (`egressFor`, a receipt per send). A course that restricts AI help returns `blocked`.
- **Cache:** a repeat with the same slides is a cache hit (0 tokens), served even without a connected client.

## Two-way sync (`packages/notes/src/remote.ts`, `service.ts`)

- **Nothing without the student:** nothing syncs until the student enables a provider, and even then a remote file is created only by `notes.sync.export`.
- **Export:** a Word document, with a title, one Heading 2 per block, and one bullet per item (links kept).
  - **Microsoft:** `My Magic UW/<Course>/<date> <type>.docx` through the teammate's `appFolderPut(path, bytes, contentType)`. The note stores the returned item id and eTag.
  - **Google:** the same folder path is created with `drive.file`. The .docx is uploaded with conversion to a Google Doc (`mimeType: application/vnd.google-apps.document`), and the note stores the file id and `modifiedTime`.
- **Pull:** a conditional check at most every 2 minutes per provider. Microsoft uses `appFolderGet(id, eTag)`, where a 304 means unchanged. Google compares `files.get?fields=modifiedTime`, then reads `files.export?mimeType=text/html` only when the file changed.
  - Imported text becomes blocks again. Block and item ids, kinds and links are kept when their text is unchanged; new text is marked origin `remote`.
- **Conflicts:** remote edits since the last sync become a new version. Local edits that were not yet synced stay as their own version, flagged `conflict` and never pruned, and the note shows `sync: "conflict"` until the student saves. Neither side is ever dropped silently (`tests/notes-sync.test.ts`).
- **A deleted remote file** marks that link as an error; the note on this device is unchanged.

### Libraries (checked 2026-09-27 with `npm view`)

| Package | Version | Licence | Use |
|---|---|---|---|
| `docx` | 9.7.2 | MIT | Writes the .docx. |
| `mammoth` | 1.13.0 | **BSD-2-Clause**, not MIT | Reads a .docx back as HTML. |

The brief assumed mammoth was MIT. BSD-2-Clause is permissive and compatible with this MIT project; the attribution notice must be kept.

### Google setup

1. **Create the client.** In Google Cloud, create an OAuth client of type **Desktop app** and enable the Google Drive API.
2. **Configure the app.** Set `MAGIC_GOOGLE_CLIENT_ID` in the desktop app's environment. There is no client secret; Google lists `client_secret` as *Optional* for installed apps. Without the variable, Google sync reports "isn't configured".
3. **The sign-in flow:** OAuth 2.0 for installed apps with PKCE (S256) and a loopback redirect `http://127.0.0.1:<random port>`. Main opens the consent page in the default browser. It requests the scope `https://www.googleapis.com/auth/drive.file` only, with `access_type=offline`.
4. **Token storage:** tokens are stored in main's encrypted vault (Electron `safeStorage`). The worker never sees them; main performs the Drive calls it asks for, and only for `https://www.googleapis.com/(upload/)drive/v3/files…`.

**Verified facts:**

- **`drive.file` is non-sensitive.** Google lists it under "Non-sensitive scopes": "Create new Drive files, or modify existing files, that you open with an app…". Source: https://developers.google.com/workspace/drive/api/guides/api-specific-auth (page last updated 2026-09-03; fetched 2026-09-27). A non-sensitive scope needs no restricted-scope security assessment. A public app still needs brand verification to avoid the "unverified app" screen.
- **The loopback redirect and PKCE for desktop apps:** https://developers.google.com/identity/protocols/oauth2/native-app (last updated 2026-09-14; fetched 2026-09-27).
- **UW–Madison Google Workspace.** The DoIT KB explains that students approve third-party OAuth access themselves and can review or revoke it.
  - https://kb.wisc.edu/helpdesk/page.php?id=139025 (Introduction to OAuth; updated 2026-02-02)
  - https://kb.wisc.edu/helpdesk/page.php?id=139033 (Understanding OAuth permissions; updated 2026-02-02)
  - https://kb.wisc.edu/helpdesk/page.php?id=139035 (Manage OAuth permissions; updated 2026-02-02)

  No KB page found on 2026-09-27 says UW blocks third-party app access to Drive for students. That absence is not proof. Only a live consent attempt with a `wisc.edu` Google account can settle it, and it needs the operator's sign-in, so it has not been done.

### Microsoft

The adapter targets the Graph surface on `feat/outlook-graph` exactly (`appFolderPut`, `appFolderGet`). It is not wired in the worker until `graph.ts` lands, so `notes.sync.enable("microsoft")` answers `not_connected` with that reason.
