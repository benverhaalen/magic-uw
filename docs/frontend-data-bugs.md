# Frontend data bugs for backend follow-up

The active desktop work prioritizes the frontend. Backend data defects found while building it are recorded here for Nate/Nathaniel to assess; proposed ownership is not an accepted assignment. This page records observed behavior separately from suspected causes. It does not authorize backend implementation.

Ben, recorded September 27, 2026 (original message timestamp unavailable):

> keep your work on the frontend primarily and with backend bugs you notice that mess with things with data add them to docs for probably nates agent to pick up

Follow-up:

> maybe make a new doc just for these bugs

## Current findings

| ID | Finding | Status |
| --- | --- | --- |
| [FDB-001](#fdb-001-assignment-grade-share-lacks-account-and-capture-coverage-boundaries) | Assignment grade share lacks account and capture-coverage boundaries | Reproduced with synthetic inputs |

Existing syllabus discovery, extraction, and capture gaps remain in [backend packet 12](../.agents/team/packets/backend/12-syllabus-discovery.md); that investigation belongs to Nathaniel and is not duplicated here.

## Entry format

Each finding receives a stable `FDB-###` identifier and a short title. Record:

- Status: observed behavior, suspected cause, or resolved with evidence.
- Student impact and a sanitized reproduction.
- Code path and inspected revision; expected and actual result.
- Current frontend handling and its limitation.
- Proposed backend owner: Nate/Nathaniel, pending acceptance.
- Next useful action and the proof needed to resolve the issue.

Private coursework, account identifiers, captures, logs, credentials, and sessions stay outside the repository. Link public code or synthetic reproduction evidence; summarize private observations without exporting their contents.

## FDB-001: Assignment grade share lacks account and capture-coverage boundaries

**Status:** observed with synthetic inputs through the exported `gradeShare` function; current implementation inspected at main `8dc51b1`. This is not a claim about any student's actual grades.

**Student impact:** a precise-looking assignment percentage can change solely because more assignments were captured. Identical course IDs from different accounts can affect the same calculation. That output cannot support personal grade-impact ranking without additional evidence.

**Code:** `packages/domain/src/today-rail.ts`, `RailResource` and `gradeShare` (function begins around line 222 at the inspected revision). The input has no account/source boundary or capture-completeness field. Group totals, group lookup, and assignment siblings use `courseId`; the denominator sums only supplied assignment points.

**Synthetic reproduction:** provide one course group with weight 100 and assignment A with 10 points. `gradeShare([group, A])(A)` reports about 100%. Add assignment B in the same group with 90 points: A becomes about 10%. Add another account's group with the same course ID and weight 100: the course total becomes 200 and the result is null. The first change demonstrates sensitivity to missing captured siblings; the second demonstrates the missing account boundary. Neither case requires private coursework.

**Expected / actual:** expected either a supported account-scoped estimate with known coverage and grading rules, or wording limited to the observed Canvas group weight. Actual computation derives assignment share from the available rows without knowing whether they cover the group, and has no way to distinguish accounts. Dropped-score wording does not establish complete coverage.

**Frontend handling:** do not use the estimate to rank personal impact or display it as a known share. Prefer source-grounded due dates, points, and the group weight explicitly labeled as listed in Canvas. This avoids an unsupported claim but does not repair the backend calculation. Adoption in each consumer still needs verification.

**Proposed backend owner:** Nate/Nathaniel, pending acceptance. **Next action:** determine the required account/source and completeness contract, plus behavior for partial, duplicate, dropped-score, and unweighted cases. See existing [syllabus investigation](../.agents/team/packets/backend/12-syllabus-discovery.md) for separately owned course-evidence gaps.

**Resolution proof:** tests must demonstrate account isolation and conservative partial-capture behavior, followed by a frontend check showing the resulting evidence-qualified wording. No fix is claimed here.
