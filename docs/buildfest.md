# BuildFest context

Checked September 26, 2026 against the live site and Ben's opening-slide photos. Times are Central. This records event context, not a build schedule.

## Our entries and submission

Applied AI & Automation; DoIT's Badgers Building for Badgers; The Art of the Break. Teams select one track and up to two challenges. A team may receive a track award and two challenge awards. No separate overall grand prize was identified. [Tracks and awards](https://buildfest.project.wiscweb.wisc.edu/tracks-awards/)

The published build window is Saturday September 26 at 11 AM to Sunday September 27 at 11 AM. Submit a repository, two-minute video, and required responses by Sunday 11 AM. Up to five finalists per track advance to live demos Sunday 1–3 PM. Challenges are judged asynchronously; winners are announced September 30. The Break challenge uses a one-page Break Card about an actual failure in the team's agent, frequency, mitigation attempts, and lessons. Ours: [Break card: checked quotes, unchecked sentences](break-card.md) ([public link](https://github.com/benverhaalen/magic-uw/blob/main/docs/break-card.md)). [Schedule](https://buildfest.project.wiscweb.wisc.edu/schedule-logistics/), [FAQ](https://buildfest.project.wiscweb.wisc.edu/faq-about-tel/)

## Opening slides and unresolved rules

Ben's photos emphasize a working prototype, student validation for DoIT, and judging on user insight, solution fit, technical execution, communication, differentiation, and real-world potential. They say new product code is written during the event and repository history may be audited.

The website requires three mentor visits; an opening slide allows mentors or student organizations. Safest interpretation pending clarification: three mentors. Slides request a selfie and insight recorded in Discord and Devpost. The main Saturday mentor window is 1–3 PM.

The exact treatment of existing libraries, templates, research, and previously generated code needs organizer clarification. The public FAQ does not settle this. No organizer has been contacted during this documentation pass.

Suggested question: “What pre-event material is allowed—planning documents, designs, third-party libraries/templates, and previously generated application code—and do student-organization visits count toward the three required visits?”

## Judging audiences

The live [mentors and judges page](https://buildfest.project.wiscweb.wisc.edu/mentors-judges/) lists:

| Panel | People | Implication for our explanation — interpretation |
| --- | --- | --- |
| Applied AI | Christopher Mende; Christopher Harrison | Useful behavior, engineering choices, failure handling, evidence |
| DoIT | Stephanie Johnson; Brian Ploeckelman; Garrett Smith; Justin Janisch; Eric MacKay | Learning value, integration boundaries, maintainability |
| Art of the Break | Sai Nagabhairava; Shivansh Gupta | Genuine failure, denominator, cause, mitigation, residual limits |

The supplied detail that a DoIT judge previously owned degree audit is not verified by the reviewed page.

Potentially useful conversations: Zekai Otles on campus access/pilot constraints, Christopher Mende on production AI, Shivansh Gupta on failure evaluation, Christopher Harrison on reliability. These are suggestions, not assigned visits.

Our submitted Break Card is [checked quotes, unchecked sentences](break-card.md) (B1–B4, fixed in [PR #59](https://github.com/benverhaalen/magic-uw/pull/59)): code checked that a cited quote was real, not that the sentence said what the quote says. It is measured live: the student's own Claude Code (`claude-sonnet-5`) answered 60 stress questions through the real ask path. It wrote one sentence contradicting its quote (1/167 across two runs), which the fix caught. The first fix wrongly replaced correct sentences in 15/60 answers; the final fix, re-measured live, in 2/60. Targeted synthetic cases back the before/after rates. False assignment linking was an earlier candidate subject and was not used.
