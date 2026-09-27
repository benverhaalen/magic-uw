import { useId } from "react";
import type { ResourceView, SourceHealth } from "@magic/contracts";
import { type CourseCard } from "../../../../../packages/domain/src/course-page";
import { Action } from "../../../../../packages/ui/src/components";
import { EvidenceInfo } from "../../../../../packages/ui/src/evidence-info";
import type { AssignmentTypeHue } from "../../../../../packages/ui/src/deadline-emphasis";
import "../../../../../packages/ui/src/evidence-info.css";
import "../../../../../packages/ui/src/deadline-emphasis.css";
import { Glyph } from "../DesktopShell";
import { courseIdentityHues, coverageGroups, sharedTerm, canvasCurrentGrades, type CanvasCurrentGrade, type CoverageGroup } from "./course-index-view";
import "./courses-index.css";

/** Course identity choices. Work belongs to the adjacent Tasks view. Each card opens its course. */
export function CoursesIndex({
  cards, showHeader = true, now, resources = [], sources = [], onOpen, onSources,
}: {
  cards: CourseCard[];
  showHeader?: boolean;
  now: string;
  /** Saved course records and source identities; omitted inputs produce no grade tabs. */
  resources?: ResourceView[];
  sources?: SourceHealth[];
  /** Compatibility with the existing host; assignment previews are no longer on course cards. */
  typeHueOf?: (r: ResourceView) => AssignmentTypeHue | null;
  onOpen: (key: string) => void;
  onSources: () => void;
}) {
  const term = sharedTerm(cards);
  const coverage = coverageGroups(cards);
  const hues = courseIdentityHues(cards.map((c) => c.key));
  const grades = canvasCurrentGrades(cards, resources, sources, now);
  return (
    <div className="courses-index">
      {showHeader && <header className="ci-header">
        <h1 tabIndex={-1}>{term ?? "Courses"}</h1>
        {cards.length && coverage.length ? (
          <EvidenceInfo label="How current these courses are">
            {coverage.map((group) => <span key={group.freshness} className="ci-coverage">{coverageText(group, group.cards.length === cards.length)}</span>)}
          </EvidenceInfo>
        ) : null}
      </header>}
      {cards.length ? (
        <ul className="ci-grid" data-count={cards.length}>
          {cards.map((card) => <CourseChoice key={card.key} card={card} grade={grades.get(card.key)} hue={hues.get(card.key) ?? null} onOpen={onOpen} />)}
        </ul>
      ) : (
        <div className="ci-none">
          <p>No courses are in your saved workspace yet. Connect Canvas or choose which courses to include in Sources.</p>
          <Action onClick={onSources}>Open Sources</Action>
        </div>
      )}
    </div>
  );
}

function CourseChoice({ card, grade, hue, onOpen }: {
  card: CourseCard; grade?: CanvasCurrentGrade; hue: string | null; onOpen: (key: string) => void;
}) {
  const basisId = useId();
  return (
    <li className="ci-card" data-magic-hue={hue ?? "neutral"} data-place-anchor={`course-card-${card.key}`}>
      <div className="ci-surface">
        <div className="ci-top">
          {card.code ? <span className="ci-code">{card.code}</span> : <span />}
          <span className="ci-arrow" aria-hidden="true"><Glyph name="forward" /></span>
        </div>
        <h2 className="ci-title">
          <button type="button" className="ci-open" data-course-key={card.key} data-focus-key={`course-card-${card.key}`}
            title={card.rawCourseName !== card.courseName ? card.rawCourseName : undefined}
            aria-label={card.code ? `${card.courseName}, ${card.code}` : undefined}
            onClick={() => onOpen(card.key)}>{card.courseName}</button>
        </h2>
      </div>
      {grade ? <div className="ci-grade">
        <span aria-describedby={basisId}>Current grade: <span className="ci-grade-score">{grade.score}%</span></span>
        <span id={basisId} className="ci-sr-only">Canvas’s saved current-score calculation, as of {checked(grade.observedAt)}. It follows Canvas’s gradebook settings and is not a final or official transcript grade.</span>
        <EvidenceInfo label={`About the current grade for ${card.courseName}`}>
          Canvas’s current-score calculation for this course, saved {checked(grade.observedAt)}. It follows Canvas’s gradebook settings. This is not a final or official transcript grade, and Magic does not recalculate it.
        </EvidenceInfo>
      </div> : null}
    </li>
  );
}

const checked = (iso: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
function coverageText(group: CoverageGroup, all: boolean): string {
  const who = all ? "" : `${group.cards.map((c) => c.code ?? c.courseName).join(", ")}: `;
  if (group.freshness === "unknown") return `${who}not checked in Canvas yet.`;
  if (group.freshness === "partial") return `${who}${all ? "Partly" : "partly"} checked${group.checkedAt ? ` on ${checked(group.checkedAt)}` : ""}. Some coursework may be missing.`;
  return `${who}${all ? "Saved" : "saved"} copy${group.checkedAt ? ` from ${checked(group.checkedAt)}` : ""}. Newer changes in Canvas may be missing.`;
}
