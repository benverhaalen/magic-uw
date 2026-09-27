/** Small, dependency-free statistics and measurement record helpers for the perf harness. */

export type Measured = {
  status: "measured";
  unit: string;
  n: number;
  value?: number;
  p50?: number;
  p95?: number;
  min?: number;
  max?: number;
  mean?: number;
  notes?: string;
  [extra: string]: unknown;
};
export type NotMeasured = { status: "not-measured"; reason: string };
export type Metric = Measured | NotMeasured;

export const notMeasured = (reason: string): NotMeasured => ({
  status: "not-measured",
  reason,
});

/** Nearest-rank percentile over a copy of the samples. */
export function percentile(samples: number[], p: number): number {
  if (!samples.length) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

const round = (value: number, digits = 3) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : value;

/** A distribution metric: n, p50, p95, min, max and mean, all in `unit`. */
export function distribution(
  unit: string,
  samples: number[],
  extra: Record<string, unknown> = {},
): Measured {
  const mean = samples.reduce((a, b) => a + b, 0) / (samples.length || 1);
  return {
    status: "measured",
    unit,
    n: samples.length,
    p50: round(percentile(samples, 50)),
    p95: round(percentile(samples, 95)),
    min: round(Math.min(...samples)),
    max: round(Math.max(...samples)),
    mean: round(mean),
    ...extra,
  };
}

/** A single-valued metric (a count or a size), with the n it was derived from. */
export function scalar(
  unit: string,
  value: number,
  n = 1,
  extra: Record<string, unknown> = {},
): Measured {
  return { status: "measured", unit, n, value: round(value), ...extra };
}
