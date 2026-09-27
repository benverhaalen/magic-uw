# Course intelligence compiler

Backend implementation, September 26, 2026. The optional local extraction adapter has isolated checks and the compiler is connected to ingestion and existing policy consumers. This document does not establish a demonstrated live-model capability. Follow [reference-driven design](reference-driven-design.md) and [the implementation status](implementation-status.md) for delivery evidence.

## Student journey and scope

A normal course refresh captures the syllabus, assignments, and materials. A local compiler assembles a reusable course profile: cited AI policies, grading rules, topics, and assessment expectations. Existing context and tutoring consumers can use that profile without a new screen or a student repeatedly uploading the same syllabus. A source change must invalidate dependent conclusions. Missing, inaccessible, contradictory, and uninterpreted information must remain distinguishable.

The profile is derived evidence, not a replacement for captured sources. Its identity includes the account and course. It must not join two courses merely because their names match. The initial scope excludes degree eligibility, transcript interpretation, student mastery, grade predictions, and generation of practice questions.

## Reference transfers

Primary sources below were inspected September 26, 2026. These are documented mechanisms and implementation recommendations, not independent measurements of extraction quality. No external code is copied and no additional framework is required by these references.

| Reference and job | Observed mechanism and conditions | Transfer and discriminating check |
| --- | --- | --- |
| [W3C Web Annotation, quote and position selectors](https://www.w3.org/TR/annotation-model/#text-quote-selector) — evidence identity | A quote selector carries exact text with optional surrounding text; a position selector identifies a span. Positions are meaningful for a particular text representation. | Bind every extracted claim to resource ID, captured content hash/version, and an exact source span. A repeated quotation must not silently resolve to the wrong occurrence. Change the source while preserving the claim text elsewhere and verify the old anchor is not treated as current. This transfers the anchoring mechanism, not JSON-LD or full standard conformance. |
| [Bazel remote caching](https://bazel.build/remote/caching) — incremental computation | Cached results depend on action inputs; the documentation warns that an untracked compiler can produce incorrect cache hits. | Fingerprint the sorted, scoped input identities/content hashes and compiler/extractor version. Changing a source or extraction implementation invalidates its result; reordering unchanged inputs does not. Freshness is separate from unchanged content: failed refresh cannot become current because the same hash remains. No remote cache is needed. |
| [UW–Madison teaching principles](https://ctlm.wisc.edu/generativeai/uw-madison-guiding-principles-for-generative-ai-in-teaching/) — policy scope | Instructors may describe expectations for a whole course or individual assignments and assessments. | Preserve course versus assignment scope and supporting evidence. An assignment exception must not loosen unrelated work. Test a permissive assignment alongside a prohibited exam and ambiguous course wording. A quote in an arbitrary reading is not automatically an instructor policy. |
| [Google LangExtract README](https://github.com/google/langextract) — extraction boundary | The documented process extracts structured information and maps results to source spans; its authors explicitly make inference accuracy dependent on model, task, prompts, and examples. The inspected README identifies version 1.6.0 and Apache-2.0 licensing. | Treat a model response as a candidate; validate shape, source identity, span, scope, and exact numeric values in code before publishing a claim. Local model support is a relevant adapter pattern. Do not introduce a Python service solely to obtain the pattern. Reject fabricated quotes and stale responses; retain a correct quote with an unsupported interpretation as an unresolved candidate. No independent quality benchmark was established in this pass. |

The important distinction is between **finding text** and **establishing what that text permits**. Exact quote validation establishes provenance. It does not prove that a passage is authoritative, current, applicable, or correctly interpreted. Model confidence is not a permission check.

## Compiler boundaries

- Consume the existing versioned capture/store interfaces; keep original source records intact.
- Use exact structured fields for known grading weights and drop rules. Prose extraction may supply candidates but cannot silently override conflicting structured evidence. Missing weights do not become zero, and a percentage is not automatically a final-grade weight.
- Preserve policy restrictions, conditions, attribution requirements, conflicts, and scope. A single permissive label loses these distinctions.
- Store evidence and extraction method/version with derived claims. Keep incomplete coverage and unsupported interpretations explicit.
- Treat topics and assessment descriptions as source-supported statements. A topic list is not a measured exam blueprint, and mention frequency is not exam weight.
- Keep inference out of first paint. Existing valid data remains readable during recompilation; stale results must not commit over newer captures.
- Reuse the separate citation-checking and identity-scrubbing work through agreed interfaces. This feature does not authorize another hosted data path. Any future hosted extractor must use the same consent, category, redaction, and receipt boundaries as other hosted requests.

## Unknown policy is not permission

UW's [student conduct guidance](https://conduct.students.wisc.edu/faculty-staff-resources/artificial-intelligence/) directs students to ask their instructor when permission is unclear. The [Law School course rules](https://law.wisc.edu/current/rules/chap3.html) include a prohibition default when a faculty member has not established a policy. These sources demonstrate that a missing course statement does not establish campus-wide permission.

Magic Canvas's coaching fallback is a product behavior, not a finding that a school authorized that help. The profile should say when no applicable policy was established from available sources. Program or school defaults cannot be claimed as covered unless those sources are actually captured and their applicability established. General course-policy interpretation and compliance across all schools remain unverified.

## Optional local semantic extraction

`createLocalCourseExtractor().extract({ inputHash, resources }, signal)` in `packages/ai/src/course-extraction.ts` performs a real Ollama structured-output request through the existing local-runtime verification. Construction makes no calls. There is no hosted fallback or model installation. The call verifies cloud is disabled, the installed model matches the hardware recommendation, its digest has not changed, and the returned model identity is expected.

The implementation transfers the official [Ollama schema-output pattern](https://docs.ollama.com/capabilities/structured-outputs): supply a JSON schema in `format`, use temperature zero, and validate the returned JSON independently. A schema constrains shape; it does not establish interpretation accuracy. Ollama documentation was inspected September 26, 2026; no new runtime dependency was added.

The adapter selects passages about AI policy, grading, topics, and assessments from syllabus and assignment text. It sends at most six sources and 6,000 total characters in one request, with syllabus first and stable resource ordering. Omitted sources/tails and rejected candidates produce explicit partial coverage. `complete` here means the bounded eligible input was examined without validation rejections, **not** exhaustive semantic recall. Other material types are not yet selected for semantic extraction.

Each candidate must name a supplied resource/hash and quote its exact text. The value must equal the quote, so the model cannot quietly turn a percentage into a computed weight or paraphrase away a condition. Code repairs a model's incorrect character offsets only when the quotation is unique; ambiguous matches are rejected. Model-proposed policy permission fields are rejected. The compiler checks source roles and scope; a valid quote may still have an incorrect label or incomplete context. Only a narrow prohibition occupying the entire captured resource can automatically become a literal restriction. Mixed syllabus prose remains unknown even if the model selects a restrictive sentence. Existing explicit captured policy assertions are preserved separately. This is an evidence compiler, not comprehensive semantic policy enforcement.

The result carries extractor version, model name/digest, examined/omitted resource IDs, and rejected-candidate count. Invalid envelopes or an unavailable runtime return no batch; cancellation propagates. Requests and responses have byte bounds, a 90-second inference timeout, a 1 MiB transport response cap, and a 1,600-token generation limit. Source data stays in a separate untrusted message with no action tools. The shared local transport retains its existing status/reverification gates and tutoring behavior.

Verification: `tests/course-extraction.test.ts` and `tests/local-ai.test.ts` passed 14 isolated cases, including changed model identity, cloud enablement, invented quotes, invalid values, ambiguous spans, bounded partial input, invalid/truncated output, and cancellation. TypeScript checking passed. The full suite subsequently passed **275 automated tests**, including 14 adversarial compiler integration tests. The final TypeScript/build and existing hidden Electron smoke passed. Background scheduling, stale-result rejection, restart cache reuse, and runtime-unavailable recovery were tested with synthetic adapters. Actual installed-model inference, semantic recall, policy correctness, and live background inference remain unverified.

Successful or partial semantic results are reused across app restarts for unchanged inputs and the same extraction algorithm version. The receipt retains the model name and digest used. Installing a different model alone does not invalidate an already accepted profile; a source/compiler/extractor-version change triggers new extraction. No manual re-extraction control is exposed yet. An unavailable runtime retries after five minutes while structured evidence remains usable, and snapshots expose semantic status. A failed refresh preserves claims with degraded source coverage; it cannot establish that everything is current.

## Integration and acceptance checks

The actual entry is `store.ingest()`: SQLite schema 5 stores derived profile versions using `compileCourseIntelligence()` from `packages/domain/src/course-intelligence.ts`. Snapshots expose source coverage/freshness, context carries effective policy, and the local tutor consumes that policy gate. The desktop worker injects the optional local extractor; core schedules it in the background and guards application by current input hash and generation. This adds backend data and existing-consumer behavior, with no new screen. The compiler preserves structured grading weights as assertions without inferring whether weighting is active. Verification should cover:

1. A course refresh creates cited intelligence that the normal context/tutoring path reads.
2. Identical inputs reuse the result; changed or deleted inputs invalidate dependent claims, and compiler-version changes invalidate cached interpretation. Course exclusion blocks context and extraction use; it does not erase retained local evidence.
3. A failed or partial refresh preserves readable evidence with honest coverage/freshness.
4. Same-named courses and different accounts remain separate.
5. Fabricated quotes, repeated text at a different location, unsupported scope, and late model results cannot publish false current claims.
6. Conditional policy, missing policy, conflicting policy, and assignment exceptions never silently become unrestricted permission.
7. Hosted-sharing-off behavior and source content that attempts to instruct the agent cannot cause a network call or action.

Synthetic checks establish those behaviors for their cases. Real-syllabus extraction coverage, general semantic accuracy, local-model latency, and instructor-policy correctness require separate evaluation. A schema and a literal-text parser alone do not establish general course understanding.
