// owner: course-analytics. The course page's tab strip ("Overview" · "Analytics") and the Analytics
// panel. Kept out of CoursePage.tsx and App.tsx so their mount stays a few lines and ports to any
// course layout: the page renders `tabs` under its heading and `tabBody` in place of its layout.
import type { Snapshot } from "@magic/contracts";
import { CourseAnalyticsTab } from "./CourseAnalytics";
import type { CourseRef } from "./load";
import "../charts/charts.css";
import "../backend/mastery/mastery.css";
import "./analytics.css";

export type CourseTab = "overview" | "analytics";

export function CourseTabs({ tab, onTab }: { tab: CourseTab; onTab: (tab: CourseTab) => void }) {
  const tabs: [CourseTab, string][] = [
    ["overview", "Overview"],
    ["analytics", "Analytics"],
  ];
  return (
    <div className="ca-tabs" role="tablist" aria-label="Course views">
      {tabs.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          id={`course-tab-${key}`}
          aria-selected={tab === key}
          aria-controls={key === "analytics" ? "course-panel-analytics" : undefined}
          className={`ca-tab${tab === key ? " is-active" : ""}`}
          data-shot={`course-tab-${key}`}
          onClick={() => onTab(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function CourseAnalyticsPanel({ snapshot, course, onOpenItem, onOverview }: { snapshot: Snapshot; course: CourseRef; onOpenItem: (itemId: string) => void; onOverview: () => void }) {
  return (
    <div role="tabpanel" id="course-panel-analytics" aria-labelledby="course-tab-analytics" className="ca-panel">
      <CourseAnalyticsTab snapshot={snapshot} course={course} onOpenItem={onOpenItem} onCoursework={onOverview} />
    </div>
  );
}
