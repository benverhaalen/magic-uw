# Component-system validation · v3

## Scope and status

[Foundation sheet](assets/foundations-v3.png) palette/type pairing accepted by Ben at D27: “Yes, refine the components”. Component refinements are demonstrated in the isolated lab and await Ben’s visual feedback. This is an isolated HTML/CSS/JavaScript design laboratory, not a shipped React/Electron package. Earlier [v2 audit](validation-v2.md) remains historical evidence.

## Reproduce

Serve the repository through a local static server and open `docs/design/lab/foundations.html` or `index.html`. Karma Medium loads from `packages/ui/assets/fonts` by default. Add `?fontBase=<same-origin-local-font-directory>/` with a separately permitted `Geist-Variable.woff2`. The Geist path permits local same-origin use only; the loader reports which faces loaded, and fallback does not validate visual identity. All coursework and saves here are synthetic/local fixtures.

## Evidence inspected by the integrator

- Original Home compared against the component screenshot. Typography, icons and shared shell correction were checked; inconsistent time wrapping, oversized detached actions and local palette overrides were sent for repair.
- Both exact font faces (then Cooper Light BT and Geist) loaded in a separate browser session in the lab and foundation gallery.
- Six gallery command-fill consumers all changed when the shared token changed, then all restored when removed. This checks a real dependency, not just token declarations.
- Dialog opened; Adjust time focused its date field; Escape closed and returned to the trigger. After the final repair, the integrator verified invalid end-time validation, Escape dismissal, and reopening: the draft remained, stale errors and aria-invalid cleared, and initial focus returned to the explanatory title.
- A note survived a simulated save failure with its exact text. Retry produced success and the inspected localStorage value.
- Acknowledgement produced local self-report with persistent Undo; Undo returned the checkbox to false and restored focus. This never confirms coursework completion or instructor approval.

## Independent specialist review

Claude Opus 5.5 ran through the CLI; receipt reported canonical model `claude-opus-5-5`, provider `firstParty`. It inspected source and reference/candidate images, not a live browser. Six findings covered detached/fixed-size actions, a second palette and layered CSS, ambiguous quiet/disabled states, incomplete shell examples, missing component families, and dialog context/focus. Supported issues were routed to code and shared tokens. Reviewer agreement is not visual approval. Private full receipts are retained locally; this summary records scope without loading raw conversation.

## Remaining evidence

A fresh scoped builder produced [a source-refresh component](lab/connection-example.html) from the compact system without a bespoke layout. The integrator independently observed failure retaining the timestamp and two saved items; retry advanced the timestamp only on fixture confirmation. Content rules now include four synthetic input/output examples with evidence checks; no live content generator was implemented. The final worker checked pending-action focus, menu selection, exact fonts, narrow reflow and updated screenshots. The integrator inspected the revised full-family sheet and independently repeated the repaired dialog recovery path. Framework integration, complete Calendar/week/month views, public website composition, real services, student usability testing and assistive-technology certification remain unproven. New feature families need their own scoped verification; the finite system does not claim universal coverage.

## Earlier refinement review

A second verified Opus 5.5 pass inspected the compact source adapters, rules and component code; it did not open a live browser or re-read every upstream skill. Supported findings corrected synthetic date/source inconsistencies, shared token consumers, pending focus and stale dialog errors. The final [component sheet](assets/components-v3.png) is a candidate for feedback, not a new whole-page layout or accepted replacement for Home.

## Direct original-source follow-up

The [direct-source audit](audit-v3-direct-sources.md) supersedes earlier blanket impressions of completeness. It separates original-source coverage, repair evidence and independent live testing. The original 31-file review found real state/routing/identity gaps despite earlier checks. Exact source packets improve fidelity; they do not replace exercising the actual UI. Historical screenshots and the 84px action minimum are not current component specifications. The action-size comparison is a candidate for the unresolved footprint preference.

The follow-up now includes three actual Opus browser workers plus integrator rechecks. See its coverage table for bounded passes, recovered reports, untested cases and rejected recommendations. Current live specimens supersede historical screenshots for repaired interaction behavior.
