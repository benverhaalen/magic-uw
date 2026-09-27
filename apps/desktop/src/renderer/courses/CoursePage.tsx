import type { ReactNode } from "react";
import type { ResourceView } from "@magic/contracts";
import {
  whenDue,
  type CourseCard,
  type CourseFact,
  type CoursePage as CoursePageModel,
  type CourseWorkGroup,
} from "../../../../../packages/domain/src/course-page";
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
const freshnessLabel = (page: Pick<CoursePageModel, "freshness" | "lastSuccessAt">) =>
  page.freshness === "current_capture"
    ? `Checked ${when(page.lastSuccessAt, true)}`
    : page.freshness === "partial"
      ? `Partly checked ${when(page.lastSuccessAt, true)}`
      : page.freshness === "stale"
        ? page.lastSuccessAt
          ? `May be out of date · last checked ${when(page.lastSuccessAt, true)}`
          : "Not checked yet"
        : "Freshness unknown";

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
        <h1>Courses</h1>
      </div>
      <div className="course-cards">
        {cards.map((card) => (
          <button
            key={card.key}
            className="course-card"
            data-course-key={card.key}
            onClick={() => onOpen(card.key)}
          >
            <span className="course-card-name">{card.courseName}</span>
            {card.code ? <span className="course-card-code">{card.code}</span> : null}
            <span className="course-card-cue">
              {card.cue}
              {card.next ? <span className="muted"> · {when(whenDue(card.next))}</span> : null}
            </span>
            {card.freshness === "stale" || card.syllabusMissing ? (
              <span className="course-card-note">
                {card.freshness === "stale" ? "May be out of date" : "Syllabus not captured"}
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

function Evidence({ fact, open }: { fact: CourseFact; open: (url: string) => void }) {
  const evidence = fact.items.flatMap((item) => item.evidence).slice(0, 4);
  if (!evidence.length) return null;
  return (
    <details className="course-evidence">
      <summary>Source</summary>
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
  missing,
  open,
  children,
}: {
  label: string;
  fact: CourseFact;
  missing: string;
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
          <p className="muted">
            {exceptions.length === 1
              ? `${exceptions[0]!.assignmentTitle} has its own policy.`
              : `${exceptions.length} assignments have their own policy.`}
          </p>
        ) : null}
        {!children && fact.state === "not_found" ? <p className="muted">{missing}</p> : null}
        <Evidence fact={fact} open={open} />
      </div>
    </div>
  );
}

function WorkRow({
  resource,
  selected,
  onSelect,
}: {
  resource: ResourceView;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const due = whenDue(resource);
  const done = resource.completed || resource.submitted === true;
  return (
    <li className={`course-row ${selected ? "selected" : ""} ${done ? "is-complete" : ""}`}>
      <button onClick={() => onSelect(resource.id)} aria-current={selected ? "true" : undefined}>
        <span className="resource-title">{resource.title}</span>
        <span className="resource-subline">
          {due ? `Due ${when(due)}` : "No due date"}
          {resource.points != null ? ` · ${resource.points} pts` : ""}
          {resource.submitted === true ? " · Submitted" : resource.completed ? " · Marked done" : ""}
          {resource.submission?.grade ? ` · ${resource.submission.grade}` : ""}
        </span>
      </button>
    </li>
  );
}

function Group({
  group,
  selectedId,
  onSelect,
}: {
  group: CourseWorkGroup;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const row = (r: ResourceView) => (
    <WorkRow key={r.id} resource={r} selected={r.id === selectedId} onSelect={onSelect} />
  );
  return (
    <section className="course-group">
      <h3>
        {group.name}
        {group.weight ? <span className="badge">{group.weight}% listed</span> : null}
      </h3>
      <ul>
        {group.upcoming.map(row)}
        {group.undated.map(row)}
      </ul>
      {group.past.length ? (
        <details className="course-past">
          <summary>
            {group.past.length} past or finished
          </summary>
          <ul>{group.past.map(row)}</ul>
        </details>
      ) : null}
    </section>
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
  const weighted = page.weights.filter((w) => w.weight);
  return (
    <>
      <div className="page-heading">
        <div>
          <button className="subtle-button course-back" onClick={onBack}>
            ← Courses
          </button>
          <h1>{page.courseName}</h1>
          <p className="course-subline">
            {[page.code, page.term].filter(Boolean).join(" · ")}
            {page.code || page.term ? " · " : ""}
            <span className={page.freshness === "current_capture" ? "" : "attention-text"}>
              {freshnessLabel(page)}
            </span>
          </p>
        </div>
      </div>
      {page.needsSignIn ? (
        <div className="evidence-note" role="status">
          <p>Canvas needs sign-in before this course can be checked again. Saved coursework is shown.</p>
        </div>
      ) : null}
      <div className={`course-layout ${selectedId ? "has-detail" : ""}`}>
        <div className="course-main">
          <section className="course-section" aria-labelledby="course-how">
            <h2 id="course-how">How this course works</h2>
            <p className="course-syllabus muted">
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
                  Syllabus file found:{" "}
                  <button className="link-button" onClick={() => open(syllabus.resource.url)}>
                    {syllabus.resource.title}
                  </button>
                  . It isn't read for policy or grading yet.
                </>
              ) : (
                "No syllabus captured for this course. Facts below come from Canvas records."
              )}
            </p>
            <FactRow
              label="AI use"
              fact={page.facts.ai_policy}
              missing="No AI policy found in captured sources. That isn't permission — check with your instructor."
              open={open}
            />
            <FactRow
              label="Grading"
              fact={page.facts.grading}
              missing="No grading breakdown found in captured sources."
              open={open}
            >
              {weighted.length ? (
                <>
                  <table className="course-weights">
                    <tbody>
                      {page.weights.map((w) => (
                        <tr key={w.groupId}>
                          <th scope="row">{w.name}</th>
                          <td>{w.weight != null ? `${w.weight}%` : "—"}</td>
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
                  <p className="muted">
                    Weights as listed in Canvas. Canvas may not apply them to your final grade.
                  </p>
                </>
              ) : null}
            </FactRow>
            <FactRow
              label="Exams & assessments"
              fact={page.facts.assessment}
              missing="No exam or assessment details recognized."
              open={open}
            />
            {page.facts.topic.state !== "not_found" ? (
              <FactRow label="Topics" fact={page.facts.topic} missing="" open={open} />
            ) : null}
          </section>

          <section className="course-section" aria-labelledby="course-work">
            <h2 id="course-work">
              Coursework
              {page.counts.dueThisWeek ? (
                <span className="badge">{page.counts.dueThisWeek} due this week</span>
              ) : null}
            </h2>
            {page.groups.length ? (
              page.groups.map((group) => (
                <Group key={group.id ?? "other"} group={group} selectedId={selectedId} onSelect={onSelect} />
              ))
            ) : (
              <p className="muted">No assignments captured for this course.</p>
            )}
          </section>

          {/* T43: the notebook replaces this section with its tiers for the same course key. */}
          <section className="course-section" aria-labelledby="course-materials">
            <h2 id="course-materials">Materials</h2>
            {page.modules ? (
              page.modules.map((module, index) => (
                <details key={module.id} className="course-module" open={index === 0}>
                  <summary>
                    {module.name} <span className="muted">· {module.items.length}</span>
                  </summary>
                  <ul>
                    {module.items.map((r) => (
                      <li key={r.id} className={`course-row ${r.id === selectedId ? "selected" : ""}`}>
                        <button onClick={() => onSelect(r.id)}>
                          <span className="resource-title">{r.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              ))
            ) : null}
            {page.materials.length ? (
              <details className="course-module" open={!page.modules}>
                <summary>
                  {page.modules ? "Other files and pages" : "Files, pages and module items"}{" "}
                  <span className="muted">· {page.materials.length}</span>
                </summary>
                <ul>
                  {page.materials.map((r) => (
                    <li key={r.id} className={`course-row ${r.id === selectedId ? "selected" : ""}`}>
                      <button onClick={() => onSelect(r.id)}>
                        <span className="resource-title">{r.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {!page.modules && !page.materials.length ? (
              <p className="muted">No course materials captured.</p>
            ) : null}
          </section>
        </div>
        {selectedId ? detail : null}
      </div>
    </>
  );
}
