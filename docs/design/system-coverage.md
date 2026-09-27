# Surface and evidence map

Version 3 · September 26, 2026. **Design maturity is separate from feature implementation.** Consult [implementation status](../implementation-status.md) for production capability. A direction or specimen is not a shipped component. This map does not claim complete project visual approval.

| Surface | Student job / sources | Current design evidence | Next consequential question or test |
| --- | --- | --- | --- |
| Home | Cross-source implications → inspect → start work; captured Canvas, schedule, permitted messages/notes | Near-approved composition; synthetic anchor; explicit behavior recipes | Remaining local polish, live freshness, launch/return and student-confirmation journey |
| Courses overview | Find a course and its current context; stable course records | One-card/course preference and recipe; no approved overview composition | Density, many courses, exact font and return-state checks remain |
| Individual course / assignment | Work with that course's requirements and material; captured IDs and source versions | Shared evidence/action contracts; no approved detail composition | Which course-specific information deserves default prominence |
| Study & Learn | Start specific source-grounded practice; exam/material links and direct learning evidence | Home action language accepted; session composition unspecified | One real question/feedback/source/correction journey; no invented mastery |
| Contextual chat | Ask about current page/course and act on permitted context | Compose purpose and shared evidence contracts; no accepted chat composition | Context disclosure, streaming/interruption, cited answer and return |
| My UW | Access useful UW academic/administrative context; see planning adapters and source constraints | Nav destination accepted; page composition and primary tasks need Ben's input | Define the first useful task before a teammate invents a dashboard; no registration/write capability implied |
| Calendar | Understand commitments; week/month; request study suggestions | View/default/suggestion semantics accepted; Sean's Today domain work reviewed separately | Week/month visual design, overlap/timezone and proposal acceptance flow |
| Profile/settings | Account entry, preferences and actual connections | Bottom profile/expanded name accepted; broader settings composition unspecified | Font/branding configuration and later shell customization; respect real capability boundaries |
| Public website | Understand product → legitimate download or GitHub | Portable brand/type/material roles; current HTML site; no transferred visual proof | Resolve branding divergence with Aiden; independent website render/real link journey |

## Current owners and change impact

Ben owns Home/design direction; Sean's recorded handoff owns Today rail work. Website work is on Aiden's branch; the brand difference needs human resolution. These facts do not appoint a new team-wide design owner. For a shared token/contract edit, identify the integrator in the work packet before concurrent edits. This design-system revision is integrated by Ben's current design agent, scoped to docs/tokens/reference evidence only.

Pin the Git commit plus image filename and token header in a handoff. Document version numbers and asset revisions can differ; a v2 document may correctly reference unchanged Home v1. A later font change affects every text-bearing consumer and wrapping tests. A new Calendar view normally affects its layout and shared event recipe, not Home's prose typography. Recheck only the actual dependency paths and a representative sibling.

## New team input reconciled

The demo script added in `d1af79a` describes automatic session scheduling. Ben clarified in this conversation: **“suggestions on request but make it easy to do so.”** Keep Calendar requests discoverable and low-effort. Proposed interaction: one “Suggest study time” action carrying the relevant course/exam into the request; review proposals and accept selected blocks. Exact label/placement remains provisional. No silent calendar insertion or automatic suggestion flood. Share this clarification with the script/Calendar owners through the existing packet; it is not evidence that every teammate has acknowledged it.

## Validation status

The original Home is a visual anchor, not a full behavior test. Document review and unfinished transfer-validation limits are recorded in [current validation](validation-v3.md). Test artifacts use synthetic content and remain distinct from production. No claim of usability research with students, assistive-technology certification, framework equivalence or integrated Electron/website behavior is made.


## Component-system checkpoint (v3)

D27 accepts the foundation sheet's palette/type pairing for further component refinement. It does not approve every candidate boundary or prove complete screens. Start with the [foundation gallery](lab/foundations.html), then the [working component lab](lab/index.html). Local font configuration is documented in [validation](validation-v3.md); fallback is not a font match.

Shared semantic CSS values now have actual consumers, including general command roles aliased by the earlier review names. A root browser check changed the shared command fill temporarily: six gallery consumers changed and restored together. Exact Cooper/Geist loads were inspected (before the September 27 Lora Medium change). This demonstrates those consumers, not every future framework.

The rejected generated action/overlay images remain rejected. Their guessed fonts/icons and missing context exposed transfer failures; none replace the Home baseline. Current component tests are isolated and synthetic. Home, Calendar, website and real Electron integration retain the limits above.
