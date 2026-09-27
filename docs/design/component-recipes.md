# Reusable component recipes

Version 3 · A finite first set for Magic desktop and website work. Recipes describe meaning, anatomy and behavior across frameworks; they are not a universal component package. Use [foundations](foundations.md) for visual roles and [product contracts](component-contracts.md) for domain policy. Select only the families needed by the journey.

The isolated [component lab](lab/index.html) maps several recipes to `.mc-*` HTML/CSS. Its controller uses fixtures. Evaluate desktop frame relationships in the calibrated Home context with actual fonts/icons and matched shell curves. D26 also calls for standalone foundations/component specimens; these establish bounded detail, not full-frame fidelity. A named selector establishes a construction seam, not proof of tested states, real persistence or production adoption. The [coverage map](system-coverage.md) records actual evidence. New implementations preserve the contract using their own framework's appropriate primitives.

## R1 · Action, navigation link and static label

**Purpose/anatomy.** Make the operation predictable: an action button has a verb and optional glyph; a navigation link identifies its destination; a static tag describes time or identity. Same visual family does not mean same click handler. Route by stable object ID plus purpose (inspect context, review material, practice); never route a course or assignment by its color or row position. Map primary/secondary/quiet emphasis to the importance of the operation within its group, not to every page's first button.

**Visual roles/content.** Use action fill + paired ink, or a visibly recognizable text link; glyph size belongs to its control role, hit area is independent. Tags inherit surrounding text size with added padding. Keep the useful verb/object readable; icon-only actions need an accessible name. A destructive operation needs explicit wording and a consequence-appropriate treatment, not merely coral identity fill.

Small secondary commands such as “All coursework,” “Show next 3,” “Show less,” and inline collection disclosures use the shared pill feedback family: a very light fill at rest, a deeper fill on hover/press, a visible focus ring, and no text movement or underline flash. Use `magic-fb-pill` for semantic buttons and summaries with page-owned spacing. Keep prose evidence links in the link family, and retain filled primary actions for the main operation. Reveal counts come from the actual remaining items; an incremental reveal preserves item order, measures the changed list height for a short transition, offers “Show less” after expansion, and moves focus to the surviving reveal/collapse control when a trigger disappears. A source refresh does not replay a previous reveal. Reduced motion removes decorative transitions.

**Behavior/states.** Links have real destinations and native link behavior; commands use buttons. Default, focus, hover/press and unavailable states are distinct. Async commands show pending, prevent duplicate effects and preserve an error/retry path. Capture the submitted payload at activation; later draft edits remain unsaved until submitted. Reset, cancellation and source replacement invalidate in-flight effects. A static website download link has no invented pending/failure state; verify the URL and disclose actual platform/availability constraints. A disabled control's explanation remains reachable. Do not nest another control inside a clickable row.

**Reversal/check.** Inspect keyboard names, tab order, destination and repeat activation. Reverse an attractive treatment if it hides operation or makes a label look clickable. Lab seams: `.mc-action`, `.mc-link`, `.mc-time`.

## R2 · Context with an optional action

**Purpose/anatomy.** Present an implication, supporting context and only the useful next operation. Anatomy: passage/title → optional metadata/evidence → optional action region. Omit the region entirely when there is no action, allowing content its full width. On narrow surfaces reflow in reading order. At desktop, size the action region to its associated passage; a compound action shares the region. Do not universalize a fixed height from one short example. Compare competing footprint choices explicitly when they conflict with the desired wrapping.

**Visual roles/content.** Reading ink on the continuous surface; selective editorial type and emphasis; bounded action color. Keep the meaning legible before the action. Use a compact group when two genuinely different operations belong together; their shared outline must not imply a shared effect.

**Behavior/states.** Object/evidence links resolve exact identity. A review action and a local confirmation operate independently. Inspect no-action, long passage, pending review, handled/Undo, unavailable source and refresh during reading. Confirmation is a domain-supplied fact with a version, not internal component truth.

**Reversal/check.** Activate each part and verify the other fact did not change. Revert fixed geometry if longer text causes clipping or premature wrapping. Home's disputed equal-height action treatment is a local comparison, not this recipe's universal sizing rule. Lab seams: `.mc-context`, `.mc-compound`, `.mc-passage`.

## R3 · Identity item and collection

**Purpose/anatomy.** Let people recognize and open an object: stable ID → readable name → useful secondary identity/current cue → optional timing/destination. Choose a row for scanning comparable records; choose a card when a small object summary needs independent grouping. The collection owns its ordering and empty/partial state.

**Visual roles/content.** Flat surface with stable identity color plus text, consistent title/metadata roles and deliberate separators. A title may wrap; essential due time must remain visible. Optional provider/avatar imagery has an honest identity and text/fallback. Do not add progress, a thumbnail or a grade solely to fill the item.

**Behavior/states.** Keep selection separate from activation. One primary destination per item; expansion, menus and secondary actions remain separate controls. Handle many/zero records, long name/code, missing image, stale/partial data and unavailable item. Keep saved identity stable across reorder and refresh.

**Reversal/check.** Find the same object in another collection and confirm identical identity and destination. Reject cards that duplicate an entire dashboard or make the primary operation ambiguous. Lab seam: `.mc-entity`; overview card layout remains a separate composition trial.

## R4 · Field and small form

**Purpose/anatomy.** Collect the minimum input needed for the task. A field contains a persistent label, appropriate native control, optional help, value and associated error. Related choices use a labeled group; a submit/cancel region belongs to the form. Placeholder copy supplements the label.

**Visual roles/content.** Reading/control type, clear editable boundary, distinct focus, neutral help and explicit invalid state. Labels explain the requested value; errors explain a concrete correction. Preserve entered text rather than replacing it with an error. Required status appears in label text and programmatic state.

**Behavior/states.** Bind label to control and help/error through IDs (`aria-describedby` as appropriate); expose invalid state when validation fails. Validate at a useful moment, avoiding error feedback before initial input; submission identifies the errors and focuses the first relevant field or an error summary. Default, focused, filled, invalid, disabled/read-only, pending, failed-save and saved states are scoped to actual capability. Toggle, radio, select and checkbox semantics follow the choice, not visual convenience.

**Reversal/check.** Keyboard-submit an invalid value, correct it, fail save, retry and verify values persist. The source contribution is semantic grouping/associations from [shadcn forms at the inspected pin](https://github.com/shadcn-ui/ui/blob/98a1fe67b439324ddc857f47fbdce056600a4329/skills/shadcn/rules/forms.md) and [WAI form validation](https://www.w3.org/WAI/tutorials/forms/validation/). Use shadcn's exact API only if installed; native HTML remains valid. Lab seam: `.mc-field`; form scope is a local fixture, not a real settings service.

## R5 · Disclosure, contextual menu and dialog

**Purpose/anatomy.** Choose by task: disclosure for inline expansion, popover for small contextual information, menu for commands, modal dialog for a focused task requiring input. Anatomy: named trigger → labeled content → appropriate controls → dismissal/continuation. Evidence does not become a menu merely because it fits in a popover.

**Visual roles/content.** Retain shared type/ink/materials; use elevation only to communicate a true overlay. Keep a visible title and usable close/cancel when relevant. Initial focus follows content: first useful field for a short form; title/intro for long structured reading. Avoid flattening a complex dialog into one long accessible description.

**Behavior/states.** Disclosure announces expanded state; closed content is not focusable. A true menu supports its menu keyboard behavior, dismissal and trigger focus return; a simple link list should keep native link/tab behavior. A modal contains focus while open, supports Escape unless a documented task constraint requires otherwise, and restores its invoker or a logical continuation if removed. Define backdrop behavior; first-version form dialogs use explicit Cancel/Escape, avoiding accidental backdrop dismissal. Pending/error contents remain labeled and usable. Dismissal preserves or explicitly discards draft state according to the task; no silent loss from a rerender.

**Reversal/check.** Open by keyboard, traverse, interrupt, Escape and reopen; confirm focus and draft behavior. Test long content and the narrow viewport. Prefer a proven installed primitive or native semantic element, then verify its actual behavior. [shadcn composition](../../.agents/skills/magic-design/references/upstream/shadcn/rules/composition.md) supplies component choice/naming; [APG modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) supplies focus expectations. Motion, if useful, follows [Emil's interruption mechanism](../../.agents/skills/magic-design/references/source-adapters.md). Lab seams: `.mc-menu`, `.mc-dialog`.

## R6 · Feedback, recovery and availability

**Purpose/anatomy.** Explain what changed, what is still usable and how to recover. Anatomy: affected object/operation → explicit state → useful explanation → optional retry/Undo. Place local failures with their content; use global feedback only for a global event. Empty, missing, partial, stale, conflicting and failed are different states.

**Visual roles/content.** Status signifier plus words, readable quiet surface, ordinary action affordance for recovery. Keep existing facts visible while refreshing. Do not show successful-save language until the actual operation confirms it. A blank dataset needs a useful explanation, not an automatic “create” command.

**Behavior/states.** Pending feedback is timely; retries target failures without duplicating success. Announce consequential status accessibly without stealing focus. Prefer persistent recovery. If timed feedback is necessary, pause expiry while hidden, hovered or focused and retain a reachable recovery path. Undo is tied to the exact domain operation/version. Source changes may invalidate conclusions without erasing unrelated local state.

**Reversal/check.** Leave/return, repeated activation, delayed response and keyboard reachability expose failures a static screenshot misses. This applies [Emil's unseen-edge-case mechanism](../../.agents/skills/magic-design/references/source-adapters.md). Lab seam: `.mc-feedback`; real network/persistence behavior must be verified in integration.

## R7 · Navigation and surface frame

**Purpose/anatomy.** Establish where the person is and what useful destinations exist. Frame contains identity, navigation, current-location signal and content; a page's heading hierarchy follows its task. Keep route identity separate from labels.

**Visual roles/content.** For desktop, match the actual Home sidebar construction, shell gradient, workspace curves, fonts and Hugeicons Stroke Rounded glyphs using the baseline/token anchors; preserve active/hover/focus grammar down to nested destinations. Abstract color similarity is insufficient. Desktop sidebar and public website header/footer are separate adapters. A site's footer groups legitimate secondary destinations; a product CTA clearly names download, repository or another real operation. Never add ornamental app window controls to establish brand.

**Behavior/states.** Current location is programmatic and visible. Collapsing navigation preserves route and focus; back reflects real history. A website navigation collapse uses an accessible disclosure with reachable links. Download availability and external destinations reflect actual capability. Authentication, loading or errors appear only when that adapter actually has those states.

**Reversal/check.** Follow a normal entry through the primary destination and Back at large/narrow widths. Reject a desktop layout copied onto a site when it obscures the visitor's explanation/download journey. No complete frame or website journey is proved by the component lab alone.

## R8 · Temporal item and view

**Purpose/anatomy.** Communicate when an object occurs or is due. Item contains exact source identity, title, time/date, timezone where needed and all-day/deadline/event meaning. A temporal view owns grouping, scale and overlap/density handling; item color alone does not establish duration or urgency.

**Visual roles/content.** Readable time axis or date grouping, stable identity and distinguishable deadlines versus timed blocks. Keep event title and actionable timing readable; overflow must expose all hidden events through an explicit route.

**Behavior/states.** Preserve source timezone/all-day semantics, overlapping events, partial coverage, changed time and return position. For Magic, current-week default, week/month views and suggestions on request are product constraints. Month density, constrained layouts and proposal acceptance remain design/interaction work, not an already solved recipe.

**Reversal/check.** Exercise a dense day, month overflow, narrow window and source time change; verify nothing silently disappears or becomes an available slot. No temporal implementation is claimed by this document.

## Extend one family at a time

A new variant must name its purpose, differing anatomy/state and a real consumer. Add a new family only when composing existing ones loses meaning or behavior. Verify the changed family in a representative consumer plus a sibling. Keep expert source versions and notices when adopting further implementation. Agreement among reviewers, native markup, and a rendered specimen are useful evidence with different limits; none alone proves the complete journey.

## Follow-up audit rules

- Shared type sizes use rem so larger-text preferences apply to prose, titles and controls together; verify reflow and actual browser zoom separately.
- Place a dynamically revealed recovery action after its initiating control in keyboard order. Keep the action region sized to the passage; status can occupy a following row.
- A nonmodal navigation popover closes when focus leaves it. Escape restores its trigger; selecting a destination restores useful context.
- Keep validation errors distinct from persistence failures. Associate both with the relevant field, but only invalid input receives aria-invalid.
- Sample text contrast on the composed gradient at actual text positions. Palette acceptance does not establish accessible contrast.

### Control chrome calibration · 2026-09-27

Apply the [current chrome correction](../../DESIGN.md#september-27-2026--chrome-and-control-correction) in R1, R6 and R7: readable glyphs have independent hit areas; normal/hover outlines remain light; focus is distinct. Filled actions may use `--magic-shadow-action`, while quiet controls remain flat. Secondary ink is semantic rather than reduced opacity. Shell feedback is compact until requested. Home rules separate sections without making cards inside cards.
