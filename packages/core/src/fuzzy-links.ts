import { createHash } from "node:crypto";
import type {
  Store,
  Resource,
  Link,
  SourceHealth,
  LinkCandidate,
  LinkCandidateFeatures,
  LinkCandidateListing,
} from "@magic/contracts";

/**
 * Fuzzy assignment → supporting-material candidates, local and lexical only.
 *
 * Scope before scoring: only material/messages from the same account and course are ever
 * considered. There is no automatic acceptance band: every candidate is a `supports` link with
 * status `proposed`, and exact `specifies`/`same_as` links remain the only automatic links.
 * `evidenceFor().supporting()` follows `specifies` only, so these suggestions (even after a
 * student accepts one) never enter hosted AI or MCP context as if they were exact.
 *
 * The defaults below are unevaluated starting parameters, not approved thresholds; see
 * docs/pipeline-details.md "Link thresholds: a testable starting method".
 */
export const FUZZY_LINK_VERSION = "link.fuzzy.v1";
export const FUZZY_LINK_MODEL = "local-lexical";
export interface FuzzyLinkParams {
  /** Candidates below this score are not recorded (abstain). Provisional, not approved. */
  minScore: number;
  /** Minimum lexical evidence (title, text, or name reference); module/date alone never suggest. */
  minLexical: number;
  weights: {
    title: number;
    text: number;
    reference: number;
    module: number;
    date: number;
  };
  /** Multiplier when both titles carry small numbers and none agree ("Homework 3" vs "Homework 4"). */
  numberConflictPenalty: number;
  /** Date proximity decays to zero this many days outside the assignment's open→due window. */
  dateWindowDays: number;
  maxCandidates: number;
}
export const defaultFuzzyLinkParams: FuzzyLinkParams = {
  minScore: 0.3,
  minLexical: 0.1,
  weights: { title: 0.35, text: 0.3, reference: 0.2, module: 0.1, date: 0.05 },
  numberConflictPenalty: 0.5,
  dateWindowDays: 14,
  maxCandidates: 8,
};

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const fuzzyLinkId = (fromId: string, toId: string) =>
  `fuzzy:${hash(`${fromId}:${toId}:supports`)}`;

const STOP = new Set(
  "a an and are as at be by for from has have in is it its of on or that the this to was were will with your you we our i my me not but if then than so do does did can all any each into about over under per via vs page file module item week due".split(
    " ",
  ),
);
function tokens(text: string): string[] {
  return (
    text
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
    .filter((t) => !STOP.has(t) && (t.length > 1 || /\d/.test(t)))
    .map((t) => (t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}
/** Small identifiers such as "3" in "Homework 3"; years and long IDs are ignored. */
function smallNumbers(title: string) {
  return new Set(
    (title.match(/\d+/g) ?? [])
      .filter((n) => n.length <= 3)
      .map((n) => String(Number(n))),
  );
}
function phrase(text: string) {
  return ` ${tokens(text).join(" ")} `;
}
function time(value: string | null | undefined) {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
function normalizedUrl(url: string) {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    return u.href.replace(/\/download$/, "").replace(/\/$/, "");
  } catch {
    return url;
  }
}

function isAssignment(r: Resource) {
  return r.kind === "assignment";
}
/** Supporting documents: pages, files, module items, announcements/discussions. Containers are excluded. */
function isCandidateTarget(r: Resource) {
  if (r.kind !== "material" && r.kind !== "message") return false;
  if (r.module || r.assignmentGroup) return false;
  // The student's own submissions, feedback, and repositories are not course material.
  if (r.submission || r.gitlab) return false;
  if (/\/files\/folder\//.test(r.url)) return false;
  const type = r.moduleItem?.type;
  // An Assignment/Quiz/Discussion module item *is* an assignment pointer (identity, not support).
  if (type && ["Assignment", "Quiz", "Discussion", "SubHeader"].includes(type)) return false;
  return true;
}
function bodyText(r: Resource) {
  const pages = r.document?.pages?.map((p) => p.text).join("\n") ?? "";
  return `${r.text}\n${pages}`.slice(0, 50000);
}

/** Read-once view of the store, shared by every assignment in one suggestion pass. */
export interface SuggestionContext {
  resources: Resource[];
  sources: Map<string, SourceHealth>;
  links: Link[];
  indexes: Map<string, CourseIndex>;
}
interface CourseIndex {
  course: Resource[];
  docTokens: Map<string, string[]>;
  idf: (t: string) => number;
  moduleOf: Map<string, Set<string>>;
  resolvedItems: Set<string>;
  /** Hash of rule version, parameters, and this course's candidate documents. */
  fingerprint: string;
}
export function suggestionContext(store: Store): SuggestionContext {
  return {
    resources: store.resources().filter((r) => !r.deleted),
    sources: new Map(store.sources().map((s) => [s.id, s])),
    links: store.links(),
    indexes: new Map(),
  };
}
function courseIndex(
  ctx: SuggestionContext,
  account: string,
  courseId: string,
  params: FuzzyLinkParams,
): CourseIndex {
  const cacheKey = JSON.stringify([account, courseId]);
  const cached = ctx.indexes.get(cacheKey);
  if (cached) return cached;
  // Scope before scoring: same account AND same course, never across terms or sections.
  const course = ctx.resources.filter(
    (r) => r.courseId === courseId && ctx.sources.get(r.sourceId)?.accountScope === account,
  );
  // Course-local idf over every document in this course so common words ("homework") weigh little.
  const docTokens = new Map(course.map((r) => [r.id, tokens(`${r.title}\n${bodyText(r)}`)]));
  const df = new Map<string, number>();
  for (const list of docTokens.values())
    for (const t of new Set(list)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = Math.max(course.length, 1);
  const idf = (t: string) => Math.log(1 + n / (1 + (df.get(t) ?? 0))) || 0.01;
  // Module membership from module-item captures (scope `module-items:<moduleId>`).
  const moduleOf = new Map<string, Set<string>>();
  const addModule = (id: string, moduleId: string) =>
    moduleOf.set(id, new Set([...(moduleOf.get(id) ?? []), moduleId]));
  const byUrl = new Map<string, Resource[]>();
  for (const r of course) {
    const k = normalizedUrl(r.url);
    byUrl.set(k, [...(byUrl.get(k) ?? []), r]);
  }
  const byExternalId = new Map<string, Resource[]>();
  for (const r of course)
    if (!r.moduleItem) byExternalId.set(r.externalId, [...(byExternalId.get(r.externalId) ?? []), r]);
  // A module item whose content was captured separately is a pointer; suggest the content, not both.
  const resolvedItems = new Set<string>();
  for (const item of course) {
    if (!item.moduleItem) continue;
    const moduleId = ctx.sources.get(item.sourceId)?.scope.match(/^module-items:(.+)$/)?.[1];
    if (moduleId) addModule(item.id, moduleId);
    const contentId = item.moduleItem.contentId;
    const pointed = [
      ...(contentId ? (byExternalId.get(contentId) ?? []) : []),
      ...(item.links ?? []).flatMap(
        (pointer) => byUrl.get(normalizedUrl(typeof pointer === "string" ? pointer : pointer.url)) ?? [],
      ),
    ].filter((r) => r.id !== item.id);
    if (pointed.length) resolvedItems.add(item.id);
    if (moduleId) for (const r of pointed) addModule(r.id, moduleId);
  }
  // One document captured twice (a listing row and its fetched body) is suggested once: keep the fullest.
  for (const same of byUrl.values()) {
    const targets = same.filter((r) => isCandidateTarget(r) && !resolvedItems.has(r.id));
    if (targets.length < 2) continue;
    const keep = targets.reduce((a, b) =>
      bodyText(b).length > bodyText(a).length || (bodyText(b).length === bodyText(a).length && b.id < a.id) ? b : a,
    );
    for (const r of targets) if (r.id !== keep.id) resolvedItems.add(r.id);
  }
  const fingerprint = hash(
    JSON.stringify([
      FUZZY_LINK_VERSION,
      params,
      course
        .filter((r) => isCandidateTarget(r) || r.moduleItem)
        .map((r) => `${r.id}:${r.contentHash}`)
        .sort(),
    ]),
  );
  const index = { course, docTokens, idf, moduleOf, resolvedItems, fingerprint };
  ctx.indexes.set(cacheKey, index);
  return index;
}

/** Compute scored candidates for one assignment without writing anything. */
export function scoreEvidenceCandidates(
  store: Store,
  assignmentId: string,
  params: FuzzyLinkParams = defaultFuzzyLinkParams,
  ctx: SuggestionContext = suggestionContext(store),
): { assignment: Resource; scored: (LinkCandidate & { target: Resource })[]; considered: number } {
  const assignment = ctx.resources.find((r) => r.id === assignmentId);
  if (!assignment || assignment.deleted || !isAssignment(assignment))
    throw new Error("Choose an available assignment to find supporting material.");
  const account = ctx.sources.get(assignment.sourceId)?.accountScope;
  if (!account) throw new Error("This assignment has no source scope.");
  const { course, docTokens, idf, moduleOf, resolvedItems } = courseIndex(
    ctx,
    account,
    assignment.courseId,
    params,
  );
  const exactOrIdentity = new Set(
    ctx.links
      .filter(
        (l) =>
          (l.type === "specifies" || l.type === "same_as") &&
          (l.fromId === assignment.id || l.toId === assignment.id),
      )
      .map((l) => (l.fromId === assignment.id ? l.toId : l.fromId)),
  );
  function vector(list: string[]) {
    const tf = new Map<string, number>();
    for (const t of list) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, c] of tf) {
      const w = (1 + Math.log(c)) * idf(t);
      v.set(t, w);
      norm += w * w;
    }
    return { v, norm: Math.sqrt(norm) };
  }
  const assignmentVector = vector(docTokens.get(assignment.id)!);
  const assignmentTitle = [...new Set(tokens(assignment.title))];
  const assignmentTitleWeight = assignmentTitle.reduce((s, t) => s + idf(t), 0);
  const assignmentPhrase = phrase(bodyText(assignment));
  const assignmentNumbers = smallNumbers(assignment.title);

  const targets = course.filter(
    (r) =>
      r.id !== assignment.id &&
      isCandidateTarget(r) &&
      !exactOrIdentity.has(r.id) &&
      !resolvedItems.has(r.id),
  );
  const assignmentModules = moduleOf.get(assignment.id) ?? new Set<string>();

  const open = time(assignment.unlockAt) ?? time(assignment.createdAt);
  const due =
    time(assignment.dueAt) ??
    time(assignment.deadlines.find((d) => d.kind === "due")?.value);
  const windowMs = params.dateWindowDays * 86400000;

  const scored = targets.map((target) => {
    const targetTitle = new Set(tokens(target.title));
    const shared = assignmentTitle.filter((t) => targetTitle.has(t));
    const title = assignmentTitleWeight
      ? shared.reduce((s, t) => s + idf(t), 0) / assignmentTitleWeight
      : 0;
    const tv = vector(docTokens.get(target.id)!);
    let dot = 0;
    for (const [t, w] of assignmentVector.v) dot += w * (tv.v.get(t) ?? 0);
    const text = assignmentVector.norm && tv.norm ? dot / (assignmentVector.norm * tv.norm) : 0;
    // A literal name reference: needs at least two content tokens or a file name so "Notes" cannot match.
    const referenceBy: LinkCandidateFeatures["referenceBy"] = [];
    const targetNames = [target.title, target.file?.displayName].filter(
      (x): x is string => !!x && (tokens(x).length >= 2 || /\.\w{2,5}$/.test(x)),
    );
    if (targetNames.some((name) => assignmentPhrase.includes(phrase(name))))
      referenceBy.push("assignment_names_target");
    if (tokens(assignment.title).length >= 2 && phrase(bodyText(target)).includes(phrase(assignment.title)))
      referenceBy.push("target_names_assignment");
    const reference = referenceBy.length ? 1 : 0;
    const targetModules = moduleOf.get(target.id) ?? new Set<string>();
    const sharedModules = [...targetModules].filter((m) => assignmentModules.has(m));
    const moduleScore = sharedModules.length ? 1 : 0;
    const targetAt =
      time(target.createdAt) ?? time(target.unlockAt) ?? time(target.updatedAt);
    let date: number | null = null;
    if (targetAt !== null && (open !== null || due !== null)) {
      const start = open ?? due!,
        end = due ?? open!;
      const outside = targetAt < start ? start - targetAt : targetAt > end ? targetAt - end : 0;
      date = Math.max(0, 1 - outside / windowMs);
    }
    const targetNumbers = smallNumbers(target.title);
    const numberConflict =
      assignmentNumbers.size > 0 &&
      targetNumbers.size > 0 &&
      ![...assignmentNumbers].some((x) => targetNumbers.has(x));
    const w = params.weights;
    const lexical = Math.max(title, text, reference);
    let score =
      w.title * title +
      w.text * text +
      w.reference * reference +
      w.module * moduleScore +
      w.date * (date ?? 0);
    if (numberConflict) score *= params.numberConflictPenalty;
    if (lexical < params.minLexical) score = Math.min(score, params.minScore * 0.5);
    score = Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000;
    const features: LinkCandidateFeatures = {
      titleOverlap: round(title),
      sharedTitleTerms: shared,
      textSimilarity: round(text),
      reference,
      referenceBy,
      sameModule: moduleScore,
      sharedModuleIds: sharedModules,
      dateProximity: date === null ? null : round(date),
      numberConflict,
    };
    return {
      linkId: fuzzyLinkId(target.id, assignment.id),
      targetId: target.id,
      targetTitle: target.title,
      targetKind: target.kind,
      score,
      rank: 0,
      match: "suggested" as const,
      status: "proposed" as Link["status"],
      reason: explain(features, score),
      features,
      target,
    };
  });
  scored.sort((a, b) => b.score - a.score || a.targetTitle.localeCompare(b.targetTitle));
  scored.forEach((c, i) => (c.rank = i + 1));
  return { assignment, scored, considered: targets.length };
}
const round = (x: number) => Math.round(x * 1000) / 1000;
function explain(f: LinkCandidateFeatures, score: number) {
  const parts: string[] = [];
  if (f.sharedTitleTerms.length)
    parts.push(`title shares ${f.sharedTitleTerms.map((t) => `"${t}"`).join(", ")}`);
  if (f.textSimilarity >= 0.05) parts.push(`text similarity ${f.textSimilarity.toFixed(2)}`);
  if (f.referenceBy.includes("assignment_names_target")) parts.push("the assignment names this document");
  if (f.referenceBy.includes("target_names_assignment")) parts.push("this document names the assignment");
  if (f.sameModule) parts.push("same module");
  if (f.dateProximity !== null && f.dateProximity > 0) parts.push("posted near the assignment dates");
  if (f.numberConflict) parts.push("numbers in the titles disagree");
  return `Suggested, not verified (score ${score.toFixed(2)}; lexical match in this course only): ${parts.join("; ") || "weak evidence"}. Confirm or reject.`;
}

/**
 * Record candidates at or above `minScore` as proposed `supports` links (material → assignment)
 * with a versioned judgment of their features, then list them together with any earlier decisions
 * that still apply to the current evidence. Below the threshold nothing is recorded: abstain.
 */
export type FuzzyLinkOverrides = Partial<Omit<FuzzyLinkParams, "weights">> & {
  weights?: Partial<FuzzyLinkParams["weights"]>;
};
function resolveParams(overrides: FuzzyLinkOverrides): FuzzyLinkParams {
  return {
    ...defaultFuzzyLinkParams,
    ...overrides,
    weights: { ...defaultFuzzyLinkParams.weights, ...overrides.weights },
  };
}
export function suggestEvidenceLinks(
  store: Store,
  assignmentId: string,
  now: string,
  overrides: FuzzyLinkOverrides = {},
  ctx: SuggestionContext = suggestionContext(store),
): LinkCandidateListing {
  const params = resolveParams(overrides);
  const { assignment, scored, considered } = scoreEvidenceCandidates(store, assignmentId, params, ctx);
  const current = new Map(
    ctx.links
      .filter((l) => l.id.startsWith("fuzzy:") && l.toId === assignment.id)
      .map((l) => [l.id, l]),
  );
  const listed: LinkCandidate[] = [];
  let proposed = 0;
  for (const candidate of scored) {
    const existing = current.get(candidate.linkId);
    const decided = !!existing && existing.status !== "proposed";
    const above = candidate.score >= params.minScore && proposed < params.maxCandidates;
    // Student decisions on unchanged evidence stay visible even if parameters changed since.
    if (!above && !decided) continue;
    if (!decided) proposed++;
    const { target, ...rest } = candidate;
    // Re-proposal keeps a rejection (storage never overwrites it) so it is not silently restored.
    store.putLink({
      id: candidate.linkId,
      fromId: target.id,
      toId: assignment.id,
      type: "supports",
      reason: candidate.reason,
      status: "proposed",
      inputHash: target.contentHash,
    });
    store.putJudgment({
      key: `${FUZZY_LINK_VERSION}:${candidate.linkId}:${assignment.contentHash}:${target.contentHash}`,
      resourceId: assignment.id,
      inputHash: assignment.contentHash,
      model: FUZZY_LINK_MODEL,
      questionVersion: FUZZY_LINK_VERSION,
      result: {
        linkId: candidate.linkId,
        targetId: target.id,
        targetHash: target.contentHash,
        score: candidate.score,
        features: candidate.features,
        params,
      },
      createdAt: now,
    });
    listed.push(rest);
  }
  if (listed.length) {
    // One read after writing: a stale rejection re-attached by putLink comes back as rejected.
    const status = new Map(store.links().map((l) => [l.id, l.status]));
    for (const c of listed) c.status = status.get(c.linkId) ?? "proposed";
  }
  const top = scored[0]?.score ?? null,
    runnerUp = scored[1]?.score ?? null;
  return {
    assignmentId: assignment.id,
    version: FUZZY_LINK_VERSION,
    minScore: params.minScore,
    considered,
    abstained: !listed.some((c) => c.status !== "rejected"),
    topScore: top,
    runnerUpMargin: top !== null && runnerUp !== null ? round(top - runnerUp) : null,
    candidates: listed,
  };
}

export interface SuggestionPassOptions {
  now: string;
  /** Stop starting new assignments after this much wall time; the rest wait for the next sync. */
  budgetMs?: number;
  /** At most this many assignments are rescored per pass. */
  maxAssignments?: number;
  /** Courses the student excluded are skipped. */
  include?: (r: Resource) => boolean;
  overrides?: FuzzyLinkOverrides;
  clock?: () => number;
}
export interface SuggestionPassReport {
  assignments: number;
  unchanged: number;
  rescored: number;
  deferred: number;
  failed: number;
  suggested: number;
}
export const SUGGESTION_PASS_LIMITS = { budgetMs: 250, maxAssignments: 100 };
const scanKey = (r: Resource) => `${FUZZY_LINK_VERSION}:scan:${r.id}:${r.contentHash}`;

/**
 * Background pass after ingestion. Incremental: an assignment is rescored only when its own
 * content hash changed (its scan marker no longer matches) or its course's candidate-document
 * fingerprint differs from the one recorded in that marker. Bounded by time and count; skipped
 * work is picked up by the next pass. Per-assignment failures are counted, never thrown.
 */
export function refreshEvidenceSuggestions(
  store: Store,
  options: SuggestionPassOptions,
): SuggestionPassReport {
  const clock = options.clock ?? (() => performance.now());
  const started = clock();
  const budgetMs = options.budgetMs ?? SUGGESTION_PASS_LIMITS.budgetMs;
  const maxAssignments = options.maxAssignments ?? SUGGESTION_PASS_LIMITS.maxAssignments;
  const params = resolveParams(options.overrides ?? {});
  const ctx = suggestionContext(store);
  const markers = new Map(
    store
      .judgments()
      .filter((j) => j.questionVersion === FUZZY_LINK_VERSION && j.key.includes(":scan:"))
      .map((j) => [j.key, j]),
  );
  // Account-level to-do/upcoming rows are summary copies of course assignments; scan the originals.
  const assignments = ctx.resources.filter(
    (r) =>
      isAssignment(r) &&
      !ctx.sources.get(r.sourceId)?.scope.startsWith("account-") &&
      (options.include?.(r) ?? true),
  );
  const report: SuggestionPassReport = {
    assignments: assignments.length,
    unchanged: 0,
    rescored: 0,
    deferred: 0,
    failed: 0,
    suggested: 0,
  };
  const pending: { r: Resource; fingerprint: string }[] = [];
  for (const r of assignments) {
    const account = ctx.sources.get(r.sourceId)?.accountScope;
    if (!account) continue;
    const fingerprint = courseIndex(ctx, account, r.courseId, params).fingerprint;
    const marker = markers.get(scanKey(r));
    if (
      marker?.inputHash === r.contentHash &&
      (marker.result as { courseFingerprint?: string }).courseFingerprint === fingerprint
    )
      report.unchanged++;
    else pending.push({ r, fingerprint });
  }
  // Most useful first: incomplete work due soonest, then undated, then past or completed.
  const nowMs = Date.parse(options.now);
  const priority = (r: Resource) => {
    const due = time(r.dueAt) ?? time(r.deadlines.find((d) => d.kind === "due")?.value);
    if (r.completed) return 4e15;
    if (due === null) return 2e15;
    return due >= nowMs ? due : 3e15 - due;
  };
  pending.sort((a, b) => priority(a.r) - priority(b.r));
  for (const { r, fingerprint } of pending) {
    if (report.rescored + report.failed >= maxAssignments || clock() - started >= budgetMs) {
      report.deferred++;
      continue;
    }
    try {
      const listing = suggestEvidenceLinks(store, r.id, options.now, options.overrides ?? {}, ctx);
      store.putJudgment({
        key: scanKey(r),
        resourceId: r.id,
        inputHash: r.contentHash,
        model: FUZZY_LINK_MODEL,
        questionVersion: FUZZY_LINK_VERSION,
        result: { courseFingerprint: fingerprint, candidates: listing.candidates.length },
        createdAt: options.now,
      });
      report.rescored++;
      report.suggested += listing.candidates.filter((c) => c.status === "proposed").length;
    } catch {
      report.failed++;
    }
  }
  return report;
}

/** Stored fuzzy-link judgments whose assignment AND target evidence are both still current. */
export function currentLinkJudgments(store: Store, assignmentId: string) {
  const assignment = store.resource(assignmentId);
  if (!assignment || assignment.deleted) return [];
  return store.judgments().filter((j) => {
    if (
      j.resourceId !== assignmentId ||
      j.questionVersion !== FUZZY_LINK_VERSION ||
      j.inputHash !== assignment.contentHash
    )
      return false;
    const result = j.result as { targetId?: string; targetHash?: string };
    const target = result.targetId ? store.resource(result.targetId) : undefined;
    return !!target && !target.deleted && target.contentHash === result.targetHash;
  });
}
