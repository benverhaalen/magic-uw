/**
 * UW–Madison's general guidance on generative AI, used as the default AI policy when a course states
 * none of its own. A course's own stated policy always wins (see `effectiveCoursePolicy`). Browser-safe:
 * the renderer reads it for the item's AI-policy line. Decision: docs/decisions.md (UW default AI policy).
 *
 * `quotes` are verbatim from the source page as fetched; `summaries` are our wording of the page and are
 * never presented as quotes. `rules` are the app's operating rules derived from them; code enforces them.
 */
export const UW_DEFAULT_AI_POLICY = {
  id: "uw-madison-default-ai-policy",
  source: {
    title: "Generative Artificial Intelligence",
    publisher: "UW–Madison Office of Student Conduct and Community Standards",
    url: "https://conduct.students.wisc.edu/artificial-intelligence/",
    fetchedAt: "2026-09-27",
  },
  quotes: {
    values:
      "At UW-Madison we expect our students to uphold the core values of academic integrity which include honesty, trust, fairness, respect, and responsibility.",
    uws14:
      "Students are responsible for the honest completion and representation of their work, for the appropriate citation of sources, and for respect of others' academic endeavors.",
    instructorExpectations:
      "Students are responsible for knowing their instructor's expectations when it comes to using AI tools. If it is unclear whether AI tools are allowed in a particular course or for an assignment, it is the student's responsibility to ask their instructor before using them. Instructors' expectations will vary from course to course.",
    sharing: "posting queries or text into AI tools may share that information with the broader internet community",
  },
  summaries: {
    violation: "Unauthorized use of AI tools is a possible violation of UWS 14.03(1)(b), Use of Unauthorized Materials.",
    tips: "Check syllabi and Canvas course information or ask instructors; cite AI use when the instructor requires it (UW Libraries has guidance); text posted into AI tools may be shared.",
  },
  rules: [
    "Magic coaches and never authors graded work.",
    "Study aids for learning are fine: explanations, flashcards, practice quizzes and tests on course material, study guides.",
    "On an open graded item, Magic may explain concepts and point to course sources, and always shows the reminder to check with the instructor. It never drafts, solves or rewrites the graded submission.",
    "A course's own stated AI policy always wins; a course restriction still blocks.",
  ],
  /** The one plain student-facing sentence, shown with the link wherever the policy shows. */
  notice:
    "No course AI policy found, so UW–Madison's guidelines apply: study help is fine; ask your instructor before using AI on graded work.",
} as const;

/** What `EffectiveCoursePolicy.evidence` carries under the default: the governing quote and its citation. */
export const UW_DEFAULT_POLICY_EVIDENCE = `UW–Madison default (no course AI policy found): "${UW_DEFAULT_AI_POLICY.quotes.instructorExpectations}" ${UW_DEFAULT_AI_POLICY.source.publisher}, ${UW_DEFAULT_AI_POLICY.source.url} (fetched ${UW_DEFAULT_AI_POLICY.source.fetchedAt}).`;

/** The notice with its link, for plain-text surfaces (chat). */
export const UW_DEFAULT_NOTICE_WITH_LINK = `${UW_DEFAULT_AI_POLICY.notice} ${UW_DEFAULT_AI_POLICY.source.url}`;

/** Chat's refusal when the student asks Magic to draft, solve or rewrite graded work under the default. */
export const uwDefaultRefusal = (courses: string) =>
  `Magic doesn't draft, solve or rewrite graded work for ${courses}. ${UW_DEFAULT_NOTICE_WITH_LINK}`;
