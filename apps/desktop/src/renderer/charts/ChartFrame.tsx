// A chart's accessible frame: a heading, a one-sentence text summary screen readers read in place of
// the drawing, and a toggle that shows the same figures as a table. `data-shot` is a stable hook for
// the launch-video capture and headless checks.
import { useId, useState, type ReactNode } from "react";

export interface ChartTable {
  columns: string[];
  rows: (string | number)[][];
}

export function ChartFrame({
  shot,
  title,
  summary,
  table,
  aside,
  children,
}: {
  shot: string;
  title: string;
  summary: string;
  table?: ChartTable;
  /** A small figure beside the title (the current letter, a count). */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  const id = useId();
  return (
    <figure className="chart-frame" data-shot={shot} id={`chart-${shot}`} aria-labelledby={`${id}-t`} aria-describedby={`${id}-s`}>
      <div className="chart-frame-head">
        <h3 id={`${id}-t`} className="chart-frame-title">
          {title}
        </h3>
        {aside ? <div className="chart-frame-aside">{aside}</div> : null}
      </div>
      <p id={`${id}-s`} className="chart-sr">
        {summary}
      </p>
      <div className="chart-frame-body" aria-hidden={showTable || undefined}>
        {children}
      </div>
      {table && table.rows.length ? (
        <>
          <button type="button" className="chart-table-toggle" aria-expanded={showTable} aria-controls={`${id}-d`} onClick={() => setShowTable((v) => !v)}>
            {showTable ? "Hide data table" : "Show data table"}
          </button>
          {showTable ? (
            <table id={`${id}-d`} className="chart-table">
              <caption className="chart-sr">{title}</caption>
              <thead>
                <tr>
                  {table.columns.map((c) => (
                    <th key={c} scope="col">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (j === 0 ? <th key={j} scope="row">{cell}</th> : <td key={j}>{cell}</td>))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      ) : null}
    </figure>
  );
}
