# 2-minute video — script proposal

**Status: PROPOSAL, not locked. Rewritten 2026-09-26** for the new six-beat structure in `story.md`
(race kept, personal-catch/split-POV beats scratched, replaced by a home tour, a click-reveal, a
split-screen comparison, and an MCP-based privacy beat). One thing here is still a placeholder
because the real content doesn't exist yet (bracketed, marked clearly) — everything else uses real,
verified product behavior, matching the no-invented-confidence rule in `story.md`'s Constraints.

**Assumption used below (unconfirmed):** short voiceover narration over screen capture for most
beats, one narrator; beat 4 is silent split-screen with a single VO line. This is the
cheapest/fastest option and doesn't require solving an on-camera setup — but `story.md` open
questions #4/#5 (live-vs-narrated, who's on camera) are still open. Confirm or override before
recording.

---

## Talking points — for whoever narrates or fields live judge Q&A

Same what/who/how the VO lines below carry, as quick-reference bullets rather than a script — use
these to stay consistent if a judge asks a follow-up during the 1–3 PM live demo slot, since they
won't hear the VO again:

- **What:** one desktop app that pulls everything your school already gives you (Canvas now, more UW
  systems later) into one place, so you're not tabbing between tools to find what's actually due.
- **Who:** UW students broadly — not a CS class project tuned to one person's own courses. Beat 4
  (the split-screen comparison) exists to prove that, not just claim it.
- **How:** it reads real source material — assignments, syllabi, lecture files — and understands it
  well enough to connect what matters (beat 3) and work identically across totally different course
  loads (beat 4). Nothing guessed or invented; every connection traces back to a real, checkable
  source.
- **What it isn't:** not a Canvas skin, not a chatbot wrapper, not a hosted service reading your data
  — read-only, local-first, and (per beat 5) you choose exactly what's shared, down to the category,
  and can shut it off instantly.

---

## 0:00–0:25 — The race

**Visual:** One continuous camera shot (not a split-screen edit) — two people side by side, each at
their own laptop, one shared visible timer propped between them. Wide enough to see both screens
and both people's reactions. See `production.md` §2 for the physical setup.

**On-screen text (title card, before the take):** `Same tasks. Same morning. One shared clock.`

**Action (live, one continuous take):**
- Timer starts, both people go at once.
- Person on raw Canvas: opens the assignment through Canvas's own navigation, then finds the
  lecture notes (switches to Modules or Files).
- Person on Magic Canvas: same two tasks, both already surfaced in one view.
- Each says "got it" or raises a hand when they have both open; camera keeps rolling until both are
  done.

**On-screen text (end card, added in edit):** `Canvas: [REAL TIME FROM LIVE RUN]  ·  Magic Canvas: [REAL TIME FROM LIVE RUN]`
— **placeholder, not invented.** Fill in only after the live run in `production.md` §0.1/§2, and only
with the real number from that specific take (not a rehearsed best-of, unless disclosed as one).

**VO — layered under the end card, once the timer stops (~0:20–0:27):**
> "This is Magic Canvas — one place for everything your school already gives you, built for every
> Badger, not just one kind of student."

This is the video's only explicit "what is it / who is it for" statement — everything before this is
silent (timer + reactions only), and everything after is evidence, not explanation. Costs no added
runtime: it fills dead air already sitting under the end card, so beat 1 still opens cold.

**Pop-culture device:** none. The stopwatch is already its own identity; no bit needed here.

---

## 0:25–0:40 — Home page

**Visual:** Cut to the real, currently-running home/Today screen — the actual shipped app, **not**
the unbuilt warm/ember redesign in `docs/home-design-direction.md` (that's a disconnected mockup,
nothing live sits behind it — don't shoot against it). Plain product tour: what's due, what's next,
what's changed.

**VO (proposed):**
> "Everything lands in one home screen — what's due, what's next, what changed since you last
> looked."

**On-screen:** as the screen is shown, one real, already-built detail earns its 15 seconds instead of
a generic tour: `splitFinished` auto-hiding a graded-but-still-listed item, with the line **"2
finished items hidden."** (Same real behavior that used to anchor the old "Sean's catch" beat — now
just one detail on the home screen, not its own explained beat.)

**Pop-culture device:** none. Clean product tour.

---

## 0:40–1:00 — Click an assignment, watch what's connected pop up

**Visual:** Click one real assignment. Its syllabus policy, linked lecture material, and resolved
due date animate in around it — real, built evidence-linking (modules/pages/files capture, the
deadline resolver, exact supporting links per `implementation-status.md`).

**VO (proposed):**
> "Click one, and everything connected to it shows up with it — the reading, the policy, the actual
> due date. Not just a title in a list."

**Pop-culture device: the detective conspiracy board.** Everyone already half-recognizes the
red-string corkboard as a joke (*It's Always Sunny*, every crime-thriller cold open) — play it
straight here. In the edit, thin animated lines draw from the assignment card out to its linked
evidence as each piece appears, exactly like a conspiracy board reveal. The joke-turned-real framing
is the point: this is what your semester actually looks like connected, and the app draws the
strings, not a person on a corkboard. **Needs building in post** (see `production.md` §5.2) — not a
straight screen-recording cut.

---

## 1:00–1:25 — CS-heavy student vs. reading/writing student, side by side

**Visual:** Split screen, same timestamp on both sides. One half: Sean's real Econ/DS home screen.
Other half: Ben's real CS home screen. Both running Magic Canvas at the same moment. **Two separate
screen recordings composited together in post** — doesn't need synchronized in-person filming like
beat 1.

**VO (the video's "how it works" + "who it's for" statement, one line):**
> "It reads what your school actually publishes, and understands it well enough to help — whether
> that's five CS courses or five completely different departments."

**Pop-culture device: the parallel-lives split screen** (*Sliding Doors*, the *Freaky Friday*/
*Parent Trap* twin-reveal). Same timestamp burned into both halves. One side dense terminal windows
and GitHub activity, the other side PDFs and essay drafts — visibly different worlds, same app,
same moment. This is the beat's whole argument: not stated, shown.

**Note:** this beat no longer needs a specific "caught that" moment from Ben — just his real,
current CS account running live, side by side with Sean's. Removes the old blocker on Ben supplying
a documented catch (`story.md` open question #2).

---

## 1:25–1:45 — Privacy / differentiation

**Visual:** A real MCP client (e.g. Claude Desktop) connected to Magic Canvas with a real grant —
one course, `assignments` category only, `grades` off. It asks what's due this week, gets a real
answer back with no grade data in it (grounded in `packages/core/src/mcp.ts`'s `due_soon` tool and
its per-category permission check). Then, on screen, the connection is revoked in Magic Canvas's
Data & AI view — the same client asks again and gets the actual block message back, live: *"This
read was blocked or unavailable. Check the connection's course and data permissions in Magic
Canvas."*

**Pop-culture device: the heist-movie access panel** (*Ocean's Eleven* / *Mission Impossible*). A
clean "ACCESS GRANTED" graphic the moment the first real answer comes back; a hard, immediate
"ACCESS DENIED" the instant it's revoked. **Needs building in post** — a simple title/graphic
overlay, not a code-rendered effect (see `production.md` §5.2).

**VO (proposed):**
> "And it only reads. Magic Canvas never submits, enrolls, or posts anything for you — you decide
> exactly what it can see, down to the category, and you can shut it off instantly."

---

## 1:45–2:00 — Close

**[PLACEHOLDER — BEN TO CONFIRM THE ASK.]** `story.md` beat 6 leaves this open (track fit line, live
demo invite, something else). Draft shape below, replace once Ben decides:

**Confirmed for this beat:** the wizard logo (v0.1, Aidan's pack) goes in — Ben signed off. Price
stays out of the video, either business-model version.

**VO placeholder shape:**
> "Magic Canvas — school, finally in one place. [Ben's actual ask/close line here.]"

**Proposed direction:** no installer, distribution, or landing page exists yet — skip a "go download
it" CTA. Tie the ask to something already real instead: DoIT's own track note that "standout
projects may be invited to keep building with DoIT."

**On-screen:** team name, BuildFest track(s) entered, repo link, logo mark.

---

## Recording notes

- Every VO line above should be read against the **actual on-screen action**, not recorded in the
  abstract — if the real screen doesn't match what a line claims, fix the line, not the claim.
- Total as drafted: 2:00 flat against the beat timings in `story.md`. There's no slack — if Ben's
  close beat needs more than 15 seconds, something upstream has to shrink. Beat 2 (home page, 15s)
  is the least evidence-dependent and the easiest to trim first.
- **New since the rewrite:** beats 3 and 5 both need a post-production graphic overlay built before
  they can be finished (the connecting-line reveal and the access-granted/denied panel), and beat 5
  needs a real MCP client connection set up before it can even be recorded (`production.md` §0.6).
  Neither is a plain screen-capture-and-cut job anymore.
- Once the close beat is filled in with real content and the live-vs-narrated decision is confirmed,
  this whole file should be re-read end to end for tone consistency before anyone records against it.
