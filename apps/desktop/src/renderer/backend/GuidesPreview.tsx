// owner: ui-wiring. Study guides: the 0-token `guide` query (op guide.view) shows the cached,
// personalised guide and its stale state; Generate runs the guide pack on the student's own AI.
import { useState } from "react";
import type { QueryResult } from "@magic/contracts";
import type { ConceptMapView, GuideView, TopicMark } from "../../../../../packages/packs/guide/src/personalize";
import { graph, pack, query, useAction, useLoad, type Course, type PackOutcome } from "./bridge";
import { Empty, ErrorLine, Loaded, Partial, PreviewSection } from "./ui";

type GuideKind = Extract<QueryResult, { view: "guide" }>["kind"];
const kinds: [GuideKind, string][] = [
  ["guide", "Study guide"],
  ["briefing", "Briefing"],
  ["faq", "FAQ"],
  ["timeline", "Timeline"],
  ["compare", "Compare"],
  ["conceptmap", "Concept map"],
];
const markLabels: Record<TopicMark, string> = { weak: "Iffy", developing: "Getting there", untested: "Not seen yet", solid: "Mastered" };

export function GuidesPreview({ course }: { course: Course }) {
  const [kind, setKind] = useState<GuideKind>("guide");
  const [moduleId, setModuleId] = useState("");
  const [made, setMade] = useState<PackOutcome | null>(null);
  const [modules] = useLoad(`guide-modules:${course.accountScope}:${course.courseId}`, () =>
    graph({ type: "courseGraph", accountScope: course.accountScope, courseId: course.courseId }).then((g) => g.modules),
  );
  const key = `guide:${course.courseId}:${kind}:${moduleId}`;
  const [load, reload] = useLoad(key, () =>
    query({ view: "guide", courseId: course.courseId, kind, ...(moduleId ? { moduleId } : {}) }),
  );
  const generate = useAction();
  const run = async () => {
    setMade(null);
    const outcome = await generate.run(() => pack(kind, { courseId: course.courseId, ...(moduleId ? { moduleId } : {}) }));
    if (outcome) {
      setMade(outcome);
      reload();
    }
  };
  return (
    <PreviewSection
      title="Study guides"
      op={`query guide (op guide.view, kind ${kind}) · generate: pack ${kind}`}
      actions={
        <button className="button small-button" disabled={generate.busy} onClick={() => void run()}>
          {generate.busy ? "Generating…" : "Generate"}
        </button>
      }
    >
      <div className="backend-controls">
        <label>
          Kind
          <select value={kind} onChange={(event) => setKind(event.target.value as GuideKind)}>
            {kinds.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Scope
          <select value={moduleId} onChange={(event) => setModuleId(event.target.value)}>
            <option value="">Whole course</option>
            {modules.state === "ready"
              ? modules.value.map((m) => (
                  <option key={m.id} value={m.id}>
                    Module: {m.title}
                  </option>
                ))
              : null}
          </select>
        </label>
      </div>
      {made ? (
        <Partial status={made.status}>
          {made.message}
          {made.tokens ? ` · ${made.cached ? "cached, " : ""}${made.tokens.in + made.tokens.out} tokens` : ""}
        </Partial>
      ) : null}
      <ErrorLine text={generate.error} />
      <Loaded load={load} retry={reload}>
        {(result) => <GuideBody result={result} />}
      </Loaded>
    </PreviewSection>
  );
}

function GuideBody({ result }: { result: Extract<QueryResult, { view: "guide" }> }) {
  if (result.status !== "ready" && result.status !== "stale")
    return (
      <Partial status={result.status}>
        {result.message ?? "No guide for this scope."} Generating one uses your own AI; reading a saved guide uses none.
      </Partial>
    );
  // The query's body is `{ view, drops }` (packages/packs/guide/src/query.ts).
  const body = result.guide as { view?: GuideView | ConceptMapView; drops?: unknown[] } | null;
  const view = body?.view;
  return (
    <>
      {result.stale ? (
        <Partial status="stale">
          The material changed since this was made; it is shown until you regenerate.
          {result.changedSources.length ? (
            <ul className="backend-list">
              {result.changedSources.map((s) => (
                <li key={s.resourceId}>
                  {s.title} · {s.change}
                </li>
              ))}
            </ul>
          ) : null}
        </Partial>
      ) : null}
      {!view ? (
        <Empty>The saved guide has no readable body.</Empty>
      ) : view.kind === "conceptmap" ? (
        <ConceptMap view={view} />
      ) : (
        <Guide view={view} />
      )}
      {body?.drops?.length ? <p className="small muted">{body.drops.length} generated parts were dropped by code checks.</p> : null}
    </>
  );
}

function Guide({ view }: { view: GuideView }) {
  return (
    <div>
      <h3>{view.title}</h3>
      {view.sections.length === 0 ? <Empty>This guide has no sections that passed the checks.</Empty> : null}
      {view.sections.map((section) => (
        <div className="backend-card" key={section.id}>
          <div className="backend-row">
            <strong>{section.title}</strong>
            <span className="badge">{markLabels[section.mark]}</span>
          </div>
          <div className="backend-meta">Topics: {section.topicMarks.map((t) => `${t.topic} (${markLabels[t.mark]})`).join(", ")}</div>
          {section.columns ? <div className="backend-meta">Compared: {section.columns.join(" · ")}</div> : null}
          {section.blocks.map((block) => (
            <div key={block.id}>
              <p>
                {block.heading ? <strong>{block.heading}: </strong> : null}
                {block.date ? <span className="badge">{block.date}</span> : null} {block.text}
                {block.cells ? ` — ${block.cells.join(" | ")}` : ""}
                {block.computed ? ` (code computed: ${block.computed})` : ""}
              </p>
              {block.source.quote ? <blockquote className="backend-quote">{block.source.quote}</blockquote> : null}
            </div>
          ))}
        </div>
      ))}
      {view.studyNext.length ? (
        <p className="small muted">Study next: {view.studyNext.map((s) => `${s.label} (${markLabels[s.mark]})`).join(", ")}</p>
      ) : null}
    </div>
  );
}

function ConceptMap({ view }: { view: ConceptMapView }) {
  const label = new Map(view.nodes.map((n) => [n.id, n.label]));
  return (
    <div>
      <h3>{view.title}</h3>
      {view.nodes.length === 0 ? <Empty>The map has no concepts that passed the checks.</Empty> : null}
      <ul className="backend-list">
        {view.nodes.map((n) => (
          <li key={n.id}>
            <div className="backend-row">
              <strong>{n.label}</strong>
              <span className="badge">{markLabels[n.mark]}</span>
            </div>
            {n.source?.quote ? <blockquote className="backend-quote">{n.source.quote}</blockquote> : null}
          </li>
        ))}
      </ul>
      {view.edges.length ? (
        <>
          <h3>Links</h3>
          <ul className="backend-list">
            {view.edges.map((e, index) => (
              <li key={`${e.from}-${e.to}-${index}`}>
                {label.get(e.from) ?? e.from} → {label.get(e.to) ?? e.to} · {e.kind.replaceAll("_", " ")}
                {e.personal ? " · from your own mistakes" : ""}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
