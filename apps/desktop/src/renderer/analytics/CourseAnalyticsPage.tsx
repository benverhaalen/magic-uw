// The course page's tab strip ("Coursework" · "Analytics") and the Analytics tab. Kept separate from
// App.tsx so the mount there stays a few lines and ports to the team's newer course layout.
import { useState } from "react";
import type { Snapshot } from "@magic/contracts";
import { CourseAnalyticsTab } from "./CourseAnalytics";
import type { CourseRef } from "./load";
import "../charts/charts.css";
import "../backend/mastery/mastery.css";
import "./analytics.css";

export function CourseAnalyticsPage({
  snapshot,
  course,
  onCoursework,
  onOpenItem,
  onBack,
}: {
  snapshot: Snapshot;
  course: CourseRef;
  onCoursework: () => void;
  onOpenItem: (itemId: string) => void;
  onBack: () => void;
}) {
  const [tab] = useState<"analytics">("analytics");
  return (
    <>
      <div className="page-heading">
        <div>
          <button type="button" className="subtle-button" onClick={onBack}>
            ← Courses
          </button>
          <h1>{course.courseName}</h1>
        </div>
      </div>
      <div className="ca-tabs" role="tablist" aria-label="Course views">
        <button type="button" role="tab" aria-selected={false} className="ca-tab" onClick={onCoursework}>
          Coursework
        </button>
        <button type="button" role="tab" aria-selected={tab === "analytics"} className="ca-tab is-active" id="ca-tab-analytics" aria-controls="ca-panel-analytics">
          Analytics
        </button>
      </div>
      <div role="tabpanel" id="ca-panel-analytics" aria-labelledby="ca-tab-analytics" className="ca-panel">
        <CourseAnalyticsTab snapshot={snapshot} course={course} onOpenItem={onOpenItem} onCoursework={onCoursework} />
      </div>
    </>
  );
}
