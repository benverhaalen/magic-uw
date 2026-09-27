/**
 * owner: privacy. The protection pass's cost (the operator: "if privacy really adds latency it has
 * to be miniscule"). `pnpm magic:perf --suite privacy` reports the absolute budgets on the named
 * machine: <= 1 ms p95 per 10 KB teaching text, <= 2 ms per 10 KB personal text, a repeated send
 * close to 0. tests/privacy-budget.test.ts runs the same workload and asserts the same budgets as
 * ratios to a same-run reference, which holds on any machine. The reference is one plain scan of
 * the same 10 KB text with the full detector set (`detect(text, "all")`: the same patterns, no
 * roster, no context rules). The ratios are the absolute budgets over the reference's p95 on the
 * laptop they were set on (Windows 11, Node 24): 0.155 ms on the teaching texts, 0.125 ms on the
 * personal ones; the repeated-send ratio is the earlier absolute bound, 0.25 ms, over 0.125 ms.
 */
import { createStore } from "../../packages/storage/src/index";
import { rosterFor } from "../../packages/core/src/identity";
import { detect } from "../../packages/core/src/privacy/detectors";
import { clearProtectionCache, protectText, type ContentClass } from "../../packages/core/src/privacy/protect";
import { pseudonymSession } from "../../packages/core/src/privacy/pseudonyms";
import { distribution, percentile, scalar, type Metric } from "./stats";

export const PROTECTION_BUDGET_MS = { teaching: 1, personal: 2 } as const;
/** The absolute budgets over the reference's p95 on the laptop they were set on (see above). */
export const PROTECTION_BUDGET_RATIO = { teaching: 6.5, personal: 16, cached: 2 } as const;

const LECTURE =
  "Recursion solves a problem by solving smaller instances of the same problem. Every recursive method needs a base case, and each call must make progress toward it. Consider the factorial: n! = n * (n-1)!, with 0! = 1. Configure the lab VM at 192.168.1.1 and run the tests. ";
const MENTION = "Peer3 Person3 asked about tail calls in office hours; email qz@wisc.edu or call (608) 555-0142 with questions. ";
const POST =
  "Hi Peer4, it's Quentin. I finished the recursion lab and pushed it. My card is 5555 5555 5555 4444 for the club fee, and I live at 1234 Canaryhill Street if you want to study. ";
/** A 10 KB text: the class's usual prose, with a student mentioned every twelfth paragraph. */
export function tenKilobytes(seed: number, cls: ContentClass): string {
  const body = cls === "teaching" ? LECTURE : POST;
  let t = `Week ${seed}. `;
  for (let k = 1; t.length < 10240; k++) t += k % 12 === 0 ? MENTION : body;
  return t.slice(0, 10240);
}

export interface ProtectionSamples {
  /** Milliseconds per 10 KB text: the roster scrubber alone (reference), the full pass, the same text again. */
  reference: number[];
  cold: number[];
  cached: number[];
}
/** Interleaved per text, so the machine's state falls on the reference and the pass alike. */
export function measureProtection(cls: ContentClass, n = 200): ProtectionSamples {
  const store = createStore(":memory:");
  store.recordAutoIdentity({ accountScope: "a", self: { names: ["Quentin Zabrowski"], emails: ["qz@wisc.edu"], netIds: ["qzab"], studentIds: ["9081234567"] } });
  store.recordAutoIdentity({ accountScope: "a", courseId: "c", authors: Array.from({ length: 40 }, (_, i) => `Peer${i} Person${i}`) });
  const roster = rosterFor(store, "c", "a");
  clearProtectionCache();
  for (let i = 0; i < 30; i++) {
    const t = tenKilobytes(1e6 + i, cls);
    detect(t, "all");
    protectText(t, roster, pseudonymSession("warm"), cls); // JIT warm-up
  }
  const out: ProtectionSamples = { reference: [], cold: [], cached: [] };
  for (let i = 0; i < n; i++) {
    const text = tenKilobytes(i, cls);
    let a = performance.now();
    detect(text, "all");
    out.reference.push(performance.now() - a);
    a = performance.now();
    protectText(text, roster, pseudonymSession("cold"), cls);
    out.cold.push(performance.now() - a);
    a = performance.now();
    protectText(text, roster, pseudonymSession("again"), cls);
    out.cached.push(performance.now() - a);
  }
  store.close();
  return out;
}

/** The perf-harness stage: absolute p95s against the budgets, and the ratios the test asserts. */
export function privacyStage(): Record<string, Metric> {
  const metrics: Record<string, Metric> = {};
  for (const cls of ["teaching", "personal"] as const) {
    const s = measureProtection(cls);
    const ref = percentile(s.reference, 95);
    metrics[`${cls}Reference`] = distribution("ms per 10 KB", s.reference, { notes: "detect(text, \"all\"): one plain scan with the full detector set (same texts, same run)" });
    metrics[`${cls}Pass`] = distribution("ms per 10 KB", s.cold, { budgetP95Ms: PROTECTION_BUDGET_MS[cls], withinBudget: percentile(s.cold, 95) <= PROTECTION_BUDGET_MS[cls] });
    metrics[`${cls}Cached`] = distribution("ms per 10 KB", s.cached, { notes: "the same text sent again" });
    metrics[`${cls}Ratio`] = scalar("p95 pass / p95 reference", percentile(s.cold, 95) / ref, s.cold.length, { budget: PROTECTION_BUDGET_RATIO[cls] });
  }
  return metrics;
}
