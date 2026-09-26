# Engineering principles

Accepted project guidance, updated September 26, 2026. These apply to future decisions as well as today's candidates. For the current implementation, see [development](development.md).

## Reference-driven work

Use the [reference-driven design method](reference-driven-design.md) for architecture, interactions, visuals, implementation, and review. Establish the normal student journey, inspect a reference for its assigned job, identify the transferable mechanism and assumptions, and trace it into the actual output. Test that transfer and its failure conditions. Separate observed behavior, the author's stated reasoning, and our hypothesis; an impressive rationale is not measured evidence.

The [agent work principles](agent-work-principles.md) cover mechanism-first discovery, expert procedures, candidate generation, independent critique, context and total cost, and sustained delivery. Ask Ben about consequential ambiguity, added clutter or complexity, and disproportionate token/tool spend. Keep one canonical explanation and compact handoffs rather than repeating the full research in each context. The repo [AGENTS.md](../AGENTS.md) makes these expectations discoverable to new agents.

## Choose for the job, then verify the choice

Start with the student outcome and the failure that would undermine it. A connector must preserve the right assignment and deadline with the least sign-in and recovery effort. A fast page load is useful only if the required content survives. Familiarity, novelty, a popular repository, and a leaderboard rank are inputs—not selection rules.

For each consequential component, compare materially different mechanisms where relevant: structured API versus rendered browser; deterministic extraction versus local model; native OCR versus a bundled model; event/hash comparison versus a separate monitoring service. Investigate current alternatives before committing. Stop when further research is unlikely to change the decision; do not turn every small utility into a procurement exercise.

## Evidence required for adoption

Record the exact version or commit, release date and recent maintenance, operating systems, distribution size and runtime needs, direct and transitive licenses, model-weight licenses, data destinations, telemetry defaults, and failure behavior. The project may ship as a closed desktop app; permissive code does not automatically make its weights or bundled binaries compatible. Preserve required notices. Avoid AGPL/noncommercial components in the shipped default unless the product licensing direction is explicitly changed.

Treat performance and accuracy claims as claims until checked. Name who ran a benchmark, who maintains it, their relationship to the tool, the dataset, hardware, baselines, metric, and exclusions. An author's benchmark can be informative but is not independent validation. Another site's repetition of the same numbers is not a new measurement. Benchmarks on news articles do not establish recovery of syllabus tables, assignment attachments, or personalized deadlines. Absence of independent evidence is uncertainty, not proof of poor quality.

## Test what we will rely on

Use a small, representative, manually checked corpus before promoting an option: structured Canvas responses, an almost-empty description with a linked spec, a table schedule, conflicting dates, JavaScript content, a login page, a scanned page, and a changed or deleted item. Include non-CS course structures when data becomes available. Keep raw private samples outside the repository; commit only synthetic or explicitly redacted fixtures.

Compare field fidelity, source-quote alignment, missed requirements, wrong merges, completeness reporting, cold and warm latency, memory, and recovery effort. Pin the corpus and conditions. Record failures as well as successes. A local test supports only the cases it exercised; do not extrapolate to every UW student or claim measured speed before measuring.

Keep a deterministic baseline. Prefer the cheapest reliable rung of the connector ladder. A model fallback must improve a failed extraction without inventing evidence. Code checks literal quote offsets, schemas, IDs, dates, scope, and permissions; a model's confidence cannot replace those checks.

## Keep experiments reversible

Give browsers, extractors, OCR engines, model selectors, and monitors narrow interfaces with typed results, provenance, partial/blocked status, cancellation, and bounded resource use. Keep candidate adapters separate from the production default. Every adopted alternative needs an acceptance test and a reversal condition. Preserve the last known capture on failure. Missing, empty, stale, and inaccessible are distinct states.

Do not install every candidate or put an autonomous browser in the normal read path merely because it is capable. Use agents to discover and repair recipes; use checked code to run stable recipes. No source-page instruction can trigger a tool, change settings, or authorize a request.

## Session access and least effort

A lightweight in-app browser should handle user-completed sign-in and reuse its own persistent browser session for later authorized reads. Keep the browser frame minimal and show the current origin. Avoid repeated external redirects when the provider supports embedded sign-in. Embedded-browser acceptance and SSO coverage must be tested per service; never promise one login works everywhere.

Student-approved attachment to an existing browser is an alternative where supported. It must be an explicit connection, not cookie decryption or silent profile access. Disable telemetry and performance uploads before private browsing. Never automate Duo, bypass expiry, or keep sessions alive with artificial activity. Expiry must preserve prior data and offer a clear reconnect action.

**Current development constraint:** all agent computer and Canvas verification is headless. An interactive sign-in or Duo requirement is reported to Ben; agents do not open visible windows to solve it. This constraint concerns how we test, not whether the shipped app can show its sign-in browser when the student asks.

## Data clarity is executable behavior

Local storage does not mean local processing. Show the recipient, purpose, categories, and exact selected context before hosted processing; use the same compiled payload in the request. Cookies and provider credentials never enter the context compiler. Fully local mode disables hosted Jev as well as hosted LLMs.

One owner-paid Jev key stays on our gateway. Client installations receive revocable, limited credentials; they never receive the upstream key. Reserve usage against persistent limits before calling upstream. Anonymous installation credentials reduce setup effort but do not prevent repeated enrollment: a global cap must protect the owner's bill. Avoid logging request bodies or private evidence.

Do not claim every provider account can power embedded inference until its supported interface and terms are verified. Handoff, local inference, and in-app hosted inference are different capabilities. Explain provider data controls with dated official sources; disabling training is not the same as deleting retained data.

## Keep the shared context honest

Update decisions and affected architecture notes when an assumption changes. Label direction, candidate, adopted, implemented, tested in isolation, integrated, and demonstrated in use precisely when the distinction matters. Document why a choice fits and what would cause us to revisit it. Do not turn untested options into team commitments by writing them in a stack list.

## Ingestion boundaries in practice

A read can have incidental server-side effects. Disclose Canvas view/must-view changes as accepted consequences of collecting content; do not describe GET-only access as having no effects. Keep explicit school-changing actions absent from the tool surface.

Measure useful arrival and source coverage separately. A feed can be current while instructions are stale. Preserve old evidence during expiry, drift, malformed records, and bounds. Only a complete enumeration may establish removal. Local collection, local storage protection, and permission to share with hosted AI are separate decisions.
