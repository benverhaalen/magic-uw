// Chart math for the hand-rolled SVG charts: scales, ticks, paths and stacking. Pure functions, no
// DOM, so every figure a chart draws is checked by tests/course-analytics-charts.test.ts.

export type Scale = ((value: number) => number) & { domain: [number, number]; range: [number, number] };

/** A linear map from `domain` to `range`. A zero-width domain maps everything to the range's midpoint. */
export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const fn = ((value: number) => (span === 0 ? (r0 + r1) / 2 : r0 + ((value - d0) / span) * (r1 - r0))) as Scale;
  fn.domain = domain;
  fn.range = range;
  return fn;
}

export const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** "Nice" tick values (1, 2, 2.5 or 5 × 10^k steps) covering [min, max], about `count` of them. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || count < 1) return [];
  if (min === max) return [min];
  if (min > max) [min, max] = [max, min];
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const start = Math.ceil(min / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) ticks.push(Math.round(v / step) * step);
  return ticks.map((t) => Number(t.toFixed(10)));
}

/** A y-domain for percentages that shows the data's movement without exaggerating it: a floor of 10-point steps, capped at 100. */
export function percentDomain(values: number[], extra: number[] = []): [number, number] {
  const all = [...values, ...extra].filter(Number.isFinite);
  if (!all.length) return [0, 100];
  const lo = Math.min(...all);
  const floor = clamp(Math.floor((lo - 5) / 10) * 10, 0, 90);
  return [floor, 100];
}

const f = (n: number) => Number(n.toFixed(2));

/** An SVG polyline path through the points, in order. */
export function linePath(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${f(x)} ${f(y)}`).join(" ");
}

/** A closed band between an upper and a lower edge that share x values. */
export function bandPath(upper: [number, number][], lower: [number, number][]): string {
  if (!upper.length || upper.length !== lower.length) return "";
  return `${linePath(upper)} ${[...lower].reverse().map(([x, y]) => `L${f(x)} ${f(y)}`).join(" ")} Z`;
}

/** Stacks values left to right (or bottom to top): each segment's start and size, in the target length. */
export function stack(values: number[], length: number, total = values.reduce((n, v) => n + Math.max(0, v), 0)): { start: number; size: number }[] {
  let at = 0;
  return values.map((v) => {
    const size = total > 0 ? (Math.max(0, v) / total) * length : 0;
    const seg = { start: at, size };
    at += size;
    return seg;
  });
}

/** Ring segments as stroke-dasharray/offset pairs on a circle of radius `r`, starting at 12 o'clock. */
export function ringSegments(values: number[], r: number, gap = 0): { dash: string; offset: number; length: number }[] {
  const circumference = 2 * Math.PI * r;
  const total = values.reduce((n, v) => n + Math.max(0, v), 0);
  const live = values.filter((v) => v > 0).length;
  const segs = stack(values, circumference, total);
  return segs.map(({ start, size }) => {
    const length = size > 0 ? Math.max(0, size - (live > 1 ? gap : 0)) : 0;
    return { dash: `${f(length)} ${f(circumference - length)}`, offset: f(-start), length: f(length) };
  });
}

/** easeOutExpo, the mount animation's curve (CSS: cubic-bezier(0.16, 1, 0.3, 1)). */
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
