# Video subproject — the 2-minute submission video

**This folder is a shared, team-visible copy** (added 2026-09-26) so Ben and teammates can see and
edit these docs through the repo instead of Sean's local machine. The working copy with the full
decision log and dated notes stays at `Desktop/buildfest/references/video/` on Sean's machine — if
you change one, update the other; they should stay identical. Two interactive companions exist
outside the repo (not committed — see the repo's no-unredacted-capture rule below): a
[shot-list checklist](https://claude.ai/artifact/RndYADbw6HoY2LxMdGuoBk) and a
[scrubbable script preview](https://claude.ai/artifact/1Hzpjs2jDiexJnnQJ3TyrG).

Why this is separate from the main context.md: the video is its own deliverable with its own
deadline (Sun 9/27 11am, same as repo + written responses — see `magic-uw/docs/buildfest.md`),
and needs its own draft-and-revise cycle before it's locked. Folder moved from
`Desktop/Context/buildfest` to `Desktop/buildfest` on 2026-09-26; this project doesn't use the
Context/work-folder split, everything lives here.

## What this covers

The story/script/storyboard for the 2-minute demo video, from first cut of the narrative arc
through shot list to final script. Not the actual video file or raw footage — those live wherever
the team keeps recording assets, not in this Context folder (see the repo's rule: no unredacted
captures or private data in Git).

## Judging context this story has to hit

Per `magic-uw/docs/buildfest.md`, judges score on: user insight, solution fit, technical execution,
communication, differentiation, real-world potential. Applied AI judges want engineering choices +
failure handling + evidence; DoIT judges want learning value + integration boundaries +
maintainability. The video is the communication axis — it has to carry the other five in under
2 minutes, not just narrate features.

## Ownership note

An earlier, now-deleted duplicate `context.md` flagged D11 ("video storyboard") as a decision Ben
deliberately deferred. That's not logged in `magic-uw/docs/decisions.md` as of 2026-09-26, so treat
it as Sean's early tracking, not a confirmed current-state fact. Flag the story direction to Ben
before treating it as locked, same as any other materially different interpretation.

## Files

- `story.md` — working draft: narrative arc, beats, what's shown live vs. narrated, open questions.
- `script.md` — proposed narration and on-screen text for those beats.
- `production.md` — capture, editing, and export plan, including [optional AI video references](production.md#optional-ai-help-references-ben-shared).
- [`higgsfield/README.md`](higgsfield/README.md) — animated Wiz segments: Higgsfield prompts, SVG-built pose assets and the second-by-second timeline.
