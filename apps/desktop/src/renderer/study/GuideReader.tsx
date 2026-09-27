// owner: study frontend. Reads a checked, personalised study guide. Every block keeps the quote
// code checked against the saved material; topic marks come from the student's own practice.
import { forwardRef } from "react";
import type { GuideBlock, GuideDocumentView, GuideQueryResult, TopicMark } from "./types";

const MARK: Record<TopicMark, string> = {
  weak: "Needs work in your practice",
  developing: "Getting there in your practice",
  untested: "Not practiced yet",
  solid: "Solid in your practice",
};

function Block({ block, onSource }: { block: GuideBlock; onSource(resourceId: string): void }) {
  return (
    <div className={`study-guide-block ${block.kind}`}>
      {block.heading ? <p className="study-guide-term">{block.heading}</p> : null}
      {block.date ? <p className="study-meta">{block.date}</p> : null}
      <p className="study-prose">{block.text}</p>
      {block.cells?.length ? <p className="study-prose">{block.cells.join(" · ")}</p> : null}
      {block.expression ? (
        <p className="study-meta">
          {block.expression} = {block.computed ?? block.result}
          {block.computed ? " · recomputed by Magic" : ""}
        </p>
      ) : null}
      {block.source.quote ? (
        <details className="study-disclosure">
          <summary>Source quote</summary>
          <blockquote>{block.source.quote}</blockquote>
          {block.source.resourceId ? (
            <button className="study-link" type="button" onClick={() => onSource(block.source.resourceId!)}>
              Open the source
            </button>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

export const GuideReader = forwardRef<
  HTMLHeadingElement,
  {
    guide: GuideQueryResult & { guide: { view: GuideDocumentView } };
    scopeLabel: string;
    onSource(resourceId: string): void;
    onRegenerate: (() => void) | null;
    pending: boolean;
    onClose(): void;
  }
>(function GuideReader({ guide, scopeLabel, onSource, onRegenerate, pending, onClose }, heading) {
  const view = guide.guide.view;
  return (
    <div className="study-activity study-guide">
      <div className="study-activity-head">
        <button className="study-back" type="button" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          Study overview
        </button>
        <p className="study-meta">Study guide · {scopeLabel}</p>
      </div>
      <h4 className="study-guide-title" tabIndex={-1} ref={heading}>{view.title}</h4>
      <p className="study-meta">
        Written by your connected AI from saved course passages. Magic kept only blocks whose quotes match the
        source; they can still be incomplete or wrong.
      </p>
      {guide.stale ? (
        <div className="study-note" role="status">
          <p>
            The material changed since this guide was made:{" "}
            {guide.changedSources.map((s) => `${s.title} (${s.change})`).join(", ")}. Passages from changed sources are
            hidden until you remake it.
          </p>
          {onRegenerate ? (
            <button className="study-button quiet" type="button" disabled={pending} onClick={onRegenerate}>
              Remake the study guide
            </button>
          ) : null}
        </div>
      ) : null}
      {view.studyNext.length ? (
        <div className="study-guide-next">
          <p className="study-label">Start with</p>
          <ul>
            {view.studyNext.map((row) => (
              <li key={row.conceptId}>
                <strong>{row.label}</strong> · {MARK[row.mark]}
                {row.anchor.valid ? (
                  <button className="study-link" type="button" onClick={() => onSource(row.anchor.resourceId)}>
                    {row.anchor.label}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {view.sections.map((section) => (
        <section key={section.id} className="study-guide-section">
          <h5>{section.title}</h5>
          <p className="study-meta">{MARK[section.mark]}</p>
          {section.blocks.map((block) => (
            <Block key={block.id} block={block} onSource={onSource} />
          ))}
        </section>
      ))}
      {view.confusions.length ? (
        <section className="study-guide-section">
          <h5>Common confusions in your practice</h5>
          {view.confusions.map((c, i) => (
            <p key={i} className="study-prose">{c.text}</p>
          ))}
        </section>
      ) : null}
    </div>
  );
});
