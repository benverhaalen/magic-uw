/**
 * Statistics for the item-quality harness. Pure functions, no dependencies.
 *
 * - Rates carry a Wilson score interval (stable coverage from about n = 10 and at 0 or n
 *   successes, where the Wald interval fails; Brown, Cai and DasGupta 2001, via the
 *   benchmark-validity brief).
 * - Two-rater agreement is Cohen's kappa; for the ordinal 1-4 rubric it is quadratic-weighted
 *   kappa, computed per rubric dimension, never pooled across dimensions.
 * - Order-swap consistency is the share of pairs whose preference survives the swap (the
 *   statistic Zheng et al. 2023, arXiv 2306.05685, used to expose position bias).
 */

export interface Rate {
  k: number;
  n: number;
  /** k / n, or null when n = 0 (nothing to measure is not 0% or 100%). */
  rate: number | null;
  /** 95% Wilson score interval; null when n = 0. */
  ci: [number, number] | null;
}

const Z95 = 1.959963984540054;

/** Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number, z = Z95): [number, number] | null {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) throw new Error(`wilson: bad counts ${k}/${n}`);
  if (n === 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  // Exact at the edges: the interval for 0 successes starts at 0 and for n successes ends at 1.
  return [k === 0 ? 0 : Math.max(0, centre - half), k === n ? 1 : Math.min(1, centre + half)];
}

export function rate(k: number, n: number): Rate {
  return { k, n, rate: n ? k / n : null, ci: wilson(k, n) };
}

/**
 * Cohen's kappa for two raters over the same items. `weights`: "none" (nominal), or
 * "quadratic" for ordinal categories (the categories' order is the order of `categories`).
 * Returns null when there are no paired ratings or expected agreement is total (undefined).
 */
export function cohenKappa<T>(
  a: T[],
  b: T[],
  categories: T[],
  weights: "none" | "quadratic" = "none",
): number | null {
  if (a.length !== b.length) throw new Error("cohenKappa: the raters rated different numbers of items");
  const n = a.length;
  const m = categories.length;
  if (!n || m < 2) return null;
  const index = new Map(categories.map((c, i) => [c, i]));
  const observed = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  for (let i = 0; i < n; i++) {
    const x = index.get(a[i]!);
    const y = index.get(b[i]!);
    if (x === undefined || y === undefined) throw new Error(`cohenKappa: a rating outside the categories (${String(a[i])}, ${String(b[i])})`);
    observed[x]![y]! += 1;
  }
  const rowSum = observed.map((r) => r.reduce((s, v) => s + v, 0));
  const colSum = categories.map((_, j) => observed.reduce((s, r) => s + r[j]!, 0));
  const w = (i: number, j: number) => (weights === "quadratic" ? ((i - j) * (i - j)) / ((m - 1) * (m - 1)) : i === j ? 0 : 1);
  let disagreeObserved = 0;
  let disagreeExpected = 0;
  for (let i = 0; i < m; i++)
    for (let j = 0; j < m; j++) {
      disagreeObserved += w(i, j) * (observed[i]![j]! / n);
      disagreeExpected += w(i, j) * ((rowSum[i]! / n) * (colSum[j]! / n));
    }
  if (disagreeExpected === 0) return null;
  return 1 - disagreeObserved / disagreeExpected;
}

/** Landis and Koch's verbal bands, for the report only; the number is what counts. */
export function kappaBand(k: number | null): string {
  if (k === null) return "undefined";
  if (k < 0) return "worse than chance";
  if (k <= 0.2) return "slight";
  if (k <= 0.4) return "fair";
  if (k <= 0.6) return "moderate";
  if (k <= 0.8) return "substantial";
  return "almost perfect";
}

/** The format for a rate in a report row: "0.95 (19/20; 95% CI 0.76-0.99)". */
export function formatRate(r: Rate, digits = 2): string {
  if (r.rate === null || !r.ci) return `not measured (n = 0)`;
  return `${r.rate.toFixed(digits)} (${r.k}/${r.n}; 95% CI ${r.ci[0].toFixed(digits)}-${r.ci[1].toFixed(digits)})`;
}

/** A small deterministic PRNG (mulberry32) so shuffles and exports are reproducible from a seed. */
export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with a seeded PRNG; returns a new array. */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
