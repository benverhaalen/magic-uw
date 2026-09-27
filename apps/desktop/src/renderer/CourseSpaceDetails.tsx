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
/** Course detail within Sources; saved material and current access are independent facts. */
export function CourseSpaceDetails({
  sources,
  revision,
}: {
  sources: SourceHealth[];
  revision: string;
}) {
  const courses = [
    ...new Map(
      [...sources]
        .sort(
          (a, b) => Number(b.scope === "course") - Number(a.scope === "course"),
        )
        .filter(
          (s) =>
            s.kind === "canvas" &&
            !["account", "connection"].includes(s.courseId),
        )
        .reverse()
        .map((s) => [JSON.stringify([s.accountScope, s.courseId]), s]),
    ).values(),
  ];
  return (
    <>
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
