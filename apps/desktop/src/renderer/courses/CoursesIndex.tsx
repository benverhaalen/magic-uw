import type { ResourceView } from "@magic/contracts";
import { type CourseCard } from "../../../../../packages/domain/src/course-page";
import { localTime } from "../../../../../packages/domain/src/today-rail";
import { Action } from "../../../../../packages/ui/src/components";
import { EvidenceInfo } from "../../../../../packages/ui/src/evidence-info";
import { deadlineEmphasis, deadlineSurface, type AssignmentTypeHue } from "../../../../../packages/ui/src/deadline-emphasis";
import { InlineEntity, presentationLabels, type PresentationLabel } from "../../../../../packages/ui/src/inline-context";
import "../../../../../packages/ui/src/evidence-info.css";
import "../../../../../packages/ui/src/deadline-emphasis.css";
import { Glyph } from "../DesktopShell";
import { resourceHref } from "../navigation";
import { courseIdentityHues, coverageGroups, emptyNextText, sharedTerm, undatedText, type CoverageGroup } from "./course-index-view";
import "./courses-index.css";

/**
 * The Courses index: one colored card per included course, centered. A card opens its course; its
 * next dated assignment is a separate link to the shared resource detail. Everything shown comes from
 * the course card read model; nothing is summarized or inferred.
 */
export function CoursesIndex({
  cards,
  showHeader = true,
  now,
  typeHueOf,
  onOpen,
  onSources,
}: {
  cards: CourseCard[];
  showHeader?: boolean;
  /** Snapshot time; bins and "Today"/"Tomorrow" use the device time zone, as Home does. */
  now: string;
  /** The app-wide type-hue mapper, so an assignment keeps one hue on Home, Calendar and here. */
  typeHueOf?: (r: ResourceView) => AssignmentTypeHue | null;
  onOpen: (key: string) => void;
  onSources: () => void;
}) {
  const term = sharedTerm(cards);
  const coverage = coverageGroups(cards);
  // Project the complete sibling set so disclosure or row position never changes a label.
  const nextCards = cards.filter((card) => card.next);
  const nextLabels = presentationLabels(
    nextCards.map((card) => card.next!.title),
    nextCards.map((card) => ({ shownPrefixes: [card.code, card.courseName].filter((v): v is string => !!v) })),
  );
  const labelsByKey = new Map(nextCards.map((card, index) => [card.key, nextLabels[index]!]));
  const hues = courseIdentityHues(cards.map((c) => c.key));
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = localTime(now, timeZone).date;
  return (
    <div className="courses-index">
      {showHeader && <header className="ci-header">
        <h1 tabIndex={-1}>{term ?? "Courses"}</h1>
        {cards.length && coverage.length ? (
          <EvidenceInfo label="How current these courses are">
            {coverage.map((group) => (
              <span key={group.freshness} className="ci-coverage">
                {coverageText(group, group.cards.length === cards.length)}
              </span>
            ))}
          </EvidenceInfo>
        ) : null}
      </header>}
      {cards.length ? (
        <ul className="ci-grid" data-count={cards.length}>
          {cards.map((card) => (
            <CourseChoice
              key={card.key}
              card={card}
              label={labelsByKey.get(card.key) ?? null}
              hue={hues.get(card.key) ?? null}
              today={today}
              timeZone={timeZone}
              typeHueOf={typeHueOf}
              onOpen={onOpen}
            />
          ))}
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

function CourseChoice({
  card,
  label,
  hue,
  today,
  timeZone,
  typeHueOf,
  onOpen,
}: {
  card: CourseCard;
  label: PresentationLabel | null;
  hue: string | null;
  today: string;
  timeZone: string;
  typeHueOf?: (r: ResourceView) => AssignmentTypeHue | null;
  onOpen: (key: string) => void;
}) {
  const next = card.next;
  const due = card.nextDeadline?.displayAt ?? null;
  const dueCue = card.nextDeadline?.cue ?? null;
  const emphasis = deadlineEmphasis({ today, due: due ? localTime(due, timeZone).date : null, completed: false });
  const typeHue = next && typeHueOf ? (typeHueOf(next)?.hue ?? null) : null;
  return (
    <li className="ci-card" data-magic-hue={hue ?? "neutral"} data-place-anchor={`course-card-${card.key}`}>
      <div className="ci-top">
        {card.code ? <span className="ci-code">{card.code}</span> : <span />}
        <span className="ci-arrow" aria-hidden="true">
          <Glyph name="forward" />
        </span>
      </div>
      <h2 className="ci-title">
        <button
          type="button"
          className="ci-open"
          data-course-key={card.key}
          data-focus-key={`course-card-${card.key}`}
          title={card.rawCourseName !== card.courseName ? card.rawCourseName : undefined}
          aria-label={card.code ? `${card.courseName}, ${card.code}` : undefined}
          onClick={() => onOpen(card.key)}
        >
          {card.courseName}
        </button>
      </h2>
      {next && label ? (
        <div className="ci-next">
          <InlineEntity name={label}>
            <a href={resourceHref(next.id)} data-focus-key={`course-next-${card.key}`}>
              {label.label}
            </a>
          </InlineEntity>
          <span className="ci-due-line">
            {/* A disputed saved date is never shown as a confirmed deadline or urgency cue. */}
            {dueCue ? (
              <span className="ci-flag">{dueCue}</span>
            ) : due ? (
              <span className="ci-due" {...deadlineSurface(emphasis.bin, typeHue)}>
                <time dateTime={due}>
                  {emphasis.label ?? day(due, timeZone)} · {time(due, timeZone)}
                </time>
              </span>
            ) : null}
          </span>
        </div>
      ) : (
        <p className="ci-quiet">
          {emptyNextText(card)}
          {card.undated ? <span>{undatedText(card.undated)}</span> : null}
        </p>
      )}
    </li>
  );
}

const day = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone }).format(new Date(iso));
const time = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
const checked = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

function coverageText(group: CoverageGroup, all: boolean): string {
  const who = all ? "" : `${group.cards.map((c) => c.code ?? c.courseName).join(", ")}: `;
  if (group.freshness === "unknown") return `${who}not checked in Canvas yet.`;
  if (group.freshness === "partial")
    return `${who}${all ? "Partly" : "partly"} checked${group.checkedAt ? ` on ${checked(group.checkedAt)}` : ""}. Some coursework may be missing.`;
  return `${who}${all ? "Saved" : "saved"} copy${group.checkedAt ? ` from ${checked(group.checkedAt)}` : ""}. Newer changes in Canvas may be missing.`;
}
