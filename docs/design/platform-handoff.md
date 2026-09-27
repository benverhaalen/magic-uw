# Platform and team handoff

Inspected September 26, 2026 at main `9302865`. Read-only code review plus published CI status where stated; no integration or new runtime testing. Refresh relevant refs before acting on this snapshot.

## Shared language, appropriate platform behavior

Share identity, font roles, semantic colors/gradients, icon grammar, spacing, borders, focus, component meanings and state contracts. Share screenshots and synthetic content examples. Keep recipes framework-neutral; implement idiomatically in the target framework. Recognizable consistency is the goal, not identical raster output across OS font renderers.

**Desktop:** existing React renderer, isolated Electron preload/main, utility worker and SQLite. `packages/contracts/src/index.ts` defines `Snapshot`, validated `Command`, results and `AppBridge`. Preserve `contextIsolation`, sandboxing and no Node in renderer. UI work must not widen IPC or school-changing capabilities. Stable resource/evidence identity lives below visual components.

**Website / Aiden handoff:** `apps/web/index.html` is an informational/download/GitHub page. Its journey is understand value → inspect availability/privacy → obtain the app when available. Apply the palette, type and interaction quality to that journey, without copying Mac traffic lights, a student sidebar, pretend live data or unavailable download claims. No alternate website framework was established in the reviewed branch; inspect Aiden's actual work before selecting dependencies. If using React, reuse suitable accessible primitives; do not introduce Tailwind/shadcn solely because a reference skill names them.

**Fonts:** exact Cooper Light BT in local mocks; Geist for interface text. Font binaries are not included. Resolve lawful production availability before shipping the exact font or agree a replacement using real screenshots and matching hierarchy. Do not claim a fallback matches the accepted reference. Do not derive a replacement typeface from the screenshot.

## Later minimum Electron integration slice

Reuse the existing app, not a second shell project. Entry without saved data is an honest empty Home. For a labeled synthetic sample or existing saved data: **Home → named resource → useful requirements/material detail → original source → return to preserved Home position/focus → semantically appropriate local completion + Undo → restart with state intact**. Deleted targets and failed refresh retain useful context with truthful recovery. A conflict acknowledgement needs its own stable issue semantics; existing generic item completion is not automatically suitable.

Integrate through renderer → preload → main → worker → core → SQLite. The browser preview uses real core/store with synthetic data but disables native external opening/import; it cannot prove native launch. Existing production styles use a system stack and the flagship mock remains separate. Live briefing synthesis, prepared multi-app launch, context chat and generated learning output are not completed by this foundation.

Recommended seams: shared shell and tokens; feature-local views; stable resource routes; one data subscription; explicit action adapters with capability/error state; saved confirmations separate from view state. Begin with the existing architecture and a few coherent components rather than a general plugin/router/state framework. New features provide their input/actions and default/loading/partial/error examples; polish can proceed through shared roles while feature modules grow independently.

Future evidence: actual rendered default/loaded/partial states, keyboard/focus return, resource identity after refresh, persistence after restart, recovery after bridge failure, plus headless Electron smoke through real storage. Tests for new semantics support this journey; a static screenshot does not demonstrate it.

## Sean's calendar work

[Reviewed code bfcad148](https://github.com/benverhaalen/magic-uw/commit/bfcad1481e337b4d9d76865b62818c6b9975af48) is three commits ahead of inspected main, Sean-authored and unmerged. Its [CI test/build check](https://github.com/benverhaalen/magic-uw/actions/runs/36284474447) passed; this foundation review did not run the UI. No calendar PR was present at the initial inspection; the latest check now finds [PR #2 open](https://github.com/benverhaalen/magic-uw/pull/2), with head `b1d2178`. A later fetch found branch head `b1d2178`, which adds documentation only; its source changes were inspected and the code findings below remain applicable. Main subsequently added Sean’s Today-rail handoff at `9616597`, identifying Sean as rail owner and Ben as designed-Home owner. No runtime code from that PR is merged by this foundation. Those branch docs now explicitly distinguish implemented Today behavior from proposed scheduling rules. Their headless interaction tests are author-reported evidence, not rerun in this foundation review.

It builds **Home's Today rail**, not a full Calendar page. Reusable mechanisms: `TodayRail.tsx`, domain daily projection, persistent accept/edit/skip, local study reports distinguished from source submission. Keep one event/deadline/plan identity across Home and future Calendar. Adapt presentation to the accepted shell rather than import its legacy third-column layout and small labels.

Before integration inspect these concrete gaps:

- `packages/domain/src/today-rail.ts` selects newest course material for prep; recency alone does not establish assigned or relevant reading.
- `TodayRail.tsx` says “Nothing due today” without complete coverage, and uses latest success across sources for freshness. Use source-specific freshness and qualified empty states.
- Suggested minutes are included in a “planned” total. Proposed versus accepted work must remain distinct.
- Feed recurrence expansion is absent; inspect exclusive all-day ends, overnight/overlapping events, locations and partial meeting coverage. A missing event is not free time.
- Event blocks lack useful click-through and complete working-context launch; full Calendar has no route/week/month behavior yet.

**Accepted September 26:** Calendar opens to the current week and offers both week and month views. Show real commitments and accepted study blocks, with suggestions on request. Home retains its compact Today projection. Ben's reply to the proposed week-first/on-request behavior: “yes but both a week and a month view with suggestions on request”. This settles the view choice, not the unimplemented interaction details or code readiness.

## Other upstream findings and human conflict

`northcutt-frontend` at `3dc26e7` contains logo assets and research inventory, not a separate frontend implementation. Its logo README proposes Fredoka SemiBold; Ben's accepted Home uses Cooper and no logo. This may be an intentional website distinction or an unresolved opinion. Ask the affected humans directly rather than replacing either artifact. Branch activity does not confirm present ownership.

[PR #1](https://github.com/benverhaalen/magic-uw/pull/1) is research/specification, not shipped learning features. Its backend map targets earlier schema v3; inspected main includes planning schema v4. Reconcile references before adopting migration/API proposals. Current paid-AI/consent resolution is already on main; do not revive superseded disagreements.

When integrating, refresh relevant refs and state the commit used. Agree who owns shared shell/contracts, then use bounded feature handoffs. A pull makes guidance available, not automatically consumed. An agent should acknowledge applicable changed constraints at its next natural boundary, continue its main task, and delegate an independent review only where useful.
