/**
 * The page views (owner: page-views): each page is one composite read-only query. Code decides and
 * ranks; every item carries a reason and its evidence; missing data is reported as missing.
 */
import type { PageViewResult, QueryRequest, Store } from "@magic/contracts";
import { assessmentPage } from "./assessment";
import { assignmentWorkspace } from "./assignment";
import { viewStore } from "./common";
import { studyOffers } from "./grades";
import { lectureSession } from "./lecture";

export type PageViewRequest = Extract<QueryRequest, { view: "assignment.workspace" | "lecture.session" | "assessment.page" | "study.offers" }>;
export const PAGE_VIEWS = new Set<string>(["assignment.workspace", "lecture.session", "assessment.page", "study.offers"]);

export function runPageView(store: Store, request: PageViewRequest, now: string): PageViewResult {
  const s = viewStore(store);
  switch (request.view) {
    case "assignment.workspace":
      return assignmentWorkspace(s, request.resourceId, now);
    case "lecture.session":
      return lectureSession(
        s,
        {
          courseId: request.courseId,
          ...(request.accountScope ? { accountScope: request.accountScope } : {}),
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          ...(request.date ? { date: request.date } : {}),
          ...(request.type ? { type: request.type } : {}),
        },
        now,
      );
    case "assessment.page":
      return assessmentPage(s, request.assessmentId, now);
    case "study.offers":
      return studyOffers(s, { courseId: request.courseId, ...(request.accountScope ? { accountScope: request.accountScope } : {}), ...(request.days ? { days: request.days } : {}) }, now);
  }
}
export { PageViewError } from "./common";
export { APPROACH_PACK, checkApproach, approachFacts } from "./approach";
export { createApproachHandler, type ApproachRunResult } from "./approach-run";
export { gradeBank, critical, offersFor, stakesOf, type Bank } from "./grades";
