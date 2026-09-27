/**
 * Deterministic synthetic coursework for storage benchmarks. Entirely fabricated:
 * no captured identities, URLs, or course text. Lengths approximate real Canvas items
 * (short announcements, mid-length assignment prompts, long reading/material bodies).
 */
import type { CaptureBatch, ResourceInput } from "@magic/contracts";

/** Mulberry32: a small seeded PRNG so every run ingests the same corpus. */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const COURSES = [
  { id: "perf-101", name: "Algorithms and Data Structures" },
  { id: "perf-102", name: "Linear Algebra" },
  { id: "perf-103", name: "Modern World History" },
  { id: "perf-104", name: "General Chemistry" },
  { id: "perf-105", name: "Academic Writing" },
] as const;

// Topic vocabularies keep per-course text distinguishable so queries have realistic selectivity.
const TOPICS: Record<string, string[]> = {
  "perf-101": "algorithm graph dynamic programming recursion complexity asymptotic greedy shortest path tree heap sorting hashing induction invariant proof runtime divide conquer memoization matching flow network bipartite spanning".split(" "),
  "perf-102": "matrix vector eigenvalue eigenvector determinant basis span subspace linear transformation orthogonal projection rank nullspace inverse diagonalization inner product gram schmidt least squares kernel".split(" "),
  "perf-103": "empire revolution treaty colonial industrial nationalism war diplomacy trade migration reform independence republic monarchy economy archive primary source historiography modernity".split(" "),
  "perf-104": "stoichiometry molecule reaction equilibrium enthalpy entropy acid base titration oxidation reduction orbital bond electron periodic gas law solution concentration kinetics catalyst".split(" "),
  "perf-105": "thesis argument evidence paragraph citation revision draft audience rhetoric claim counterargument analysis synthesis source outline introduction conclusion peer review style".split(" "),
};
const COMMON =
  "the of and to in a is that for on with as by this be are from at an it or which students will should each week you your submit include explain describe compare analyze discuss example problem question answer section chapter reading lecture notes due points rubric criteria review practice exam quiz homework project lab report".split(
    " ",
  );

function words(random: () => number, course: string, count: number) {
  const topic = TOPICS[course]!;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const pool = random() < 0.3 ? topic : COMMON;
    out.push(pool[Math.floor(random() * pool.length)]!);
  }
  return out;
}
function prose(random: () => number, course: string, chars: number) {
  const sentences: string[] = [];
  let length = 0;
  while (length < chars) {
    const w = words(random, course, 8 + Math.floor(random() * 14));
    const sentence = w.join(" ");
    const s = sentence[0]!.toUpperCase() + sentence.slice(1) + ".";
    sentences.push(s);
    length += s.length + 1;
  }
  return sentences.join(" ").slice(0, chars);
}

type Kind = "assignment" | "material" | "message" | "event";
/** Mix and body length ranges (characters) per kind. */
const MIX: Array<{ kind: Kind; share: number; min: number; max: number }> = [
  { kind: "assignment", share: 0.4, min: 800, max: 3000 },
  { kind: "material", share: 0.35, min: 4000, max: 15000 },
  { kind: "message", share: 0.15, min: 200, max: 1200 },
  { kind: "event", share: 0.1, min: 80, max: 400 },
];

export interface SyntheticCorpus {
  batches: CaptureBatch[];
  resources: number;
  textChars: number;
}

/**
 * `count` resources spread evenly over five courses; one batch per (course, kind, chunk)
 * with at most 500 resources so every batch stays within the 2,000-record envelope.
 */
export function syntheticCorpus(
  count: number,
  observedAt = "2026-09-26T15:00:00.000Z",
  seed = 577,
): SyntheticCorpus {
  const random = prng(seed + count);
  const groups = new Map<string, { course: (typeof COURSES)[number]; kind: Kind; items: ResourceInput[] }>();
  let textChars = 0;
  for (let i = 0; i < count; i++) {
    const course = COURSES[i % COURSES.length]!;
    const pick = random();
    let acc = 0,
      spec = MIX[MIX.length - 1]!;
    for (const entry of MIX) {
      acc += entry.share;
      if (pick < acc) {
        spec = entry;
        break;
      }
    }
    const length = spec.min + Math.floor(random() * (spec.max - spec.min));
    const text = prose(random, course.id, length);
    textChars += text.length;
    const title = words(random, course.id, 3 + Math.floor(random() * 5)).join(" ");
    const externalId = `${spec.kind}-${i}`;
    const due =
      spec.kind === "assignment" || spec.kind === "event"
        ? new Date(Date.UTC(2026, 9, 1 + (i % 60), 23, 0)).toISOString()
        : undefined;
    const item: ResourceInput = {
      externalId,
      kind: spec.kind,
      courseId: course.id,
      courseName: course.name,
      title: title[0]!.toUpperCase() + title.slice(1),
      url: `https://canvas.synthetic.test/courses/${course.id}/${spec.kind}s/${i}`,
      text,
      ...(due ? { dueAt: due } : {}),
      deadlines: [],
      points: spec.kind === "assignment" ? 10 + (i % 5) * 5 : null,
      submitted: spec.kind === "assignment" ? false : null,
      policy: { mode: "unknown", evidence: "" },
    };
    const chunk = Math.floor(i / (COURSES.length * 500));
    const key = `${course.id}:${spec.kind}:${chunk}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { course, kind: spec.kind, items: [] }));
    group.items.push(item);
  }
  const batches: CaptureBatch[] = [...groups.entries()].map(([key, g]) => ({
    source: {
      id: `perf:${key}`,
      label: `${g.course.name} · ${g.kind}`,
      kind: "fixture",
      accountScope: "perf-synthetic",
      courseId: g.course.id,
      scope: `${g.kind}:${key.split(":")[2]}`,
    },
    observedAt,
    complete: true,
    status: "ok",
    resources: g.items,
  }));
  return { batches, resources: count, textChars };
}

/**
 * The fixed query set: 12 single terms and 12 question-like phrases. The phrases are what a
 * student types; today's prefix-AND matcher is expected to miss many of them (plan O4).
 */
export const QUERIES: readonly string[] = [
  "eigenvalue",
  "recursion",
  "treaty",
  "titration",
  "thesis",
  "matrix",
  "equilibrium",
  "revolution",
  "citation",
  "graph",
  "orbital",
  "rubric",
  "how do I find the eigenvalue of a matrix",
  "what is dynamic programming",
  "when is the lab report due",
  "explain the causes of the industrial revolution",
  "how many points is the essay worth",
  "compare greedy and dynamic programming algorithms",
  "what does the rubric say about evidence",
  "difference between oxidation and reduction",
  "how should I structure my thesis argument",
  "what chapter covers least squares",
  "practice exam questions on kinetics",
  "which reading discusses nationalism",
];
