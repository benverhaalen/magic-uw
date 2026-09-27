/**
 * The derivation reconcile (owner: drain): code-only derived data kept as incrementally maintained
 * views, keyed by input hash, computed in batches. It replaces the per-row jobs `passages.resource`,
 * `link.resource` and `compile.course` in the app (`appJobRegistry`); the job queue stays for work
 * that needs one (Jev, the student's model, retries with backoff, external I/O).
 *
 * - passages: a live resource whose passages are missing, from an older version or an older splitter
 *   is re-split (one indexed query finds them all);
 * - facts and references, per course: skipped when the course's input hash (its inventory hash, the
 *   analyzer version and this version) equals its marker, one comparison. Otherwise every resource
 *   is analysed against the course index and written only where its facts or references differ
 *   from what is stored (delete-then-insert per changed resource). Analysis alone is cheap; the
 *   per-row job bookkeeping and per-resource commits were the cost.
 *
 * Bounded: work runs in stretches of about `budgetMs`, each stretch's writes in one transaction,
 * with a yield to the event loop between stretches (`maxBatchMs` in the report is the longest
 * stretch). Ordered: prioritised courses (opened), then the courses the student includes, then the
 * rest; while the student is present only the first two run, the rest wait for idle.
 *
 * What it writes is what the per-job path wrote (the same analyzers and store writes, over the
 * same resources), which `tests/derive-equivalence.test.ts` checks row by row.
 */
import { createHash } from "node:crypto";
import type { Resource, Store } from "@magic/contracts";
import {
  materialFactsSchema,
  resourceRefSchema,
  type CourseRef,
  type MaterialFactsInput,
  type ResourceRefInput,
} from "../../../contracts/src/course-core";
import { SPLITTER_VERSION } from "../../../retrieval/src/index";
import { courseInclusion } from "../access";
import { analyzeLinks, analyzeResource, ANALYZER_VERSION, type Role } from "../graph/analyze";
import { buildCourseIndex, isPipelineStore, type PipelineStore, type Res } from "../graph/course-index";
import { assessmentsFor, hasLinks, isMaterial } from "../graph/write";

export const DERIVE_VERSION = "derive.v1";
/** The per-row kinds the reconcile replaces; a derived course retires their leftover pending rows. */
export const REPLACED_KINDS = ["passages.resource", "link.resource", "compile.course"] as const;

// The store's derivation methods (packages/storage/src/derive.ts), structurally.
interface StoredFact {
  textHash: string;
  kind: string;
  start: number;
  end: number;
  value: string;
  basis: string;
  quote: string | null;
}
interface StoredRef {
  inputHash: string;
  toResourceId: string | null;
  externalRefId: string | null;
  target: string;
  kind: string;
  strength: string;
  reason: string;
}
type DerivedResource = Res & { textHash: string };
export interface DeriveStore {
  deriveBatch<T>(operation: () => T): T;
  passagesDue(splitter: string): { resourceId: string; accountScope: string; courseId: string }[];
  courseResourceIds(course: CourseRef): string[];
  resourcesByIds(ids: readonly string[]): DerivedResource[];
  derivedRows(ids: readonly string[], analyzerVersion: string): { facts: Map<string, StoredFact[]>; refs: Map<string, StoredRef[]> };
  courseDerivedHash(course: CourseRef): string | undefined;
  markCourseDerived(value: { course: CourseRef; hash: string; sourceId: string; now: string; retire: readonly string[] }): void;
  touchExternalRefs(course: CourseRef, urls: readonly string[], at: string): void;
  rebuildPassages(resourceId: string): number;
}
export function isDeriveStore(store: Store): store is PipelineStore & DeriveStore {
  const s = store as Partial<DeriveStore>;
  return isPipelineStore(store) && typeof s.deriveBatch === "function" && typeof s.passagesDue === "function";
}

export interface DeriveReport {
  /** Resources re-split into passages. */
  passages: number;
  /** Courses whose facts and references were recomputed / skipped as unchanged. */
  courses: number;
  unchanged: number;
  /** Resources whose facts or references were rewritten. */
  writes: number;
  /** Write transactions (one per stretch that had writes). */
  transactions: number;
  /** The longest synchronous stretch between yields (ms). */
  maxBatchMs: number;
  errors: string[];
  /** Stopped early (signal); the next run continues. */
  interrupted: boolean;
  /** Courses left for idle (not current while the student is present). */
  deferred: number;
}
export interface Derivation {
  run(signal: AbortSignal, options?: { present?: boolean }): Promise<DeriveReport>;
  /** Derive this course next, even while the student is present (they opened it). */
  prioritize(course: CourseRef): void;
}
export interface DerivationOptions {
  store: PipelineStore & DeriveStore;
  now?: () => string;
  /** Target synchronous work per stretch before yielding (ms). */
  budgetMs?: number;
  /** Resources decoded per read while building a course index. */
  pageSize?: number;
}

const yieldToEvents = () => new Promise<void>((resolve) => setImmediate(resolve));
const courseKey = (c: CourseRef) => `${c.accountScope}\u0000${c.courseId}`;
/** The link job's save filter: what the per-row path linked in a group with no course pass. */
const linkable = (r: Resource) => !!(r.text || r.links?.length || r.moduleItem?.externalUrl) && r.kind !== "event" && r.kind !== "course";

export function createDerivation(options: DerivationOptions): Derivation {
  const store = options.store;
  const now = options.now ?? (() => new Date().toISOString());
  const budgetMs = options.budgetMs ?? 8;
  const pageSize = options.pageSize ?? 100;
  const prioritized: CourseRef[] = [];
  /** A course whose pass failed at this hash waits until its inputs change (the old path's retry limit). */
  const failedAt = new Map<string, string>();
  let running: Promise<DeriveReport> | undefined;
  /** Estimated write cost per changed resource (ms), learned from each flush. */
  let writeMs = 1;

  interface Plan {
    course: CourseRef;
    sourceId: string;
    rank: number;
  }
  /** Courses in priority order; `rank` 0 = prioritised, 1 = included, 2 = the rest (idle only). */
  function plan(): Plan[] {
    const sources = store.sources();
    const records = sources.filter((s) => s.scope === "course").flatMap((s) => store.sourceResources(s.id));
    // Inclusion reads only the course records, not every resource.
    const included = courseInclusion(Object.create(store, { resources: { value: () => records } }) as Store);
    const byCourse = new Map<string, Plan>();
    for (const s of sources) {
      const key = courseKey(s);
      if (byCourse.has(key)) continue;
      const course = { accountScope: s.accountScope, courseId: s.courseId };
      const wanted = prioritized.findIndex((c) => courseKey(c) === key);
      const rank = wanted >= 0 ? 0 : included({ sourceId: s.id, courseId: s.courseId } as Resource) ? 1 : 2;
      byCourse.set(key, { course, sourceId: s.id, rank });
    }
    return [...byCourse.values()].sort((a, b) => a.rank - b.rank);
  }

  async function derive(signal: AbortSignal, present: boolean): Promise<DeriveReport> {
    const report: DeriveReport = {
      passages: 0, courses: 0, unchanged: 0, writes: 0, transactions: 0, maxBatchMs: 0, errors: [], interrupted: false, deferred: 0,
    };
    let stretch = performance.now();
    const elapsed = () => performance.now() - stretch;
    const breathe = async () => {
      report.maxBatchMs = Math.max(report.maxBatchMs, elapsed());
      await yieldToEvents();
      stretch = performance.now();
    };
    const courses = plan();
    const rankOf = new Map(courses.map((p) => [courseKey(p.course), p.rank]));
    const allowed = (rank: number | undefined) => rank !== undefined && (!present || rank < 2);
    report.deferred = courses.filter((p) => !allowed(p.rank)).length;
    if (elapsed() >= budgetMs) await breathe();

    // Passages: one indexed query for what is due, re-split in budgeted transactions.
    const due = store
      .passagesDue(SPLITTER_VERSION)
      .filter((d) => allowed(rankOf.get(courseKey(d))))
      .sort((a, b) => rankOf.get(courseKey(a))! - rankOf.get(courseKey(b))!);
    if (elapsed() >= budgetMs) await breathe();
    for (let i = 0; i < due.length; ) {
      if (signal.aborted) return { ...report, interrupted: true };
      store.deriveBatch(() => {
        do {
          store.rebuildPassages(due[i++]!.resourceId);
          report.passages++;
        } while (i < due.length && elapsed() < budgetMs);
      });
      report.transactions++;
      await breathe();
    }

    // Facts and references, course by course.
    for (const p of courses) {
      if (!allowed(p.rank)) continue;
      if (signal.aborted) return { ...report, interrupted: true };
      const inventory = store.courseInventoryHash(p.course);
      const hash = createHash("sha256").update(`${DERIVE_VERSION}\u0000${ANALYZER_VERSION}\u0000${inventory}`).digest("hex");
      const key = courseKey(p.course);
      if (store.courseDerivedHash(p.course) === hash || failedAt.get(key) === hash) {
        report.unchanged++;
        if (elapsed() >= budgetMs) await breathe();
        continue;
      }
      const done = await deriveCourse(p, inventory, hash, signal, report, elapsed, breathe);
      if (done === "interrupted") return { ...report, interrupted: true };
      if (done === "failed") failedAt.set(key, hash);
      else failedAt.delete(key);
      prioritized.splice(0, prioritized.length, ...prioritized.filter((c) => courseKey(c) !== key));
      report.courses++;
      if (elapsed() >= budgetMs) await breathe();
    }
    report.maxBatchMs = Math.max(report.maxBatchMs, elapsed());
    return report;
  }

  async function deriveCourse(
    p: Plan,
    inventory: string,
    hash: string,
    signal: AbortSignal,
    report: DeriveReport,
    elapsed: () => number,
    breathe: () => Promise<void>,
  ): Promise<"done" | "failed" | "interrupted"> {
    const { course } = p;
    // The course index: every live resource, read a page at a time.
    const ids = store.courseResourceIds(course);
    const list: DerivedResource[] = [];
    for (let i = 0; i < ids.length; i += pageSize) {
      list.push(...store.resourcesByIds(ids.slice(i, i + pageSize)));
      if (elapsed() >= budgetMs) {
        await breathe();
        if (signal.aborted) return "interrupted";
      }
    }
    const index = buildCourseIndex(course, inventory, list);
    const assessments = assessmentsFor(index, new Map<string, Role | undefined>());
    // The old path's scope: a course pass over every resource when a resource carries this course's
    // ID, and otherwise only the link job's resources.
    const coursePass = list.some((r) => r.courseId === course.courseId);
    const errors: string[] = [];
    const seenExternal = new Set<string>();
    const at = now();
    type Write = { r: DerivedResource; facts?: MaterialFactsInput; refs?: (ResourceRefInput & { external?: ExternalFound })[] };
    let writes: Write[] = [];
    const flush = () => {
      if (!writes.length) return;
      const batch = writes;
      writes = [];
      const started = performance.now();
      store.deriveBatch(() => {
        for (const w of batch) {
          if (w.facts) {
            const result = store.putMaterialFacts(w.facts);
            if (!result.ok) errors.push(...result.errors.slice(0, 3));
          }
          if (w.refs) {
            const rows = w.refs.map(({ external, ...ref }) =>
              external
                ? { ...ref, externalRefId: store.putExternalRef({ sourceId: w.r.sourceId, ...external, foundInResourceId: w.r.id }, at) }
                : ref,
            );
            const result = store.putResourceRefs(w.r.id, w.r.contentHash, rows);
            if (!result.ok) errors.push(...result.errors.slice(0, 3));
          }
        }
      });
      report.transactions++;
      report.writes += batch.length;
      // Writes cost more than the analysis that finds them: learn their cost per resource.
      writeMs = writeMs * 0.5 + ((performance.now() - started) / batch.length) * 0.5;
    };

    for (let i = 0; i < list.length; i += pageSize) {
      const page = list.slice(i, i + pageSize).filter((r) => coursePass || linkable(r));
      const stored = store.derivedRows(
        page.map((r) => r.id),
        ANALYZER_VERSION,
      );
      for (const r of page) {
        const write: Write = { r };
        if (isMaterial(index, r) && r.textHash) {
          const facts: MaterialFactsInput = {
            resourceId: r.id,
            textHash: r.textHash,
            analyzerVersion: ANALYZER_VERSION,
            facts: analyzeResource(index, r, assessments).facts,
          };
          if (!sameFacts(r, facts, stored.facts.get(r.id) ?? [])) write.facts = facts;
        }
        if (hasLinks(r)) {
          const { refs } = analyzeLinks(index, r);
          if (!sameRefs(r, refs, stored.refs.get(r.id) ?? [])) write.refs = refs;
          else for (const ref of refs) if (ref.external) seenExternal.add(ref.external.url);
        }
        if (write.facts || write.refs) writes.push(write);
        // The stretch ends when its analysis plus the writes it found would reach the budget.
        if (elapsed() + writes.length * writeMs >= budgetMs) {
          flush();
          await breathe();
          if (signal.aborted) return "interrupted";
        }
      }
    }
    flush();
    if (errors.length) {
      report.errors.push(...errors.slice(0, 5));
      return "failed";
    }
    // Written against a changed course (an import landed while this yielded): the next run redoes it.
    if (store.courseInventoryHash(course) !== inventory) return "done";
    store.deriveBatch(() => {
      store.touchExternalRefs(course, [...seenExternal], at);
      store.markCourseDerived({ course, hash, sourceId: p.sourceId, now: at, retire: REPLACED_KINDS });
    });
    report.transactions++;
    return "done";
  }

  return {
    run(signal = new AbortController().signal, { present = false } = {}) {
      running ??= derive(signal, present).finally(() => {
        running = undefined;
      });
      return running;
    },
    prioritize(course) {
      if (!prioritized.some((c) => courseKey(c) === courseKey(course))) prioritized.push(course);
    },
  };
}

type ExternalFound = NonNullable<ReturnType<typeof analyzeLinks>["refs"][number]["external"]>;

/** The facts as `putMaterialFacts` would store them equal the stored rows. */
function sameFacts(r: Resource, input: MaterialFactsInput, stored: StoredFact[]): boolean {
  if (input.facts.length !== stored.length) return false;
  if (!materialFactsSchema.safeParse(input).success) return false; // let the store report it
  return input.facts.every((f, i) => {
    const s = stored[i]!;
    const base = f.basis === "title" ? r.title : f.basis === "structure" ? (f.quote ?? "") : r.text;
    return (
      s.textHash === input.textHash &&
      s.kind === f.kind &&
      s.start === f.start &&
      s.end === f.end &&
      s.value === f.value &&
      s.basis === (f.basis ?? "text") &&
      s.quote === (f.quote ?? base.slice(f.start, f.end))
    );
  });
}
/** The references as `putResourceRefs` would store them (after their external records) equal the stored rows. */
function sameRefs(r: Resource, refs: (ResourceRefInput & { external?: ExternalFound })[], stored: StoredRef[]): boolean {
  if (refs.length !== stored.length) return false;
  return refs.every(({ external, ...ref }, i) => {
    const s = stored[i]!;
    if (!resourceRefSchema.safeParse(ref).success) return false;
    return (
      s.inputHash === r.contentHash &&
      s.toResourceId === ref.toResourceId &&
      (external ? s.externalRefId !== null : s.externalRefId === ref.externalRefId) &&
      s.target === ref.target &&
      s.kind === ref.kind &&
      s.strength === ref.strength &&
      s.reason === ref.reason
    );
  });
}
