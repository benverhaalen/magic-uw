import type { ReactNode } from "react";
import type { ResourceView } from "@magic/contracts";
import {
  isDone,
  whenDue,
  type CourseCard,
  type CourseFact,
  type CourseFactKind,
  type CoursePage as CoursePageModel,
} from "../../../../../packages/domain/src/course-page";
import { Glyph } from "../DesktopShell";
import { courseTone } from "../Home";
import {
  courseWork,
  freshnessText,
  groupSummary,
  shownFacts,
  unknownFacts,
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
              {card.next ? <span className="muted"> · {when(whenDue(card.next))}</span> : null}
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

/** Distinguishes a genuinely separate Canvas assignment that shares a title, and names date disagreement. */
function identityNotes(entry: WorkEntry): string[] {
  return [
    entry.sameTitleElsewhere ? `Canvas id ${entry.resource.externalId}` : "",
    entry.dueDiffers ? "Canvas lists disagree on the due date" : "",
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
  const due = whenDue(resource);
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
            due ? `Due ${when(due)}` : "No due date",
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
  open,
  selectedId,
  onSelect,
}: {
  group: WorkGroup;
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

function NextRow({ item, onSelect }: { item: NextItem; onSelect: (id: string) => void }) {
  const r = item.entry.resource;
  const due = new Date(whenDue(r)!);
  return (
    <li>
      <button
        className={`course-next-row tone-${courseTone(`${r.sourceId}:${r.courseId}`)}`}
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
          <strong>{new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(due)}</strong>
          <span>{new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(due)}</span>
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

export function CoursePageView({
  page,
  selectedId,
  onSelect,
  onBack,
  open,
  detail,
}: {
  page: CoursePageModel;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onBack: () => void;
  open: (url: string) => void;
  /** The shared resource detail, so an item opened here is the same object as on Home. */
  detail: ReactNode;
}) {
  const syllabus = page.syllabus;
  const work = courseWork(page);
  const next = work.next;
  const moreDated = work.counts.upcoming - next.length;
  const undatedOpen = work.counts.undatedOpen;
  const facts = shownFacts(page);
  const unknown = unknownFacts(page);
  const status = freshnessText(page, (iso) => when(iso, true));
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
          <span className={status.attention ? "course-status attention-text" : "course-status"}>{status.text}</span>
        </p>
      </div>
      <div className={`course-layout ${selectedId ? "has-detail" : ""}`}>
        <div className="course-main">
          <section className="course-section" aria-labelledby="course-next">
            <h2 id="course-next">Next up</h2>
            {next.length ? (
              <ul className="course-next">
                {next.map((item) => (
                  <NextRow key={item.entry.key} item={item} onSelect={onSelect} />
                ))}
              </ul>
            ) : (
              <p className="course-quiet">
                {work.counts.total
                  ? `No dated work ahead in the saved Canvas records${page.freshness !== "current_capture" ? ", which may be out of date" : ""}.`
                  : "No assignments captured for this course."}
              </p>
            )}
          </section>

          {work.rest.length ? (
            <section className="course-section" aria-labelledby="course-work">
              <h2 id="course-work">
                {next.length ? "More coursework" : "Coursework"}
                {moreDated || undatedOpen ? (
                  <span className="course-count">
                    {[moreDated ? `${moreDated} more dated` : "", undatedOpen ? `${undatedOpen} without a due date` : ""]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                ) : null}
              </h2>
              {work.rest.map((group) => (
                <Group
                  key={group.id ?? "other"}
                  group={group}
                  open={work.rest.length === 1}
                  selectedId={selectedId}
                  onSelect={onSelect}
                />
              ))}
            </section>
          ) : null}

          <section className="course-section" aria-labelledby="course-how">
            <h2 id="course-how">How this course works</h2>
            <p className="course-quiet">
              {syllabus.state === "canvas" ? (
                <>
                  From the{" "}
                  <button className="link-button" onClick={() => open(syllabus.resource.url)}>
                    Canvas syllabus
                  </button>{" "}
                  and course records.
                </>
              ) : syllabus.state === "file" ? (
                <>
                  Syllabus file:{" "}
                  <button className="link-button" onClick={() => open(syllabus.resource.url)}>
                    {syllabus.resource.title}
                  </button>
                  . Not read for policy or grading yet.
                </>
              ) : (
                "No syllabus captured. Details come from Canvas records."
              )}
            </p>
            {facts.map((kind) =>
              kind === "grading" ? (
                <FactRow key={kind} label={factLabel[kind]} fact={page.facts.grading} open={open}>
                  {page.weights.some((w) => w.weight != null) ? (
                    <>
                      <table className="course-weights">
                        <tbody>
                          {page.weights.map((w) => (
                            <tr key={w.groupId}>
                              <th scope="row">{w.name}</th>
                              <td>{w.weight != null ? `${w.weight}%` : "Not listed"}</td>
                              <td className="muted">
                                {[
                                  w.dropLowest ? `drops lowest ${w.dropLowest}` : "",
                                  w.dropHighest ? `drops highest ${w.dropHighest}` : "",
                                ]
                                  .filter(Boolean)
                                  .join(", ")}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="course-quiet">
                        Weights as listed in Canvas. Canvas may not apply them to your final grade.
                      </p>
                    </>
                  ) : null}
                </FactRow>
              ) : (
                <FactRow key={kind} label={factLabel[kind]} fact={page.facts[kind]} open={open} />
              ),
            )}
            {unknown.names.length ? (
              <p className="course-unknowns">
                Not found in saved sources: {unknown.names.join(", ")}.
                {unknown.aiMissing ? " Without a stated AI policy, ask your instructor before using AI." : ""}
              </p>
            ) : null}
          </section>

          {/* T43: the notebook replaces this section with its tiers for the same course key. */}
          <section className="course-section course-materials" aria-labelledby="course-materials">
            <h2 id="course-materials">
              Materials
              {materialCount ? <span className="course-count">{materialCount}</span> : null}
            </h2>
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
        </div>
        {selectedId ? detail : null}
      </div>
    </>
  );
}
