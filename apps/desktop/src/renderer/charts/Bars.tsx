// Stacked columns, a ring, a segmented progress bar and a stepped level bar. Colour is never the only
// signal: every series is named in a legend or the accessible label. Bars grow on mount (CSS).
import { linearScale, niceTicks, ringSegments, stack } from "./scale";

export interface Series {
  key: string;
  label: string;
}

const W = 640,
  H = 200,
  M = { l: 28, r: 8, t: 10, b: 26 };

/** One stacked column per group (a week), series stacked bottom to top in the given order. */
export function StackedBarChart({ series, columns }: { series: Series[]; columns: { label: string; values: number[] }[] }) {
  const max = Math.max(1, ...columns.map((c) => c.values.reduce((n, v) => n + v, 0)));
  const ticks = niceTicks(0, max, Math.min(4, max)).filter((t) => Number.isInteger(t));
  const top = Math.max(max, ticks.at(-1) ?? max);
  const y = linearScale([0, top], [H - M.b, M.t]);
  const band = (W - M.l - M.r) / Math.max(1, columns.length);
  const bar = Math.min(34, band * 0.62);
  return (
    <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="presentation" focusable="false">
      <g className="chart-grid">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} />
            <text x={M.l - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {t}
            </text>
          </g>
        ))}
      </g>
      {columns.map((c, i) => {
        const cx = M.l + band * i + band / 2;
        const total = c.values.reduce((n, v) => n + v, 0);
        const segs = stack(c.values, y(0) - y(total), total);
        return (
          <g key={c.label} className="chart-col" style={{ animationDelay: `${i * 18}ms` }}>
            {segs.map((s, j) =>
              s.size > 0 ? (
                <rect
                  key={series[j]!.key}
                  className={`chart-fill chart-fill--${series[j]!.key}`}
                  x={cx - bar / 2}
                  y={y(0) - s.start - s.size}
                  width={bar}
                  height={Math.max(0, s.size - 1)}
                  rx={3}
                >
                  <title>{`${c.label}: ${c.values[j]} ${series[j]!.label.toLowerCase()}`}</title>
                </rect>
              ) : null,
            )}
            <text className="chart-xtick" x={cx} y={H - 8} textAnchor="middle">
              {c.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function Legend({ series, values }: { series: Series[]; values?: number[] }) {
  return (
    <ul className="chart-legend">
      {series.map((s, i) => (
        <li key={s.key}>
          <span className={`chart-swatch chart-fill--${s.key}`} aria-hidden="true" />
          {s.label}
          {values ? <strong>{values[i]}</strong> : null}
        </li>
      ))}
    </ul>
  );
}

/** A ring of segments with a figure in the middle. */
export function RingChart({ series, values, center, caption }: { series: Series[]; values: number[]; center: string; caption: string }) {
  const r = 42;
  const segs = ringSegments(values, r, 3);
  return (
    <svg className="chart-ring" viewBox="0 0 120 120" role="presentation" focusable="false">
      <circle className="chart-ring-track" cx={60} cy={60} r={r} />
      <g transform="rotate(-90 60 60)">
        {segs.map((s, i) =>
          s.length > 0 ? (
            <circle key={series[i]!.key} className={`chart-ring-seg chart-stroke--${series[i]!.key}`} cx={60} cy={60} r={r} strokeDasharray={s.dash} strokeDashoffset={s.offset} />
          ) : null,
        )}
      </g>
      <text className="chart-ring-center" x={60} y={58} textAnchor="middle">
        {center}
      </text>
      <text className="chart-ring-caption" x={60} y={75} textAnchor="middle">
        {caption}
      </text>
    </svg>
  );
}

/** A horizontal segmented bar of counts (for example, topic states); `label` is its accessible name. */
export function ProgressBar({ series, values, label }: { series: Series[]; values: number[]; label: string }) {
  const total = values.reduce((n, v) => n + v, 0);
  const segs = stack(values, 100, total);
  return (
    <div className="chart-progress" role="img" aria-label={label}>
      {total ? (
        segs.map((s, i) =>
          s.size > 0 ? <span key={series[i]!.key} className={`chart-progress-seg chart-fill--${series[i]!.key}`} style={{ left: `${s.start}%`, width: `${s.size}%` }} /> : null,
        )
      ) : (
        <span className="chart-progress-seg chart-progress-seg--empty" style={{ left: 0, width: "100%" }} />
      )}
    </div>
  );
}

/** A stepped level: `level` of `steps` filled, named by `label` (for example, "Getting there"). */
export function LevelBar({ level, steps, tone, label }: { level: number; steps: number; tone: string; label: string }) {
  return (
    <div className="chart-level" role="img" aria-label={label}>
      {Array.from({ length: steps }, (_, i) => (
        <span key={i} className={`chart-level-step${i < level ? ` chart-fill--${tone}` : ""}`} style={{ animationDelay: `${i * 40}ms` }} />
      ))}
    </div>
  );
}
