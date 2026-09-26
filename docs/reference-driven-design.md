# Reference-driven design

Accepted working method, September 26, 2026. Based on Ben's supplied `rdd.md` and agent work principles. This governs building and verification, not just concept images. It does not settle the interface. [Organizing concepts](product-directions.md) remain open for Ben's reaction.

## The method

1. **Frame the journey.** Name the student, goal, real content, normal entry/default state, success, and the failure or friction to remove. Inspect the current product before redesigning it.
2. **Assign reference jobs.** Evidence, interaction, visual direction, architecture, implementation mechanism, or weak preference signal. Choose references that address the actual gap; search by mechanism across local and external work, not just education products.
3. **Inspect the source.** Read the relevant current documentation, use the actual interaction when needed, or inspect code when permitted. Record platform/version/date and evidence location. A screenshot can establish appearance; it cannot establish recovery, behavior, or a company's reason for a decision.
4. **Transfer explicitly.** Record the observed property, author's stated rationale if available, our inference, applicability conditions, tradeoffs, proposed artifact change, and failure/reversal condition. Respect licenses. For a clean-room component, give builders an approved behavior specification and tests, not implementation code.
5. **Compare where uncertain.** Generate distinct candidates cheaply. Hold content and unrelated styling stable so Ben can judge the consequential difference. Allow rejection or combination. Do not choose or merge the current organizing concepts before his reaction.
6. **Implement the mechanism.** Connect it to the normal user journey and default state. Prefer the smallest useful adaptation. Resolve incompatible reference properties rather than accumulating every pattern in one screen.
7. **Verify the transfer.** Inspect the real rendered result and journey. Measure effort, findability, mistakes, recovery, accessibility, and responsiveness where relevant. Check the actual operation that produces the behavior. Passing tests, a polished screenshot, and a reference citation alone are insufficient.

Use a short paragraph for a small change; the following record is for consequential decisions, not mandatory paperwork for every button:

> **Goal/journey → reference and role → inspected evidence/version → observed mechanism → stated rationale vs inference → applicability → proposed change → success check → failure/reversal → result and remaining uncertainty.**

## Architecture by analogy

Study products similar in structure: VS Code's workbench and execution boundaries; Notion's objects and views; Google Drive's resource identity and organization; Arc's task contexts; Codex and Claude's project navigation and working surfaces. Look at recent decisions and the original reasoning when available. Product teams' investment makes them useful references, not automatically correct for our audience.

Our abstraction beyond education is a personal workspace that assembles scattered evidence around work, restores its tools, and helps someone improve. Transfer useful boundaries while retaining course scope, policy, and learning evidence. We do not need a universal page builder, plugin marketplace, new browser, or replacement filesystem to serve this journey.

For a 5–10 year view, use conditional scenarios: if local models become capable enough, inference adapters change; if sanctioned source access improves, connectors change; if agents become more reliable, more recipes can be discovered automatically. Stable evidence identity, permissions, source history, and reversible actions remain useful. These are architectural stress tests, not forecasts or reasons to build every future surface now.

## Reference register and concrete transfers

Official documentation below was inspected September 26, 2026. “Documented” means the behavior is described by its maker; it does not mean we used the live app or measured a student outcome. These proposed transfers are not retrospective proof that the existing UI implements them.

| Reference / job | Evidence inspected and transferable property | Magic Canvas change and verification |
| --- | --- | --- |
| [VS Code extension host](https://code.visualstudio.com/api/advanced-topics/extension-host) — architecture | Documents separate hosts, capability/location choices, and lazy activation; explicitly states UI/startup stability as its goal | Keep view rendering independent of connector/model work. The existing utility worker is compatible with this mechanism; verify slow or failed work leaves evidence usable. It does not prove we need a plugin runtime. |
| [Notion database views](https://www.notion.com/help/views-filters-and-sorts) — object/view mechanism | Documents multiple views, filters, and sorts over database content | Day, spaces, and calendar should project the same item IDs and state. Check that a correction/completion survives switching views; avoid requiring students to build databases. |
| [Google Drive organization](https://support.google.com/a/users/answer/13005112?hl=en-CA) — resource organization | Documents shortcuts and workspaces as ways to find and group existing files | A task's working set references originals. Closing a space must not move/delete source files. Verify reopen behavior and stale links; do not duplicate the filesystem. |
| [Arc Spaces](https://resources.arc.net/hc/en-us/articles/19228064149143-Spaces-Distinct-Browsing-Areas) — context switching | Documents separate pinned/unpinned groups and multiple switching routes | Restore a task's chosen resources without reopening a large unrelated pile. Compare recovery after interruption and the effort of maintaining spaces. This is an interaction reference, not a dependency choice. |
| [Canvas dashboard](https://community.instructure.com/en/kb/articles/664620-how-do-i-use-the-dashboard) and [List View](https://community.canvaslms.com/t5/Student-Guide/How-do-I-use-the-to-do-list-for-all-my-courses-in-the-List-View/ta-p/345) — familiar navigation | Documents course cards, agenda/list, and activity views | Compare time-first and course-first entry with consistent state and terminology. Preserve work without dates and source coverage; a cleaner planner cannot silently lose those items. |
| [Claude quick entry](https://support.claude.com/en/articles/12626668-use-quick-entry-with-claude-desktop-on-mac) — low-friction invocation | Documents shortcut invocation and explicit application-window attachment on Mac | Test a student-invoked overlay that returns focus to the original app. Show exactly what is captured and permit cancellation. Windows equivalence and Magic Canvas screen capture are not established. |
| Apple suggested apps — weak interaction preference | Ben's reference is context-sensitive launch suggestions; no current platform behavior was established in this pass | Investigate a few useful launch actions drawn from schedule and actual behavior. Compare with a fixed recent-items list; retain dismiss/pin control. Never infer personal preferences solely from a model. |
| Codex/Claude desktop layouts; Claude/ChatGPT/Gemini artifacts — visual and working-surface candidates | Named references remain to be inspected at the exact current screen/version before copying layout or claiming behavioral parity | Compare stable course/project navigation and a persistent artifact with conversational help beside it. Keep a short answer short. Verify returning to an artifact without searching a transcript. |
| [Learn Git Branching](https://learngitbranching.js.org/) — learning interaction candidate | Public page confirms a browser Git simulation; its actual lessons still need interactive inspection | Test a prediction → action → visible state change → explanation loop tied to a real skill. Keep it only where manipulation improves understanding over a concise explanation and practice. |

## Concept images

Use the selected reference folders as actual image inputs. Check that downloads are valid images, readable at useful resolution, and complete; repair failed or placeholder downloads before use. Keep provenance and permitted-use notes with the reference set, and private student material outside the repository.

Prompt minimally: student task, real or clearly synthetic content, the references' assigned roles, and essential constraints. Avoid prescribing every pixel so the references and the model's learned design knowledge can shape the layout. Keep accessibility and functional requirements explicit. Generate distinct organizing ideas before polishing a winner, then iterate with Ben's concrete feedback. Record which property each correction changes. An image establishes a visual hypothesis; implementation and journey verification must follow.

## Learn from demos without inventing their implementation

For each Jev, voice, generative-interface, or browser demo: inspect the actual video and available source; identify prebuilt candidates/catalogs, cached data, scripted scope, model calls, code actions, latency boundaries, edits, and retries. Separate what is observed from what the author reports and what we infer. Unknown failure rates stay unknown.

Reproduce the useful mechanism in an appropriately bounded experiment: compare cold and warm starts, ambiguous targets, stale/missing evidence, failed calls, and recovery. Track end-to-end time and incorrect/unwanted actions. A rehearsed path or seeded data can be labeled; it cannot stand in for a capability. The supplied public Jev videos remain unverified until watched and inspected; no replication claim is made here.

## Keep the method in the work

The driver includes relevant reference roles and checks in delegated briefs and checks returned work against them. Keep evidence paths retrievable; do not load all reference material into every worker. Raise unclear intent, conflicting patterns, added UI clutter, architectural complication, or disproportionate token spend with Ben before committing to dependent work. Use [engineering principles](engineering-principles.md) and the [current tool matrix](tool-evaluation.md) for technology adoption.
