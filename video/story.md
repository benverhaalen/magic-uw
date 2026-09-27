# 2-minute video — story draft

**Status:** overall purpose and beat structure confirmed by Sean 2026-09-26 (see "Purpose" below).
Specific placeholders remain (Ben's catch, D11 sign-off) — see "Open questions." Step-by-step
production plan is a separate doc: [`production.md`](production.md).

## Purpose (confirmed 2026-09-26)

This is a **product demo for BuildFest judges**, not a hype trailer. In 2 minutes it has to answer:
what is this, who is it for, does it actually work. Repo and video get audited together, so nothing
in it can be a claim without evidence.

- **What it is** → the opening race (beat 1). One glance: scattered systems become one place,
  faster. That's the hook and the "what."
- **Who it's for** → the split POV (beats 2-3, Sean's non-CS courses vs. Ben's CS courses). One
  data point (Ben's own tuned courses) proves nothing about who this actually works for; a real
  non-CS schedule is the evidence this isn't just one person's class project for his own classes.
- **Does it work** → the two "caught that" beats are concrete before/after evidence, not narration.
  That's what carries "user insight" and "technical execution" for judges.
- Differentiation and the close preempt "isn't this just a Canvas wrapper" and end on a clear ask.

Throughline: **prove it's real and useful (race + catches) before explaining why it's different
(differentiation) and what's next (close)** — understanding backed by evidence, not a sales pitch.

## Production approach (launch-video tips, applied 2026-09-26)

Sean shared 7 tips from a prior launch-video build. What applies to this project, checked against
the actual `magic-uw` repo state:

1. **Tooling — no single tool wins.** Remotion, HyperFrames, editframe were all tried on the prior
   project with tradeoffs each way. `magic-uw` currently has no video/animation tooling installed
   in `apps/desktop` or `apps/web` (checked `package.json`, no Remotion/framer-motion/etc). Given
   the ~24h build window and that the product itself, Ben's catch (beat 3), and the D11 sign-off
   are all still open, **default to straight screen recording**, not a code-rendered video — a new
   rendering pipeline is real added scope we don't have slack for. Revisit only if there's time
   left after the product and script are locked.
2. **Model mix** — burn budget across models for hard cuts/edits. Production note for whoever
   drives the actual edit, not a story decision.
3. **Don't let the agent choose the beats.** Applies directly to me: the "narrative arc" and
   "beat-by-beat" sections below are my first-cut proposal, not a final script. Each beat's actual
   on-screen content and line needs explicit direction from Sean/Ben, one beat at a time, before
   it's locked — not filled in by inference from the docs. Treat what follows as a skeleton to
   confirm or overwrite, beat by beat, in conversation.
4. **Codebase access** — already true. `~/magic-uw` is cloned locally; any screen recording (or,
   if reconsidered, code-rendered segment) pulls real components from `apps/desktop/src`, not
   recreations.
5. **Animation component library** — repo has none. Not needed if we stay screen-recording-first
   (see #1); only becomes real scope if the team switches to code-rendered.
6. **Landing page as visual reference** — checked: `apps/web` is currently a bare `index.html`
   stub, no landing page exists yet. Nothing to use as a reference here; not building one for the
   video alone given the time budget, unless Ben decides otherwise.
7. **Branding** — checked 2026-09-26: no logo, brand colors, or brand assets on `main`. **Update
   same day:** Aidan pushed a wizard mascot logo pack (v0.1) to `northcutt-frontend`
   (`docs/logo-design-elements/`) — full SVG set, palette, wordmark (Fredoka SemiBold), even arm
   pivots for a wave animation. **Not merged to `main`, not a team decision yet** — still an open
   scope call whether it's in scope for this video (e.g. beat 6 close card) before recording, and
   whether/when it merges. Flag to Ben, don't assume it in.

## Decisions so far (Sean, 2026-09-26)

- **Opening beat: side-by-side stopwatch race — two real people, one shot, not a split screen.**
  Two people sitting side by side, each at their own laptop, filmed in a single continuous take —
  not a software split-screen edit. One person on raw Canvas, the other on My Magic UW, both racing
  the same task at the same time with a visible timer. Task: open your assignment, then your lecture
  notes (quiz review dropped, see below). In raw Canvas these live in different tools/tabs
  (Assignments, Modules/Files) — in My Magic UW they're one place. The visible time gap *is* the
  pitch, and a single unedited shot of two real people is more credible than an edited split screen.
  This is how the video starts, confirmed direction, not a proposal.
- **Race scope: assignments + lecture notes only, no quizzes.** Quiz review isn't built and isn't
  even designed yet (just one of ~11 possible future learning modules) — too undesigned to fake or
  rush. Lecture notes fetch is real feature work happening now (see Open questions) to make this
  leg true before it's shot; assignments are already real (coursework list + item evidence).

**Full rework, 2026-09-26 (supersedes the split-POV/personal-catch structure above the race).** Sean
rejected the "Sean's catch / Ben's catch" personal-evidence beats entirely — scratched, not tweaked.
New structure, race kept as-is, everything after it rebuilt:

- **Beat 2 — Home page.** A plain, real tour of the actual running home/Today screen (current app,
  not the unbuilt warm/ember redesign in `home-design-direction.md` — that's a mockup, not
  integrated, don't shoot against it). One concrete real detail earns its 15 seconds rather than a
  generic tour: `splitFinished` auto-hiding a graded-but-still-listed item is real, built, and ready
  — a natural, honest thing to point at on this screen without needing its own beat.
- **Beat 3 — Click an assignment, watch what's connected pop up.** Real, built evidence-linking
  (modules/pages/files capture, the deadline resolver, exact supporting links per
  `implementation-status.md`) shown as a reveal: click one assignment, its syllabus policy, linked
  lecture material, and resolved due date animate in around it.
- **Beat 4 — CS-heavy student vs. reading/writing student, side by side.** Replaces the old
  split-POV catch beats with something that needs far less from Ben: not a specific "caught that"
  moment, just his real CS account running next to Sean's real Econ/DS account, same app, same
  moment. Still proves "not overfit to Ben's 5 tuned courses" — the actual point of the old
  structure — with a much lower bar to clear. **This removes the beat-3 blocker on Ben** (see Open
  questions).
- **Beat 5 — Privacy/differentiation**, same substance as before (read-only, local-first, you choose
  what's shared) but now built around the real MCP mechanism: a client granted one course/category,
  then revoked, live.
- **Beat 6 — Close**, unchanged in substance (logo in, price out, DoIT-invite ask direction).

- **Key moment, redefined:** no longer one scripted "oh, it caught that" line. The evidence is now
  structural — watch it connect things live (beat 3), watch it work identically for two different
  kinds of students (beat 4) — rather than a single anecdote. Still concrete evidence over a feature
  tour; the delivery mechanism changed, not the "show, don't tell" principle.

## Constraints (from buildfest.md + repo docs)

- Hard cap: 2 minutes.
- Due with the repo Sun 9/27 11am.
- Can't claim capability that isn't real (repo, docs, and video all get audited together per the
  opening-slide note). No "invented confidence" — matches the product's own no-fabrication rule.
- Judged on user insight, solution fit, technical execution, communication, differentiation,
  real-world potential — pick beats that carry these, not a feature tour.

## Open questions to answer before drafting further

1. **RESOLVED 2026-09-26 (superseded by Ben, not Sean's branch): lecture-notes fetch is done.**
   Sean built a small metadata-only version on branch `sean/lecture-notes-fetch`, then Ben pushed
   `27782e9` ("Expand local course ingestion...") straight to `main` — a full rewrite of the Canvas
   connector that includes the exact same Modules capture *and* goes further: real file content
   (PDF/DOCX/PPTX text extraction, bounded downloads), not just metadata + deep link. Sean's branch
   was redundant against this and was discarded (never pushed, nothing lost). Current `main`:
   119 tests pass, `pnpm build` passes. **Caveat:** per Ben's own `docs/ingestion-upgrade.md`, this
   is verified against synthetic data only — a real live UW/Canvas session ingesting Sean's or
   Ben's actual account has not been demonstrated yet. That live run is what the race — and now also
   beats 3 and 4 — actually need, and it's still open.
2. **CHANGED 2026-09-26 (blocker lowered, not removed): beat 4 no longer needs Ben's own "caught
   that" moment.** The old beat-3 requirement (a specific documented catch from his 5 CS courses,
   same bar as `canvas-findings.md` finding #1) is gone along with that beat. Beat 4 only needs Ben's
   real CS account running live, side by side with Sean's real Econ/DS account, at the same moment —
   no specific insight required, just two real, current accounts. Much lower bar; still needs the
   live-run item above to be true first.
3. **Race times must be measured, not invented.** Whatever elapsed time each side shows has to come
   from an actual timed run-through once both legs are real — same no-fabricated-confidence rule as
   everything else in this doc.
4. What's shown live on screen (real app, real data) vs. voiceover-narrated over B-roll? Beats 2-3
   are planned as VO-narrated screen capture; beat 4 is silent split-screen with one VO line.
5. Who's on camera / narrating — **beat 1 confirmed: Sean and Ben, both on Macs.** Beat 4's
   split-screen only needs two separate screen recordings (not synchronized in-person filming like
   beat 1) — lower logistics bar than the old plan. Still open: whether either of them narrates on
   camera for any beat, or it's VO-only throughout beats 2-6.
6. **D11 check needs to happen again, for the new structure specifically.** Ben's earlier sign-off
   ("yeah that looks good") was for the split-POV/personal-catch version. The structure changed
   completely on 2026-09-26 — home tour, click-reveal, split-screen comparison, MCP access-panel
   privacy beat — none of which he's seen. Treat this as a fresh "materially different
   interpretation" needing his sign-off, per the team's own AGENTS.md, not a covered decision.
7. **New 2026-09-26: two post-production devices need building, not just recording.** Beat 3's
   "connected evidence" reveal (animated lines from the assignment to its linked material) and
   beat 5's access-granted/access-denied panel are simple editing-tool overlays (title/graphic layers
   in iMovie or similar), not a code-rendered pipeline — doesn't reopen the "no Remotion" decision in
   `production.md` tip #1, but it is real added editing time nobody's budgeted yet. Beat 4's
   split-screen is a standard compositing job, same category.
8. **New 2026-09-26: an MCP client needs to actually be set up for beat 5.** The access-panel demo
   needs a real MCP client (e.g. Claude Desktop) connected to My Magic UW with a real grant (one
   course, `assignments` category only, no `grades`), so it can be revoked on camera. Nobody's done
   this yet; it's a real pre-production task, not just a script line. See the code-grounded plan in
   the notes for the exact tools involved (`due_soon`, the grant/revoke mechanics in
   `packages/core/src/mcp.ts`).
9. **Checked 2026-09-26: BuildFest submission form/video export spec doesn't exist publicly.**
   Fetched the live site (Schedule & Logistics, `faq-about-tel`) directly — deadline (Sun 9/27
   11:00 AM) and "repo + 2-min video + written responses" are the only specifics given. No file
   format, resolution, codec, size limit, or hosting method (YouTube/Drive/Devpost/upload form) is
   published anywhere, and no submission-portal link is listed on the public site either.
   Independently confirmed by Nathaniel's own site research on `docs/research-proposals`
   (`docs/notes/buildfest-rules.md`, unmerged) — same gap, not something I missed. Someone needs to
   check event email/Slack/Discord for the actual submission mechanism rather than the public site.
10. **New 2026-09-26, from Nathaniel's `docs/research-proposals` branch (unmerged): a business-model
   pivot** — $5 one-time licence + bring-your-own-**paid** AI (Claude Pro/Codex/Gemini paid
   key/OpenRouter), replacing the free/local-first/no-paid-plan-prerequisite default in
   `decisions.md`. Nathaniel's own `where-we-differ.md` flags this as a difference, not yet
   reconciled. Doesn't touch the current script (no beat states a price), but if Ben's close/ask
   (beat 6) ends up mentioning cost or "bring your own AI," it needs to match whichever model the
   team actually locks — right now there are two live, conflicting answers on `main` vs. this
   branch.

**Later September 26 correction to item 10:** Ben resolved the pricing/provider conflict with "nathaniels is the way." The accepted direction is now a $5 one-time app license plus the student's own paid AI plan/key; see [the canonical decision](../docs/decisions.md#pricing-and-ai-access-resolution--september-26). The script can continue omitting price. This correction does not approve the revised story, imply working checkout/provider adapters, or update Sean's separate local working copy.

## Narrative arc (rewritten 2026-09-26 — race confirmed, rest is proposal per tip #3)

Open cold on a timed side-by-side race proving the core pitch — everything scattered across
systems, now one place — with a real stopwatch gap, not a claim. Then a plain tour of the home
screen, a reveal of what one click actually connects, a side-by-side proof that the same app works
identically for a CS-heavy student and a reading/writing-heavy one, a privacy beat built around a
real access-grant/revoke mechanism, and a close.

## Beat-by-beat (2:00 total, no slack — race confirmed, rest is proposal)

1. **The race (0:00–0:25) — CONFIRMED.** Two people, side by side at their own laptops, one
   continuous camera shot (not a split-screen edit). Task: open your assignment, then your lecture
   notes. One person on raw Canvas, tabbing between Assignments and Modules/Files; the other on
   My Magic UW, both in one place. Stop the clock, show the real gap. No narration during the race —
   the timer and the visible reactions do the talking; the video's one "what is this/who's it for"
   VO line lands right after, under the end card. Both legs' code is now real, on `main`, via Ben's
   ingestion upgrade (open question #1). **Still blocked on:** an actual live run against a real UW
   session, the real timed numbers from that run (open question #3), and lining up two people + a
   camera at the same time (see `production.md` §2).
2. **Home page (0:25–0:40, 15s).** Plain tour of the real, currently-running home/Today screen —
   not the unbuilt warm/ember redesign, that's a mockup with no live app behind it. One real, already
   built detail earns the 15 seconds: `splitFinished` auto-hiding a graded-but-still-listed item.
   Pop-culture device: none — a clean product-tour beat doesn't need one.
3. **Click an assignment, watch what's connected pop up (0:40–1:00, 20s).** Click one assignment;
   its syllabus policy, linked lecture material, and resolved due date animate in around it — real,
   built evidence-linking (modules/pages/files capture, the deadline resolver, exact supporting
   links). **Pop-culture device: the detective conspiracy board.** Everyone half-recognizes the
   red-string corkboard as a joke (*It's Always Sunny*, every crime-thriller); played straight here —
   thin animated lines connecting the assignment to its real evidence is what the product's actual
   linking mechanism is, not a gag.
4. **CS-heavy vs. reading/writing student, side by side (1:00–1:25, 25s).** Sean's real Econ/DS
   account and Ben's real CS account, same app, same moment, split screen. Does the old
   beats-2-3-and-convergence job in one shot: proves the product isn't overfit to one kind of
   student. **Pop-culture device: the parallel-lives split screen** (*Sliding Doors*, *Freaky
   Friday*-style twin reveal) — same timestamp both sides, one half dense terminal/GitHub windows,
   the other half PDFs and essay drafts, same app open on both. VO: "It reads what your school
   actually publishes, and understands it well enough to help — whether that's five CS courses or
   five completely different departments." **Removes the old beat-3 blocker on Ben** (open
   question #2) — no specific catch needed anymore, just his real account running live.
5. **Privacy/differentiation (1:25–1:45, 20s).** Built around the real MCP mechanism
   (`packages/core/src/mcp.ts`): a client granted one course, `assignments` category only, asks
   what's due, gets a real answer with no grades in it. Then revoked on screen, asks again, gets the
   real block message back, live. **Pop-culture device: the heist-movie access panel**
   (*Ocean's Eleven* / *Mission Impossible*) — a clean "ACCESS GRANTED" moment on connect, a hard
   immediate "ACCESS DENIED" the instant it's revoked. VO: it only reads, never submits/enrolls/
   posts, and the student decides exactly what's shared, down to the category.
6. **Close (1:45–2:00, 15s).** Same substance as before: logo in (Ben confirmed), price left out
   (Ben confirmed), ask tied to something real (DoIT's own "standout projects may be invited to keep
   building with DoIT" line) rather than an unbuilt download CTA. Team name, tracks, repo link,
   logo on screen. **Blocked on:** Ben's actual close/ask wording.

Three pop-culture devices total (beats 3, 4, 5) — beats 1, 2, and 6 stay device-free so the bits read
as intentional rather than a gimmick applied everywhere.

## Shot list and script

Shot list is in [`production.md`](production.md); line-by-line script proposal is in
[`script.md`](script.md). Both rewritten 2026-09-26 to match this structure.
