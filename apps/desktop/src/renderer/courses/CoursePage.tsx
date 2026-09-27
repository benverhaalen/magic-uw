import type { ReactNode } from "react";
import type { ResourceView } from "@magic/contracts";
import {
  isDone,
  courseDeadlineDisplay,
  type CourseCard,
  type CourseFact,
  type CourseFactKind,
  type CoursePage as CoursePageModel,
} from "../../../../../packages/domain/src/course-page";
import { localTime } from "../../../../../packages/domain/src/today-rail";
// Shared primitives from the evidence-info lane (codex/evidence-info). Final paths are the integration contract.
import { EvidenceInfo } from "../../../../../packages/ui/src/evidence-info";
import {
  createAssignmentTypeHues,
  deadlineEmphasis,
  deadlineSurface,
  type AssignmentTypeHue,
  type IdentityHue,
} from "../../../../../packages/ui/src/deadline-emphasis";
import "../../../../../packages/ui/src/evidence-info.css";
import "../../../../../packages/ui/src/deadline-emphasis.css";
import { Glyph } from "../DesktopShell";
import {
  courseWork,
  dueCivilDate,
  freshnessText,
  gradeWeights,
  groupSummary,
  nextClass,
  shownFacts,
  unknownFacts,
  groupHues,
  pageTypeGroups,
  type CourseSchedule,
  type GradeWeights,
  type NextItem,
  type WorkEntry,
  type WorkGroup,
} from "./course-view";
import "./courses.css";

// owner: course page. The frame the notebook (T43) fills later: its Sources/Notes/Studio replace
// the Materials section below for the same course key. Everything here renders from saved evidence.

function when(value: string | null, withYear = false): string {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    weekday: withYear ? undefined : "short",
    month: "short",
    day: "numeric",
    year: withYear ? "numeric" : undefined,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
export function CoursesOverview({
  cards,
  onOpen,
}: {
  cards: CourseCard[];
  onOpen: (key: string) => void;
}) {
  return (
    <>
      <div className="page-heading">
        <h1 tabIndex={-1}>Courses</h1>
      </div>
      <div className="course-cards">
        {cards.map((card) => (
          <button
            key={card.key}
            className="course-card"
            data-course-key={card.key}
            data-focus-key={`course-card-${card.key}`} data-place-anchor={`course-card-${card.key}`}
            onClick={() => onOpen(card.key)}
          >
            <span className="course-card-name" title={card.rawCourseName}>{card.courseName}</span>
            {card.code ? <span className="course-card-code">{card.code}</span> : null}
            <span className="course-card-cue">
              {card.cue}
              {card.next ? <span className="muted"> · {(card.nextDeadline ?? courseDeadlineDisplay(card.next)).cue ?? when((card.nextDeadline ?? courseDeadlineDisplay(card.next)).displayAt)}</span> : null}
            </span>
            {card.freshness === "stale" || card.freshness === "partial" ? (
              <span className="course-card-note">
                {card.freshness === "stale" ? "Saved copy, may be out of date" : "Partly checked"}
              </span>
            ) : null}
          </button>
        ))}
        {!cards.length ? (
          <p className="muted">Connect Canvas from Home to see your courses here.</p>
        ) : null}
      </div>
    </>
  );
}

const Chevron = () => (
  <span className="course-chevron" aria-hidden="true">
    <Glyph name="chevron" />
  </span>
);

function Evidence({ fact, open }: { fact: CourseFact; open: (url: string) => void }) {
  const evidence = fact.items.flatMap((item) => item.evidence).slice(0, 4);
  if (!evidence.length) return null;
  return (
    <details className="course-evidence">
      <summary><Chevron />Source</summary>
      {evidence.map((e, index) => (
        <figure key={`${e.resourceId}:${index}`}>
          <blockquote>{e.quote.length > 600 ? `${e.quote.slice(0, 600)}…` : e.quote}</blockquote>
          <figcaption>
            <button className="link-button" onClick={() => open(e.url)}>
              {e.title}
            </button>
          </figcaption>
        </figure>
      ))}
    </details>
  );
}

function FactRow({
  label,
  fact,
  open,
  children,
}: {
  label: string;
  fact: CourseFact;
  open: (url: string) => void;
  children?: ReactNode;
}) {
  const course = fact.items.filter((item) => !item.assignmentTitle);
  const exceptions = fact.items.filter((item) => item.assignmentTitle);
  return (
    <div className="course-fact">
      <h3>{label}</h3>
      <div className="course-fact-body">
        {fact.state === "conflict" ? (
          <p className="attention-text">Sources disagree. Compare them before relying on this.</p>
        ) : null}
        {children}
        {course.slice(0, 3).map((item, index) => (
          <p key={index} className="course-fact-text">
            {item.text.length > 280 ? `${item.text.slice(0, 280)}…` : item.text}
            {item.method === "local_model" ? <span className="badge">Found by local model</span> : null}
          </p>
        ))}
        {exceptions.length ? (
          <p className="course-quiet">
            {exceptions.length === 1
              ? `${exceptions[0]!.assignmentTitle} has its own policy.`
              : `${exceptions.length} assignments have their own policy.`}
          </p>
        ) : null}
        <Evidence fact={fact} open={open} />
      </div>
    </div>
  );
}

const itemType: Record<string, string> = {
  File: "File",
  Page: "Page",
  ExternalUrl: "Link",
  ExternalTool: "Tool",
  Quiz: "Quiz",
  Discussion: "Discussion",
  Assignment: "Assignment",
};

/** Distinguishes a genuinely separate Canvas assignment that shares a title. */
function identityNotes(entry: WorkEntry): string[] {
  return [
    entry.sameTitleElsewhere ? `Canvas id ${entry.resource.externalId}` : "",
  ].filter(Boolean);
}

function WorkRow({
  entry,
  selected,
  onSelect,
}: {
  entry: WorkEntry;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const resource = entry.resource;
  const deadline = courseDeadlineDisplay(resource, entry.copies);
  const done = isDone(resource);
  return (
    <li className={`course-row ${selected ? "selected" : ""} ${done ? "is-complete" : ""}`}>
      <button
        data-focus-key={`course-work-${resource.id}`}
        data-place-anchor={`course-work-${resource.id}`}
        data-resource-ids={entry.copies.map((c) => c.id).join(" ")}
        onClick={() => onSelect(resource.id)}
        aria-current={selected ? "true" : undefined}
      >
        <span className="resource-title">{resource.title}</span>
        <span className="resource-subline">
          {[
            deadline.cue ?? (deadline.displayAt ? `Due ${when(deadline.displayAt)}` : "No due date"),
            resource.points != null ? `${resource.points} pts` : "",
            resource.submitted === true ? "Submitted" : resource.completed ? "Marked done" : "",
            resource.submission?.grade ? `Canvas grade ${resource.submission.grade}` : "",
            ...identityNotes(entry),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </button>
    </li>
  );
}

function Group({
  group,
  hue,
  open,
  selectedId,
  onSelect,
}: {
  group: WorkGroup;
  hue: IdentityHue | null;
  open: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const row = (e: WorkEntry) => (
    <WorkRow key={e.key} entry={e} selected={e.resource.id === selectedId} onSelect={onSelect} />
  );
  const key = group.id ?? "other";
  return (
    <details className="course-group" data-place-disclosure={`group-${key}`} open={open}>
      <summary>
        <Chevron />
        <TypeSwatch hue={hue} />
        <span className="course-group-name">{group.name}</span>
        <span className="course-group-counts">{groupSummary(group)}</span>
      </summary>
      <ul>
        {group.upcoming.map(row)}
        {group.undated.map(row)}
      </ul>
      {group.past.length ? (
        <details className="course-past" data-place-disclosure={`past-${key}`}>
          <summary><Chevron />{group.past.length} past or finished</summary>
          <ul>{group.past.map(row)}</ul>
        </details>
      ) : null}
    </details>
  );
}

/** A small mark in the type's hue beside its explicit name; color is never the only label. */
function TypeSwatch({ hue }: { hue: IdentityHue | null }) {
  return hue ? <span className="course-type-swatch" data-magic-hue={hue} aria-hidden="true" /> : null;
}

function NextRow({
  item,
  hue,
  today,
  timeZone,
  onSelect,
}: {
  item: NextItem;
  /** The verified assignment type's hue; null (neutral) when Canvas lists no group for it. */
  hue: IdentityHue | null;
  today: string;
  timeZone: string;
  onSelect: (id: string) => void;
}) {
  const r = item.entry.resource;
  const deadline = courseDeadlineDisplay(r, item.entry.copies);
  const due = deadline.displayAt ? new Date(deadline.displayAt) : null;
  // The type's hue; the shared recipe strengthens it as the local due date gets closer.
  const emphasis = deadlineEmphasis({ today, due: deadline.displayAt ? dueCivilDate(r, timeZone) : null, completed: isDone(r) || undefined });
  return (
    <li>
      <button
        className={hue ? "course-next-row" : "course-next-row is-untyped"}
        {...deadlineSurface(emphasis.bin, hue)}
        data-focus-key={`course-next-${r.id}`}
        data-place-anchor={`course-next-${r.id}`}
        data-resource-ids={item.entry.copies.map((c) => c.id).join(" ")}
        onClick={() => onSelect(r.id)}
      >
        <span className="course-next-main">
          <span className="course-next-meta">
            {item.group}
            {r.points != null ? <span>{r.points} pts</span> : null}
            {identityNotes(item.entry).map((note) => (
              <span key={note}>{note}</span>
            ))}
          </span>
          <span className="course-next-title">{r.title}</span>
        </span>
        <span className="course-next-due">
          <strong>
            {emphasis.label && emphasis.bin !== "unknown" ? <em>{emphasis.label}</em> : null}
            {deadline.cue ?? (due ? new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(due) : "No due date")}
          </strong>
          <span>{deadline.conflict ? "Review dates" : due ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(due) : null}</span>
        </span>
        <Glyph name="chevron" />
      </button>
    </li>
  );
}

function MaterialRow({
  resource,
  selected,
  onSelect,
}: {
  resource: ResourceView;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const type = resource.moduleItem?.type;
  return (
    <li className={`course-row ${selected ? "selected" : ""}`}>
      <button className="course-material" data-focus-key={`course-material-${resource.id}`} data-place-anchor={`course-material-${resource.id}`} onClick={() => onSelect(resource.id)}>
        <span className="resource-title">{resource.title}</span>
        {type && itemType[type] ? <span className="course-material-type">{itemType[type]}</span> : null}
      </button>
    </li>
  );
}

/**
 * Canvas category weights as listed: aligned names, exact right-aligned percentages and a bar on a
 * fixed 0 to 100 scale in each type's own hue. Partial totals stay partial; no assignment impact.
 */
function GradeScale({ grades, hueOf }: { grades: GradeWeights; hueOf: (groupId: string) => IdentityHue | null }) {
  return (
    <ul className="course-grades">
      {grades.rows.map((w) => (
        <li key={w.groupId} className="course-grade" data-magic-hue={hueOf(w.groupId) ?? undefined}>
          <span className="course-grade-name">
            {w.name}
            {w.rules ? <span className="course-grade-rule">{w.rules}</span> : null}
          </span>
          <span className={w.weight != null ? "course-grade-value" : "course-grade-value is-missing"}>
            {w.weight != null ? `${w.weight}%` : "Not listed"}
          </span>
          <span className="course-grade-bar" aria-hidden="true">
            {w.weight != null ? <span style={{ width: `${w.bar}%` }} /> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function minuteText(minute: number): string {
  const d = new Date(Date.UTC(2000, 0, 1, Math.floor(minute / 60), minute % 60));
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(d);
}

export function CoursePageView({
  page,
  selectedId,
  onSelect,
  onBack,
  open,
  detail,
  schedule,
  typeHueOf,
}: {
  page: CoursePageModel;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onBack: () => void;
  open: (url: string) => void;
  /** The shared resource detail, so an item opened here is the same object as on Home. */
  detail: ReactNode;
  /**
   * Verified class meetings linked to exactly this Canvas course. Unbound until the backend links
   * Canvas courses to enrollment records; see docs/plans/2026-09-27-course-brief.md.
   */
  schedule?: CourseSchedule | null;
  /**
   * The app-wide type-hue mapper, `createAssignmentTypeHues(snapshot.resources)`, the same instance
   * Home and Calendar use so an assignment keeps one hue everywhere. Unbound, the page builds the
   * mapper from its own verified groups (identical for rows from the groups' own source).
   */
  typeHueOf?: (r: { sourceId: string; courseId: string; assignmentGroupId?: string | null }) => AssignmentTypeHue | null;
}) {
  const syllabus = page.syllabus;
  const work = courseWork(page);
  const next = work.next;
  const moreDated = work.counts.upcoming - next.length;
  const undatedOpen = work.counts.undatedOpen;
  const facts = shownFacts(page).filter((kind) => kind !== "grading");
  const unknown = unknownFacts(page);
  const grades = gradeWeights(page);
  const gradingText = page.facts.grading;
  const status = freshnessText(page, (iso) => when(iso, true));
  const nowIso = new Date().toISOString();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = localTime(nowIso, timeZone).date;
  const upcomingClass = nextClass(schedule, nowIso);
  // Each verified assignment type (Canvas group) has its own hue from the shared mapper; ungrouped is neutral.
  const typeHue = typeHueOf ?? createAssignmentTypeHues(pageTypeGroups(page, work));
  const hues = groupHues(page, work, (r) => typeHue(r)?.hue ?? null);
  const hueOf = (groupId: string | null): IdentityHue | null => (groupId == null ? null : hues.get(groupId) ?? null);
  // The concise label the sidebar already shows, then the course's own title as detail. No new shortening.
  const label = page.code || page.courseName;
  const officialTitle = page.code ? page.courseName : null;
  const materialCount = (page.modules ?? []).reduce((n, m) => n + m.items.length, 0) + page.materials.length;
  const factLabel: Record<CourseFactKind, string> = {
    ai_policy: "AI use",
    grading: "Grading",
    assessment: "Exams and assessments",
    topic: "Topics",
  };
  const otherMissing = unknown.names.filter((name) => name !== "AI use policy" && name !== "grading breakdown");
  const syllabusNote =
    syllabus.state === "canvas"
      ? "Read from the Canvas syllabus and course records."
      : syllabus.state === "file"
        ? `The syllabus file (${syllabus.resource.title}) is saved but not read for policy or grading yet.`
        : "No syllabus captured. Details come from Canvas records.";
  const workSummary = [
    moreDated ? `${moreDated} more dated` : "",
    undatedOpen ? `${undatedOpen} without a due date` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // The overview exists only when it has something verified to say; no empty right column.
  const hasOverview = !!grades || gradingText.state !== "not_found" || facts.length > 0 || !!upcomingClass;
  const overview = hasOverview ? (
    <aside className="course-overview" aria-label="Course overview">
      {grades || gradingText.state !== "not_found" ? (
        <section aria-labelledby="course-grading">
          <h2 id="course-grading">
            Grading
            <EvidenceInfo label="About grading sources">
              {grades ? "Category weights as listed on the course's Canvas assignment groups. Canvas may not use them for your final grade, and they do not say what a single assignment is worth. " : ""}
              {syllabusNote}
            </EvidenceInfo>
          </h2>
          {grades ? <GradeScale grades={grades} hueOf={hueOf} /> : null}
          {grades && (grades.listedTotal !== 100 || grades.unlisted) ? (
            <p className="course-overview-note">
              Listed weights add to {grades.listedTotal}%
              {grades.unlisted ? `; ${grades.unlisted} ${grades.unlisted === 1 ? "category has" : "categories have"} no weight` : ""}.
            </p>
          ) : null}
          {gradingText.state !== "not_found" ? (
            <div className="course-grading-text">
              {gradingText.state === "conflict" ? (
                <p className="attention-text">Sources disagree. Compare them before relying on this.</p>
              ) : null}
              {gradingText.items.filter((item) => !item.assignmentTitle).slice(0, 2).map((item, index) => (
                <p key={index}>
                  {item.text.length > 200 ? `${item.text.slice(0, 200)}…` : item.text}
                  {item.method === "local_model" ? <span className="badge">Found by local model</span> : null}
                </p>
              ))}
              <Evidence fact={gradingText} open={open} />
            </div>
          ) : null}
        </section>
      ) : null}
      <section aria-labelledby="course-class">
        <h2 id="course-class">
          Next class
          {!upcomingClass ? (
            <EvidenceInfo label="About class times">
              Class times come only from your enrollment record for this exact course. That record is not linked to this Canvas course yet, so no time is shown.
            </EvidenceInfo>
          ) : null}
        </h2>
        {upcomingClass ? (
          <p className="course-class">
            <strong>
              {new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(
                new Date(`${upcomingClass.date}T00:00:00Z`),
              )}
            </strong>
            <span>
              {minuteText(upcomingClass.startMinute)} to {minuteText(upcomingClass.endMinute)}
              {upcomingClass.location ? ` · ${upcomingClass.location}` : ""}
            </span>
          </p>
        ) : (
          <p className="course-overview-note">Not linked yet</p>
        )}
      </section>
      {facts.length || unknown.aiMissing ? (
        <section aria-labelledby="course-rules">
          <h2 id="course-rules">
            Course rules
            {otherMissing.length ? (
              <EvidenceInfo label="About course rules">Not found in saved sources: {otherMissing.join(", ")}.</EvidenceInfo>
            ) : null}
          </h2>
          {facts.map((kind) => (
            <FactRow key={kind} label={factLabel[kind]} fact={page.facts[kind]} open={open} />
          ))}
          {unknown.aiMissing ? (
            <p className="course-overview-cue">No AI use policy found. Ask your instructor before using AI.</p>
          ) : null}
        </section>
      ) : null}
    </aside>
  ) : null;
  return (
    <>
      <div className="page-heading course-heading">
        <button className="course-back" aria-label="Back to Courses" onClick={onBack}>
          <Glyph name="back" />
          Courses
        </button>
        <h1 tabIndex={-1} title={page.rawCourseName}>{label}</h1>
        <p className="course-subline">
          {officialTitle || page.term ? <span>{[officialTitle, page.term].filter(Boolean).join(" · ")}</span> : null}
          <span className="course-status">
            {status.cue ? <span className="attention-text">{status.cue}</span> : null}
            <EvidenceInfo label="About this course's saved copy">{status.text}.</EvidenceInfo>
          </span>
        </p>
      </div>
      <div className={`course-layout ${selectedId ? "has-detail" : overview ? "has-overview" : ""}`}>
        <section className="course-section course-next-section" aria-labelledby="course-next">
          <h2 id="course-next">Next up</h2>
          {next.length ? (
            <ul className="course-next">
              {next.map((item) => (
                <NextRow
                  key={item.entry.key}
                  item={item}
                  hue={hueOf(item.groupId)}
                  today={today}
                  timeZone={timeZone}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          ) : (
            <p className="course-quiet">
              {work.counts.total
                ? `No dated work ahead in the saved Canvas records${page.freshness !== "current_capture" ? ", which may be out of date" : ""}.`
                : "No assignments captured for this course."}
            </p>
          )}
          {work.rest.length ? (
            <details className="course-index" data-place-disclosure="coursework-index">
              <summary>
                <Chevron />
                <span className="course-index-name">{next.length ? "More coursework" : "All coursework"}</span>
                {workSummary ? <span className="course-group-counts">{workSummary}</span> : null}
              </summary>
              {work.rest.map((group) => (
                <Group
                  key={group.id ?? "other"}
                  group={group}
                  hue={hueOf(group.id)}
                  open={work.rest.length === 1}
                  selectedId={selectedId}
                  onSelect={onSelect}
                />
              ))}
            </details>
          ) : null}
        </section>

        {selectedId ? null : overview}

        {/* T43: the notebook replaces this section with its tiers for the same course key. */}
        <section className="course-section course-materials" aria-labelledby="course-materials">
          <h2 id="course-materials">
            Materials
            {materialCount ? <span className="course-count">{materialCount}</span> : null}
          </h2>
          {/* A syllabus file is already a material row; the Canvas syllabus page is not. */}
          {syllabus.state === "canvas" ? (
            <p className="course-syllabus">
              <button className="link-button" onClick={() => open(syllabus.resource.url)}>
                Canvas syllabus
              </button>
            </p>
          ) : null}
            {page.modules
              ? page.modules.map((module, index) => (
                  <details
                    key={module.id}
                    className="course-module"
                    data-place-disclosure={`module-${module.id}`}
                    open={index === 0 && module.items.length <= 15}
                  >
                    <summary>
                      <Chevron />
                      {module.name} <span className="muted">{module.items.length}</span>
                    </summary>
                    <ul>
                      {module.items.map((r) => (
                        <MaterialRow key={r.id} resource={r} selected={r.id === selectedId} onSelect={onSelect} />
                      ))}
                    </ul>
                  </details>
                ))
              : null}
            {page.materials.length ? (
              <details className="course-module" data-place-disclosure="other-materials" open={!page.modules && page.materials.length <= 15}>
                <summary>
                  <Chevron />
                  {page.modules ? "Other files and pages" : "Files, pages and module items"}{" "}
                  <span className="muted">{page.materials.length}</span>
                </summary>
                <ul>
                  {page.materials.map((r) => (
                    <MaterialRow key={r.id} resource={r} selected={r.id === selectedId} onSelect={onSelect} />
                  ))}
                </ul>
              </details>
            ) : null}
            {!materialCount ? <p className="course-quiet">No course materials captured.</p> : null}
        </section>
        {selectedId ? detail : null}
      </div>
    </>
  );
}
