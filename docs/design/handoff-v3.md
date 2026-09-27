# Use the component system · v3

Start with [DESIGN.md](../../DESIGN.md), then load only the recipe relevant to the task. Ben accepted the [foundation palette/type sheet](assets/foundations-v3.png); the [refined component sheet](assets/components-v3.png) is the current candidate. The near-approved Home remains the visual-language authority. This sheet is documentation, not a proposed Home arrangement.

## Build from a feature description

1. State the audience, useful result, normal entry and return path. Identify facts, source versions and operations the application really supports.
2. Read the matching [recipe](component-recipes.md) and [behavior contract](component-contracts.md). For generated copy or information hierarchy, use [content design](content-design.md).
3. Import [shared tokens](tokens.css). Inspect the matching implementation in [the lab](lab/index.html) and its [markup/state API](lab/README.md). Supply permitted Cooper Light BT and Geist assets; preserve Lucide geometry and license. Do not copy the documentation navigation into a product page.
4. Implement in the target framework using its native component, routing and state mechanisms. Lab JavaScript is synthetic fixture logic, not application data plumbing. Keep domain adapters and page layout separate from reusable visual roles.
5. Verify the actual journey, including a relevant failure, reversal and return. Compare the rendered component to the Home language and current sheet. A new pattern needs evidence before it becomes a shared rule.

## What can be reused now

Palette, type, materials, glyph sizing, focus and boundary roles; action and inline-link treatments; context/action/confirmation composition; flat work items; study actions; temporal labels; field/error/retry; menu and modal behavior specifications. Shared command-token propagation and a fresh source-refresh transfer were observed in the browser.

## Boundaries

This is an HTML/CSS/JavaScript reference implementation. Production React/Electron integration, complete Calendar and website composition, real-service journeys and broader accessibility testing are still separate work. See [validation](validation-v3.md). Candidate details can change after Ben's feedback; foundation approval does not approve every control.

## Concurrent work

Record the Git revision used and the files owned. One integrator edits shared tokens/contracts at a time; feature workers compose within their owned surfaces. Check upstream changes before integration. Bring conflicting human decisions to the humans directly. Do not rewrite unrelated work or load whole conversations: link the controlling decision, affected recipe and bounded evidence.

## Latest audit follow-up

Read [the direct-source audit](audit-v3-direct-sources.md) before transferring these components. It records the updated routing, versioned self-report, async-payload/cancellation, native navigation and identity contracts. Use current code and validation rather than the older all-family screenshot. The system remains an isolated specimen; real provider/framework integration requires a scoped adapter and journey test. Component details retain candidate status.

Latest direct-source follow-up: three Opus browser workers found and informed repairs to contrast, keyboard recovery order, popover dismissal, disclosure consistency and text resizing. All ten destinations and save/cancel race repairs were rechecked by the integrator. Read the compact audit coverage/limits before relying on the system; it is not production or universal accessibility certification.
