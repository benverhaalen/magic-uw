// owner: ui-wiring. An assignment's references (graph `references`): linked materials, pages and
// files, and external links. External links open in the default browser on the student's click;
// an LTI tool launch is never opened from here.
import type { Reference, ResourceSummary } from "@magic/contracts";
import { graph, openExternal, query, useAction, useLoad } from "./bridge";
import { Empty, ErrorLine, Loaded, PreviewSection, formatWhen } from "./ui";

const parse = (url: string) => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};
/** A Canvas external-tool (LTI) launch: the student opens it from Canvas, never from here. */
const isLtiLaunch = (url: string) => {
  const parsed = parse(url);
  return !parsed || /\/external_tools\/|\/lti\/|launch/i.test(parsed.pathname);
};

export function ReferencesPreview({
  assignments,
  assignmentId,
  onChoose,
}: {
  assignments: ResourceSummary[];
  assignmentId: string | null;
  onChoose: (id: string) => void;
}) {
  const chosen = assignments.find((a) => a.id === assignmentId) ?? null;
  const [load, reload] = useLoad(chosen ? `refs:${chosen.id}` : null, () => graph({ type: "references", assignmentId: chosen!.id }));
  const open = useAction();
  const openMaterial = (resourceId: string) =>
    open.run(async () => {
      const found = await query({ view: "resource", id: resourceId });
      await openExternal(found.resource.url);
    });
  return (
    <PreviewSection title="Assignment references" op="graph references (assignmentId)">
      {assignments.length === 0 ? (
        <Empty>No assignments saved for this course yet.</Empty>
      ) : (
        <div className="backend-controls">
          <label>
            Assignment
            <select value={chosen?.id ?? ""} onChange={(event) => onChoose(event.target.value)}>
              <option value="">Choose an assignment</option>
              {assignments.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                  {a.deadline.dueAt ? ` · due ${formatWhen(a.deadline.dueAt, false)}` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {chosen ? (
        <Loaded load={load} retry={reload}>
          {(refs) =>
            refs.length === 0 ? (
              <Empty>No references found for “{chosen.title}” in the saved material: no link, named file or page, module or syllabus mention ties anything to it yet.</Empty>
            ) : (
              <ul className="backend-list">
                {refs.map((ref, index) => (
                  <ReferenceRow key={`${ref.resourceId ?? ref.externalUrl ?? ref.title}:${index}`} value={ref} onOpenMaterial={openMaterial} onOpenLink={(url) => open.run(() => openExternal(url))} />
                ))}
              </ul>
            )
          }
        </Loaded>
      ) : null}
      <ErrorLine text={open.error} />
    </PreviewSection>
  );
}

function ReferenceRow({ value, onOpenMaterial, onOpenLink }: { value: Reference; onOpenMaterial: (id: string) => void; onOpenLink: (url: string) => void }) {
  const url = value.externalUrl;
  const lti = url ? isLtiLaunch(url) : false;
  return (
    <li>
      <div className="backend-row">
        <strong>{value.title}</strong>
        <span className="inline-actions">
          <span className="badge">{value.kind}</span>
          <span className="badge">{value.strength}</span>
        </span>
      </div>
      <div className="backend-meta">{value.reason}</div>
      {value.resourceId ? (
        <button className="subtle-button backend-meta" onClick={() => onOpenMaterial(value.resourceId!)}>
          Open original ↗
        </button>
      ) : url && !lti ? (
        <button className="subtle-button backend-meta" onClick={() => onOpenLink(url)}>
          {parse(url)?.host ?? url} ↗
        </button>
      ) : url ? (
        <div className="backend-meta">A course tool (LTI): open it from Canvas.</div>
      ) : (
        <div className="backend-meta">Not resolved to a saved item.</div>
      )}
    </li>
  );
}
