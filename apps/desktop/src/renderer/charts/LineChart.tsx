// A line chart with a dot per point, a hover/focus tooltip, optional labelled reference lines (the
// syllabus letter cutoffs) and an optional dashed band (a what-if range). The line draws on mount
// (CSS, < 400 ms, easeOutExpo); reduced motion shows it drawn.
import { useState } from "react";
import { bandPath, linearScale, linePath, niceTicks } from "./scale";

export interface LinePoint {
  x: number;
  y: number;
  /** The tooltip's first line. */
  label: string;
  /** The tooltip's detail lines. */
  lines: string[];
  /** Draws the dot hollow (for example, a late item). */
  hollow?: boolean;
}
export interface LineBand {
  x0: number;
  x1: number;
  lo0: number;
  hi0: number;
  lo1: number;
  hi1: number;
  label: string;
}

const W = 640,
  H = 232,
  M = { l: 40, r: 56, t: 14, b: 28 };

export function LineChart({
  points,
  xDomain,
  yDomain,
  xTicks,
  band,
  refLines = [],
  yFormat = (v) => `${v}%`,
}: {
  points: LinePoint[];
  xDomain: [number, number];
  yDomain: [number, number];
  xTicks: { x: number; label: string }[];
  band?: LineBand | null;
  refLines?: { y: number; label: string }[];
  yFormat?: (v: number) => string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const x = linearScale(xDomain, [M.l, W - M.r]);
  const y = linearScale(yDomain, [H - M.b, M.t]);
  const yTicks = niceTicks(yDomain[0], yDomain[1], 4);
  const path = linePath(points.map((p) => [x(p.x), y(p.y)]));
  const shownRefs = refLines.filter((r) => r.y > yDomain[0] && r.y <= yDomain[1]);
  const tip = active !== null ? points[active] : null;
  return (
    <div className="chart-line-wrap" onMouseLeave={() => setActive(null)}>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="presentation" focusable="false">
        <g className="chart-grid">
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} />
              <text x={M.l - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {yFormat(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t.x} className="chart-xtick" x={x(t.x)} y={H - 8} textAnchor="middle">
              {t.label}
            </text>
          ))}
        </g>
        {shownRefs.map((r) => (
          <g key={r.label} className="chart-ref">
            <line x1={M.l} x2={W - M.r} y1={y(r.y)} y2={y(r.y)} />
            <text x={W - M.r + 6} y={y(r.y)} dy="0.32em">
              {r.label}
            </text>
          </g>
        ))}
        {band ? (
          <path
            className="chart-band"
            d={bandPath(
              [
                [x(band.x0), y(band.hi0)],
                [x(band.x1), y(band.hi1)],
              ],
              [
                [x(band.x0), y(band.lo0)],
                [x(band.x1), y(band.lo1)],
              ],
            )}
          />
        ) : null}
        {points.length > 1 ? <path className="chart-line" d={path} pathLength={1} /> : null}
        {points.map((p, i) => (
          <circle
            key={i}
            className={`chart-dot${p.hollow ? " chart-dot--hollow" : ""}${active === i ? " is-active" : ""}`}
            cx={x(p.x)}
            cy={y(p.y)}
            r={active === i ? 6 : 4.5}
            tabIndex={0}
            aria-label={`${p.label}: ${p.lines.join(", ")}`}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            style={{ animationDelay: `${Math.round((i / Math.max(1, points.length - 1)) * 260)}ms` }}
          />
        ))}
      </svg>
      {tip ? (
        <div
          className="chart-tooltip"
          role="status"
          style={{ left: `${(x(tip.x) / W) * 100}%`, top: `${(y(tip.y) / H) * 100}%` }}
        >
          <strong>{tip.label}</strong>
          {tip.lines.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
