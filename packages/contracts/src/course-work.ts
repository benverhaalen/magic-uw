/** Read-only scope produced from core courseInclusion. Never authorizes a write. */
export interface CourseWorkAdmission {
  selectedTerm: string | null;
  courses: Array<{
    accountScope: string; courseId: string; sourceIds: string[];
    termId: string | null; termName: string | null; courseLabel: string;
  }>;
  resourceIds: string[];
  /** Exact graph module/content references, computed only after admission. */
  aliases: Array<{ resourceId: string; targetId: string }>;
  schedules?: CourseWorkSchedule[];
  scheduleCoverage?: Array<{ label: string; sourceIds: string[] }>;
}

/** A deterministic institutional crosswalk, with the original planning evidence retained. */
export interface CourseWorkSchedule {
  key: string; accountScope: string; courseId: string; resourceId: string;
  planningRecordId: string; planningSourceId: string;
  classKind: 'lecture' | 'discussion' | 'class';
  meetings: import('./planning').PlanningMeeting[];
  complete: boolean;
}
