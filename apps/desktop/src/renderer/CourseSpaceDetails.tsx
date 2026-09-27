import { useEffect, useState } from "react";
import type { CourseSpace, SourceHealth } from "@magic/contracts";

const accessLabels: Record<CourseSpace["accessState"], string> = {
  unknown: "Access not checked",
  readable: "Access checked successfully",
  "needs-uw-signin": "UW sign-in needed",
  "needs-own-login": "Separate sign-in needed",
  "link-only": "Open in original service",
  blocked: "Access unavailable",
};
/**
 * The courses whose material the app reads: a Canvas course with any area beyond its own course
 * row. Canvas also lists past-term enrollments (metadata only) and non-course sites (orientations,
 * advising, excluded by selection); those have only the course row and no material to check.
 */
export function readCourseSources(sources: SourceHealth[]): { read: SourceHealth[]; listedOnly: number } {
  const canvas = sources.filter((s) => s.kind === "canvas" && !["account", "connection"].includes(s.courseId));
  const key = (s: SourceHealth) => JSON.stringify([s.accountScope, s.courseId]);
  const read = new Set(canvas.filter((s) => s.scope !== "course").map(key));
  const all = new Map<string, SourceHealth>();
  // Prefer the course row as the representative source (its label names the course).
  for (const s of [...canvas].sort((a, b) => Number(a.scope === "course") - Number(b.scope === "course"))) all.set(key(s), s);
  const courses = [...all.entries()];
  return {
    read: courses.filter(([k]) => read.has(k)).map(([, s]) => s),
    listedOnly: courses.filter(([k]) => !read.has(k)).length,
  };
}
/** Course detail within Sources; saved material and current access are independent facts. */
export function CourseSpaceDetails({
  sources,
  revision,
}: {
  sources: SourceHealth[];
  revision: string;
}) {
  const { read: courses, listedOnly } = readCourseSources(sources);
  return (
    <>
      {listedOnly > 0 && (
        <p className="small muted">
          {listedOnly} other Canvas site{listedOnly === 1 ? " is" : "s are"} listed but not read: past-term courses (kept as course history only) and non-course sites such as orientations.
        </p>
      )}
      {courses.map((source) => (
        <CourseSpaces
          key={JSON.stringify([source.accountScope, source.courseId])}
          source={source}
          revision={revision}
        />
      ))}
    </>
  );
}
function CourseSpaces({
  source,
  revision,
}: {
  source: SourceHealth;
  revision: string;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<CourseSpace[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setItems(null);
    setError(false);
    if (!window.magic.query) {
      setError(true);
      return;
    }
    void window.magic
      .query({
        view: "courseSpaces",
        accountScope: source.accountScope,
        courseId: source.courseId,
      })
      .then((result) => {
        if (active && result.view === "courseSpaces") setItems(result.items);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [open, source.accountScope, source.courseId, revision]);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Material access · {source.label}</summary>
      {open && (
        <div className="source-list">
          <p className="small muted">
            Saved material remains available when current access is restricted.
            Each check describes only that item.
          </p>
          {error ? (
            <p>
              Access details could not be loaded. Reopen these details to retry.
            </p>
          ) : items === null ? (
            <p>Loading access details…</p>
          ) : !items.length ? (
            <p>No material access observations saved yet.</p>
          ) : (
            items.map((item) => (
              <article className="source-row" key={item.id}>
                <h3>{item.title || item.host}</h3>
                <p>
                  {accessLabels[item.accessState]}
                  {item.checkedAt
                    ? ` · ${new Date(item.checkedAt).toLocaleString()}`
                    : ""}
                </p>
                <p className="small muted">
                  {item.lastReadAt
                    ? `Saved copy captured ${new Date(item.lastReadAt).toLocaleString()}`
                    : "No saved copy recorded"}
                </p>
                {item.accessReason === "check_incomplete" && (
                  <p className="small muted">
                    The latest check did not finish.
                  </p>
                )}
              </article>
            ))
          )}
        </div>
      )}
    </details>
  );
}
