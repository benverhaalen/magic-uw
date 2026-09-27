# 19 — Desktop work stopped: integration handoff for Nate

Recorded September 27, 2026, 14:25 UTC. Owner: Ben's desktop integration agent. Recipient: Nathaniel/Nate and his agent. Base: main `034c3ec`; local branch `codex/desktop-design-integration`. Ben explicitly stopped implementation and authorized these handoff packets only. No worker should resume from this packet without human direction.

## What is published

Main includes `b674f44` (Calendar export, task source investigation, assignment footer cleanup, contextual voice) and `0fe763a` (Calendar omission copy while date conflicts are hidden). Main `034c3ec` adds the BuildFest Break Card link. Published code is not a claim that every live journey works. See packet 18 and docs/design-handoff.md for earlier integration boundaries.

## Local integrated work, NOT published

The canonical desktop checkout on Ben's machine contains uncommitted integration changes. They are preserved, not discarded or included in this docs-only publication:

- Account-scoped durable chat history and Study chat consumers, with inline artifact/video/source handling and one composer.
- Typed Study target and syllabus-purpose policy checks. A login wrapper around a syllabus does not establish that the syllabus has no AI policy.
- My UW planning chat with selected-context preview and approval before sharing.
- Assignment-version-bound investigation results, task-owned browser tab handling, instructions-first task setup, and course-scoped GitLab/tool relevance.
- Home exam eligibility correction for named exams that are not Canvas quizzes.

The combined source passed full TypeScript and desktop/website builds and 76 focused integration tests before the final exam/setup deltas. Those final deltas passed 21 focused tests. The final combined WIP has not had a fresh full build. Do not promote it solely on the older build receipt.

## Remaining delivery gaps

| Workstream | Existing evidence | Still incomplete / next boundary |
| --- | --- | --- |
| Study and saved chats | Integrated source and focused tests; native Recent chats → New chat → course picker → contextual composer observed | Connected artifact generation, video usefulness, policy-aware follow-up and restart journey need end-to-end evidence. Home still selected menial tasks and raw course names in the observed build. Private corrections await integration. |
| Task workspaces | Published source investigation plus local version/tab/setup corrections | Automatic specific GitLab project selection unfinished. Actual default-browser split placement and restore/close not proven. Read packet 20. |
| Voice computer use | Mic/prewarm/local Whisper and shared navigation code | Human mic → rolling transcript → connected agent → observed computer action → Stop is not demonstrated. Jev/connected-agent generic fallback incomplete. |
| Calendar / Google export | Lectures observed in Calendar; export code published | Automatic ICS attachment and separate lecture/assignment/exam calendars need actual Google import verification. No completed personal-browser import was observed. |
| Daily Brief / Home relevance | Existing briefing/action and deadline projection work | Study selection must use meaningful preparation goals; course source relationships remain incomplete. Keep date-conflict UI hidden per Ben's temporary decision. |
| My UW planning | Local approved-context chat integration | Real connected-provider answer not demonstrated. Retain preview/approval for selected academic planning data. |
| Provider / policy / data integration | Policy and account guards integrated locally | Connected-only reasoning candidate has unresolved current-WIP conflicts and is NOT integrated. All reasoning must use connected Claude Code/Codex; local transcription is the sole exception. |

## Private handoff artifacts available on Ben's machine

These paths are relative to the task's `work/desktop-build/parallel/`; they are not downloadable from this public repo. Ask Ben's integration agent for a reviewed scoped patch when resuming, rather than copying old App/store/worker files wholesale.

- `study-delivery/study-integrated-b674.PENDING.patch` and `study-store-myuw.PENDING.patch`: already applied locally, not published.
- `study-delivery/chat-home-correction/home-goal-correction.incremental.patch`: private correction, not applied. Reported private TypeScript and five tests pass; rejects menial quiz/discussion metadata alone as a study goal.
- `study-delivery/chat-home-correction/chat-date-inline.incremental.patch`: private correction, not applied. Restore hidden-date gate and inline citations. Review the citation label JSX for a stray literal dollar sign before adoption.
- `opus-roadmap/connected-only-ai/connected-only-ai.patch`: candidate only; current-WIP conflict review unfinished.
- `opus-roadmap/study-opportunity-job-completion/`: producer and worker-binding candidates plus proposal-only Home consumer; 21 producer checks reported. No integrated job/Home claim. Lecture-session-to-reading linkage is still missing.
- `voice-native-browser-adapter/browser-adapter.patch`: private native transport; live browser behavior unverified.

## Integration precautions

Nate retains ingestion/backend ownership. Main/preload/worker, App, Home, ChatPane/store, StudyPrep contracts/core, and MyUwPage are overlapping interfaces. The local diff must be reconciled, not overwritten from a private snapshot. Preserve account/source versions, policy enforcement, selected planning-context consent and Nate's existing producer contracts. No personal coursework, cookies, keys, capture or chat transcripts belong in Git.

The isolated QA app was built before the final setup/exam deltas and uses a copied populated profile without connected-client credentials. Its missing-provider message is not proof that Ben's normal connection is broken. Computer use is stopped. No live microphone, external browser workspace or planning-data send was performed in that QA pass.

All active and orphaned Opus CLI workers were terminated; coordinator verified no remaining `claude -p` worker processes. The goal is paused. Existing WIP and private artifacts are preserved.
