# 2-minute video — production plan

Companion to [`story.md`](story.md). That doc is the narrative (what happens and why); this doc is
the runbook (how we actually record, cut, and export it). Don't duplicate beat content here — link
back to `story.md` by beat number and add only recording/editing detail.

**Status:** draft, rewritten 2026-09-26 for the new six-beat structure in `story.md` (race, home
page, click-reveal, split-screen comparison, privacy/access-panel, close — the split-POV
personal-catch beats are gone). Blocked on the same open items as `story.md`: the live UW run,
D11 sign-off on this *new* structure specifically, and live-vs-narrated. Steps below are sequenced
so blocked work doesn't block everything else.

## 0. Before any recording (pre-production checklist)

Do these in this order — later steps depend on earlier ones:

1. **DONE, but not the way we planned: lecture-notes code is on `main` now.** Sean's own branch
   (`sean/lecture-notes-fetch`, metadata-only) turned out redundant against Ben's `27782e9`, a full
   ingestion rewrite pushed straight to `main` that includes the same Modules capture plus real file
   content (PDF/DOCX/PPTX extraction). Sean's branch was discarded — nothing was lost, it was never
   pushed. Current `main`: 119 tests pass, `pnpm build` passes. **Not yet done: a live run against a
   real UW/Canvas session.** Everything checked so far is synthetic-data tests, per Ben's own
   `docs/ingestion-upgrade.md`. Don't shoot beat 1 until someone's actually logged into a real
   account and confirmed both legs work live.
2. **Lower bar now, still real:** beat 4 only needs Ben's real CS account current and working —
   no specific "caught that" moment required anymore (that requirement left with the old beat 3).
   Blocks beat 4.
3. **Confirm with Ben — for the *new* structure specifically:** D11 sign-off (video storyboard
   ownership) on the rewritten beats, and whether he's on camera/narrating. His earlier sign-off
   covered the old split-POV/personal-catch version, not this one. Blocks final lock of beats 2-6.
4. **Decide live-vs-narrated** per beat (see `story.md` open question #4) — determines whether we
   need a mic/voiceover setup at all, or just clean screen capture.
5. **Reset both Canvas accounts to their real current state** (Sean's Econ/DS, Ben's CS) — the race,
   beat 3's click-reveal, and beat 4's split-screen all need real, present data, not a stale or
   cleaned-up account.
6. **Set up a real MCP client connection for beat 5.** Connect Claude Desktop (or another compatible
   client) to Magic Canvas with a real grant — one course, `assignments` category only, `grades` off
   — so it can ask a real question and be revoked on camera. Nobody's done this yet; it's new setup
   work, not just a script line.

## 1. Tooling (recap from `story.md` production approach)

Screen-recording-first, not code-rendered — `magic-uw` has no Remotion/animation tooling installed
and building a rendering pipeline isn't in budget for a 24h window. Concretely, on Mac:

- **Capture:** QuickTime Player screen recording (`Cmd+Shift+5`) or, if we need two audio sources
  or picture-in-picture cleanly, OBS Studio (free, more setup). Default to QuickTime unless a beat
  needs OBS's extra control.
- **Edit:** iMovie (already on the Mac, free, sufficient for cuts/captions/trim-to-2:00) unless
  someone already has a Premiere/Final Cut/CapCut license and workflow they're faster in.
- **No new dependency gets installed in `magic-uw` for this.** The video's tooling lives outside the
  product repo entirely.

### Optional AI help: references Ben shared

Ben shared these posts as possible methods for making or polishing parts of the video. They are
references, not a requirement to use Opus 5.5 or to change the six-beat story. Screen recording
remains the default. Try AI help only if it improves a specific shot or saves production time while
staying within the two-minute runtime cap.

| Post | What the author shows or says | Possible use here |
| --- | --- | --- |
| [Leo's launch-video tips](https://x.com/leodev/status/2102897952587133299) | The seven tips already assessed against this repo in [`story.md`](story.md#production-approach-launch-video-tips-applied-2026-09-26): compare tools, direct the narrative beats yourself, and give an agent the actual codebase and visual context. | Keep the confirmed race, proposed later beats, and real product material in the brief; use an agent for a bounded edit or graphic rather than asking it to choose the demo's claims. |
| [Moritz's example](https://x.com/moritzkremb/status/2103066071838466494), [prompt](https://x.com/moritzkremb/status/2103066083905417476), and replies | Moritz says he gave Opus 5.5 one broad prompt to pick a recognizable SaaS, gather real web assets, and make a polished motion-graphics launch video about its features and benefits. He says he supplied [only the prompt](https://x.com/moritzkremb/status/2103201184185983001) and [named HyperFrames](https://x.com/moritzkremb/status/2103181107466567815) in the comments. His posts do not document the full build or revision process. | A quick way to request a visual treatment or motion concept. Treat the result as a candidate for a short segment, then check it against the real app and story. |
| [Shann's finished example](https://x.com/shannholmberg/status/2103057568402960791) and [how-to guide](https://x.com/shannholmberg/status/2103173892831674715) | Shann describes using Opus 5.5 for scene planning, screen recording, animation, and editing, with Codex generating an image when needed. His method starts with the goal, audience, format, brand context, and examples; reviews a scene-by-scene storyboard; renders a preview; and revises with timestamped feedback, including audio direction. The example shows product UI, guided movement, and short captions. | Give an agent the current beat plan, real screen captures, and available brand assets, while keeping unapproved beats labeled as proposals. Review the storyboard before rendering; generate supporting graphics only where they clarify a real interaction. |

If anyone wants to try this, test **one short proof segment** first, such as beat 3's assignment
click and evidence reveal. Compare its readable product detail, editing time, and factual accuracy
with a straightforward cut of the same footage. Keep the treatment only if it helps. Any generated
image or motion layer should support the recorded interaction; it must not depict an unbuilt screen,
invent linked evidence, or turn an unverified capability into a video claim.

## 2. The race (beat 1) — recording method

**Changed 2026-09-26 per Sean: not a software split-screen edit. Two real people, filmed together,
one continuous shot.**

- **Setup:** two laptops side by side on the same table/desk, two people, one camera (phone on a
  tripod works) framed wide enough to see both screens and both people at once. This is a physical
  filming problem, not a screen-recording one — no window arrangement, no picture-in-picture editing.
  **Confirmed 2026-09-26: it'll be Sean and Ben, both on Macs.** Same OS on both laptops simplifies
  this — either MacBook's built-in webcam, an iPhone via Continuity Camera, or one external
  phone-on-tripod all work the same way regardless of which laptop is which.
- **Timer:** one visible, physical or on-screen timer that both people can see and react to —
  simplest is a phone stopwatch propped up between the two laptops, in frame. Avoid two separate
  stopwatches (harder to keep both legible on one wide shot, and invites the appearance of two
  edited-together clips even if it's actually one take).
- **Take:** start the timer, both people go at once on their own laptop (one raw Canvas, one Magic
  Canvas), each says "done" or raises a hand when they've got both the assignment and the lecture
  notes open, camera stays rolling throughout. One take, not cut together from two recordings — the
  reactions and the real gap are the point.
- **Do a few practice runs before the take that counts** — this is a live human task, not a script;
  expect some variance, and the first live run of each leg (see §0.1) may be slower than a fifth run.
  Decide before shooting whether the number that goes in the video is the first real attempt or a
  practiced one, and disclose which (per `story.md`'s no-invented-confidence rule, don't imply a
  cold-start number if it's actually a rehearsed one).
- **Who does which side:** participants confirmed (Sean, Ben), but not which side each takes — and
  that choice matters more than it looks. A one-off race where the naturally-faster clicker happens
  to land on Magic Canvas isn't real evidence, it's a coin flip dressed up as a demo; a skeptical
  judge would have the same objection. **Recommend running it twice, sides swapped** (Sean on Magic
  Canvas / Ben on raw Canvas, then the reverse), and using whichever take is cleanest — or showing
  the gap holds both directions, if there's room. Either way, disclose the setup rather than pick
  the flattering take and call it the only run.

**Non-negotiable regardless of setup:** the numbers shown must come from an actual timed run,
recorded after both legs (real assignments, real lecture notes) are working live — this is
`story.md` open question #3.

## 3. Shot-by-shot (rewritten 2026-09-26 for the new structure — fill in once blockers above clear)

| Beat | Story ref | What's recorded | Post-production | Status |
| --- | --- | --- | --- | --- |
| 1. The race | `story.md` beat 1 | Two-person physical shot per §2 above (not split-screen) | End-card text overlay only | Code is on `main`; needs a real live-session run, side-assignment decided, + the actual timed numbers from it |
| 2. Home page | `story.md` beat 2 | Screen capture, current running app (not the unbuilt redesign), `splitFinished` visible | None beyond a standard cut | Ready to shoot once accounts are reset (§0.5) |
| 3. Click-reveal | `story.md` beat 3 | Screen capture: click an assignment, its linked material/policy/due date | **New:** animated connecting-line overlay (conspiracy-board effect) — needs building, see §0.7 in `story.md` | Needs the live-run item (§0.1) so there's real linked material to reveal |
| 4. CS vs. reading/writing split | `story.md` beat 4 | Two separate screen recordings, Sean's and Ben's real accounts, same moment | **New:** split-screen composite, synced | Blocked: Ben's account current + reset (§0.5); no longer blocked on a specific catch |
| 5. Privacy/access-panel | `story.md` beat 5 | Screen capture of a real MCP client (Claude Desktop or similar) making a request, then being revoked | **New:** "ACCESS GRANTED" / "ACCESS DENIED" graphic overlay | Blocked: MCP client + grant needs setting up first (§0.6) |
| 6. Close | `story.md` beat 6 | TBD — depends on what Ben wants the ask to be | Standard title-card overlay (team/tracks/repo/logo) | Blocked: Ben's wording |

## 4. Script

Draft proposal is in [`script.md`](script.md), rewritten 2026-09-26 for the new structure — assumes
voiceover narration for most beats (unconfirmed, see §0.4). One beat is still an explicit
placeholder there (the close/ask) — don't record against it until Ben fills it in for real.

## 5. Post-production and export

1. Assemble clips in beat order, trim hard to **2:00 or under** — the event's own cap, not a
   suggestion.
2. **New editing work, not just cuts:** beat 3 needs an animated connecting-line overlay
   (conspiracy-board effect linking the assignment to its evidence), beat 4 needs a synced
   split-screen composite, beat 5 needs an "ACCESS GRANTED"/"ACCESS DENIED" graphic overlay. All
   three are ordinary title/graphic layers in iMovie or similar — not a code-rendered pipeline, so
   this doesn't reopen the "no Remotion" decision — but budget real time for them; they're not a
   plain trim-and-cut job like the old version of this video was.
3. Captions/on-screen text: course names, "N finished items hidden" style callouts, and (for beat 1)
   the timer if using Option B — keep text on screen long enough to actually read.
4. Export at whatever resolution/format the BuildFest submission form specifies — **checked
   2026-09-26: no spec is published anywhere on the public site** (see `story.md` open question #9).
   Check event email/Slack for the actual submission mechanism instead.
5. Submit alongside the repo and written responses by **Sun 9/27 11:00 AM** (`magic-uw/docs/buildfest.md`).

## 6. Open items carried from `story.md`

Don't duplicate the full list — see `story.md`'s "Open questions" section, which is the single
source of truth for what's still blocking. Update both docs together when one of those resolves.
