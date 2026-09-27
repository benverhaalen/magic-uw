/** N25: bounded prepared practice. No generator/provider is reachable from this router.
 * N08/N09/N10 own grading/progression/planning; this layer owns evidence and atomic persistence. */
import {
  learningRequestSchema,
  type LearningRequest,
  type LearningResult,
  type Resource,
  type StudySessionView,
  type StudyEvent,
  type StudySource,
  type StudyItemView,
} from "@magic/contracts";
import { resolveDeadline } from "@magic/domain";
import type {
  LearningStore,
  LearningSession,
  LearningAttempt,
  StoredItem,
} from "./store";
import { canonical } from "./store";
import {
  createLearnRound,
  nextQuestion,
  recordAnswer,
  flagItem,
  type LearnState,
  type LearnQuestion,
  type LearnFamily,
} from "./learn";
import { buildSession } from "./session";
import { gradeChoice, gradeNumeric, gradeTyped } from "./grade";
import { conceptState } from "./knowledge/state";
import { mistakesQueue } from "./mistakes";

export interface StudyResource {
  id: string;
  contentHash: string;
  text: string;
  title: string;
  url: string;
  observedAt: string;
  eligible: boolean;
}
/** Trusted worker-built context; never accepted from a renderer or source document. */
export interface StudyContext {
  resourceId: string;
  accountScope: string;
  courseId: string;
  inputHash: string;
  contextHash?: string;
  label?: string;
  availability: "current" | "stale" | "blocked";
  reason: string;
  resources: StudyResource[];
}
export interface LearningRouterDependencies {
  store: LearningStore;
  resolveContext(resourceId: string): StudyContext | null;
  now?: () => Date;
}
export interface LearningRouter {
  handle(
    request: LearningRequest,
    signal: AbortSignal,
  ): Promise<LearningResult>;
}
export function eligibleStudySource(
  resource: Resource,
  at = Date.now(),
): boolean {
  if (resource.deleted || resource.gitlab) return false;
  if (resource.kind !== "assignment")
    return resource.kind === "material" || resource.kind === "course";
  const locks = resource.deadlines.filter((d) => d.kind === "lock");
  if (locks.length)
    return locks.every(
      (d) =>
        d.scopeConfirmed &&
        Number.isFinite(Date.parse(d.value)) &&
        Date.parse(d.value) <= at,
    );
  const due = resolveDeadline(resource.deadlines);
  return (
    !due.conflict &&
    !!due.dueAt &&
    Number.isFinite(Date.parse(due.dueAt)) &&
    Date.parse(due.dueAt) <= at
  );
}
interface SessionState {
  schema: "study-session-1";
  resourceId: string;
  accountScope: string;
  courseId: string;
  inputHash: string;
  contextHash: string;
  revision: number;
  goal: string;
  draft: string;
  updatedAt: string;
  round: LearnState;
  current: LearnQuestion | null;
  answered: boolean;
  assistance: "none" | "hint" | "explained";
  events: StudyEvent[];
  sources: StudySource[];
  operations: Record<string, string>;
  blocks: { kind: string; reason: string; itemIds: string[] }[];
}
function state(session: LearningSession): SessionState | null {
  const p = session.plan as Partial<SessionState> | null;
  return p?.schema === "study-session-1" &&
    typeof p.resourceId === "string" &&
    Array.isArray(p.events)
    ? (p as SessionState)
    : null;
}
const itemKey = (id: string, version: number) => `${id}@${version}`;
const requiredChecks = [
  "policy",
  "schema",
  "quote",
  "flaws",
  "near_duplicate",
  "tags",
];
const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
function eligible(
  item: StoredItem,
  c: StudyContext,
  courseRef: string,
): boolean {
  return (
    item.item.courseRef === courseRef &&
    item.item.kind !== "card" &&
    item.item.status === "active" &&
    item.sources.length > 0 &&
    requiredChecks.every((name) =>
      item.checks.some(
        (check) => check.check === name && check.outcome === "pass",
      ),
    ) &&
    !item.checks.some((check) => check.outcome === "fail") &&
    item.sources.every((s) => {
      const r = c.resources.find((r) => r.id === s.resourceId);
      return (
        !!r?.eligible &&
        s.quoteValid &&
        r.contentHash === s.contentHash &&
        s.start >= 0 &&
        s.end > s.start &&
        r.text.slice(s.start, s.end) === s.quote
      );
    })
  );
}
function familyPool(pool: StoredItem[], ordered: string[]): LearnFamily[] {
  const families = new Map<string, LearnFamily>();
  for (const id of ordered) {
    const selected = pool.find((p) => p.item.id === id);
    if (!selected) continue;
    if (families.has(selected.item.familyId)) continue;
    const family: LearnFamily = { familyId: selected.item.familyId };
    for (const p of [
      selected,
      ...pool.filter(
        (p) => p.item.familyId === selected.item.familyId && p !== selected,
      ),
    ]) {
      const item = p.item;
      if (item.kind === "card") continue;
      const key =
        item.kind === "mc" || item.kind === "tf" ? "recognition" : "recall";
      family[key] ??= {
        id: item.id,
        version: item.version,
        kind: item.kind,
        stem: item.stem,
        options: item.options,
        key: item.key,
        keyIdeas: item.keyIdeas,
        bPrior: item.bPrior,
      };
    }
    families.set(family.familyId, family);
  }
  return [...families.values()];
}
export function createLearningRouter(
  deps?: LearningRouterDependencies,
): LearningRouter {
  const time = () => deps?.now?.() ?? new Date();
  const fail = (
    op: LearningRequest["op"],
    message: string,
    status: LearningResult["status"] = "unavailable",
  ): LearningResult => ({ op, status, message });
  function scoped(session: LearningSession) {
    const p = state(session);
    if (!p || !deps) return null;
    const c = deps.resolveContext(p.resourceId);
    if (
      !c ||
      c.accountScope !== p.accountScope ||
      c.courseId !== p.courseId ||
      session.courseRef !== `${c.accountScope}:${c.courseId}`
    )
      return null;
    return { p, c };
  }
  function currentPool(c: StudyContext, courseRef: string) {
    const latest = new Map<string, StoredItem>();
    for (const item of deps!.store.items({ courseRef }))
      if (
        !latest.has(item.item.id) ||
        latest.get(item.item.id)!.item.version < item.item.version
      )
        latest.set(item.item.id, item);
    return [...latest.values()].filter((p) => eligible(p, c, courseRef));
  }
  function projection(
    session: LearningSession,
    p: SessionState,
    c: StudyContext,
  ): StudySessionView {
    const pool = currentPool(c, session.courseRef!);
    const valid = new Set(pool.map((x) => itemKey(x.item.id, x.item.version)));
    const variants = p.round.families.flatMap((f) =>
      [f.recognition, f.recall].filter((v) => v !== undefined),
    );
    const stale =
      (c.contextHash ?? c.inputHash) !== p.contextHash ||
      c.inputHash !== p.inputHash ||
      variants.some((v) => !valid.has(itemKey(v.id, v.version)));
    const availability =
      c.availability !== "current"
        ? c.availability
        : stale
          ? "stale"
          : "current";
    const selected =
      p.current &&
      pool.find(
        (x) =>
          x.item.id === p.current!.itemId &&
          x.item.version === p.current!.itemVersion,
      );
    let currentItem: StudyItemView | undefined;
    if (selected && p.current && availability === "current")
      currentItem = {
        id: selected.item.id,
        version: selected.item.version,
        kind: p.current.format,
        stem: p.current.stem,
        options: p.current.options ?? null,
        ...(selected.item.unit ? { unit: selected.item.unit } : {}),
        citations: selected.sources.map((s) => ({
          resourceId: s.resourceId,
          contentHash: s.contentHash,
          start: s.start,
          end: s.end,
          quote: s.quote,
        })),
        checks: selected.checks.map(({ check, method, outcome }) => ({
          check,
          method,
          outcome,
        })),
      };
    return {
      id: session.id,
      resourceId: p.resourceId,
      accountScope: p.accountScope,
      courseId: p.courseId,
      inputHash: p.inputHash,
      revision: p.revision,
      goal: p.goal,
      draft: p.draft,
      startedAt: session.startedAt,
      updatedAt: p.updatedAt,
      availability,
      reason:
        c.availability !== "current"
          ? c.reason
          : stale
            ? "Course sources or checked items changed. Start a new session; your saved response remains here."
            : "Prepared practice; answers are checked locally.",
      status: p.current ? "active" : "complete",
      ...(currentItem ? { currentItem } : {}),
      answered: p.answered,
      events: p.events,
      sources: p.sources ?? [],
      plan: p.blocks,
    };
  }
  return {
    async handle(raw, signal) {
      const parsed = learningRequestSchema.safeParse(raw);
      if (!parsed.success)
        return fail(raw.op, "Invalid learning request.", "failed");
      const request = parsed.data,
        op = request.op;
      if (!deps)
        return fail(op, "This study feature isn't built yet.", "not_built");
      if (signal.aborted) return fail(op, "Study request cancelled.");
      const store = deps.store;
      try {
        if (op === "study.sessions") {
          const c = deps.resolveContext(request.resourceId);
          if (!c) return fail(op, "Course context is unavailable.");
          const sessions = store
            .sessions(`${c.accountScope}:${c.courseId}`)
            .flatMap((s) => {
              const v = scoped(s);
              return v && v.p.resourceId === request.resourceId
                ? [projection(s, v.p, v.c)]
                : [];
            });
          return { op, status: "ok", data: { sessions } };
        }
        if (op === "study.plan") {
          if (!request.resourceId || !request.operationId)
            return fail(
              op,
              "Open a course resource to start a saved study session.",
            );
          if (
            request.assessmentId ||
            (request.filter && request.filter !== "all")
          )
            return fail(
              op,
              "Assessment and filtered sessions aren't connected yet.",
              "not_built",
            );
          const c = deps.resolveContext(request.resourceId);
          if (!c) return fail(op, "Course context is unavailable.");
          if (request.courseId && request.courseId !== c.courseId)
            return fail(op, "Course context does not match.");
          const fingerprint = canonical(request),
            ref = `${c.accountScope}:${c.courseId}`;
          const prior = store.sessions(ref).find((s) => {
            const p = state(s);
            return (
              !!p &&
              p.resourceId === request.resourceId &&
              Object.hasOwn(p.operations, request.operationId!)
            );
          });
          if (prior) {
            const p = state(prior)!;
            return p.operations[request.operationId] === fingerprint
              ? { op, status: "ok", data: { session: projection(prior, p, c) } }
              : fail(
                  op,
                  "Operation ID was already used for a different request.",
                  "failed",
                );
          }
          if (c.availability !== "current") return fail(op, c.reason);
          if (request.inputHash && request.inputHash !== c.inputHash)
            return fail(
              op,
              "Course context changed. Reopen it before starting.",
            );
          store.course(c.accountScope, c.courseId, c.label);
          const pool = currentPool(c, ref).slice(0, 1000),
            concepts = store.concepts(ref).filter((x) => x.status === "active");
          if (!pool.length)
            return fail(
              op,
              "No checked practice is ready for this course yet. Your course material is still available.",
            );
          const evidence = store.evidence(ref),
            allItems = store.items({ courseRef: ref }),
            cards = store.cards({ courseRef: ref });
          const models = conceptState(
            {
              ...evidence,
              items: new Map(
                allItems.map((x) => [
                  itemKey(x.item.id, x.item.version),
                  {
                    bPrior: x.item.bPrior,
                    options: x.item.options?.length ?? 0,
                    status: x.item.status,
                  },
                ]),
              ),
              cards: new Map(
                cards.map((x) => [
                  x.id,
                  { conceptId: x.conceptId, isConceptTrack: x.isConceptTrack },
                ]),
              ),
            },
            concepts,
            undefined,
            time(),
          );
          const sessionId = crypto.randomUUID();
          const planned = buildSession({
            sessionId,
            minutes: request.minutes,
            difficulty: request.difficulty,
            concepts,
            models,
            pool: pool.map((x) => ({
              id: x.item.id,
              kind: x.item.kind,
              options: x.item.options?.length ?? 0,
              bPrior: x.item.bPrior,
              tags: x.tags,
            })),
            mistakes: mistakesQueue(evidence.attempts, {
              today: localDay(time()),
              disputes: evidence.disputes,
            }),
            dueCards: [],
          });
          const round = createLearnRound(
            familyPool(
              pool,
              planned.blocks.flatMap((b) => b.itemIds),
            ),
            { size: 10 },
          );
          const current = nextQuestion(round);
          if (!current)
            return fail(
              op,
              "No checked practice matches this course's concept map yet.",
            );
          const at = time().toISOString();
          const p: SessionState = {
            schema: "study-session-1",
            resourceId: c.resourceId,
            accountScope: c.accountScope,
            courseId: c.courseId,
            inputHash: c.inputHash,
            contextHash: c.contextHash ?? c.inputHash,
            revision: 0,
            goal: request.goal ?? "Practice this course",
            draft: "",
            updatedAt: at,
            round,
            current,
            answered: false,
            assistance: "none",
            events: [],
            sources: c.resources
              .filter((r) =>
                pool.some(
                  (item) =>
                    round.families.some(
                      (f) => f.familyId === item.item.familyId,
                    ) &&
                    item.sources.some((source) => source.resourceId === r.id),
                ),
              )
              .map((r) => ({
                resourceId: r.id,
                contentHash: r.contentHash,
                title: r.title,
                url: r.url,
                observedAt: r.observedAt,
              })),
            operations: { [request.operationId]: fingerprint },
            blocks: planned.blocks,
          };
          const s: LearningSession = {
            id: sessionId,
            courseRef: ref,
            kind: "learn",
            plan: p,
            minutes: request.minutes,
            difficulty: request.difficulty,
            startedAt: at,
            endedAt: null,
          };
          if (signal.aborted) return fail(op, "Study request cancelled.");
          if (!store.commitSession(s, null))
            return fail(op, "Study session changed. Reload it.");
          return { op, status: "ok", data: { session: projection(s, p, c) } };
        }
        if (
          op !== "study.session" &&
          op !== "study.resume" &&
          op !== "study.draft" &&
          op !== "study.advance" &&
          op !== "study.answer" &&
          op !== "study.hint"
        )
          return fail(op, "This study feature isn't built yet.", "not_built");
        const session = store.session(request.sessionId);
        if (!session) return fail(op, "Study session is unavailable.");
        const scope = scoped(session);
        if (!scope)
          return fail(
            op,
            "Study session is unavailable for this course and account.",
          );
        const { c } = scope,
          p = structuredClone(scope.p),
          view = projection(session, p, c);
        if (op === "study.session" || op === "study.resume")
          return { op, status: "ok", data: { session: view } };
        if (!request.operationId || request.revision === undefined)
          return fail(op, "A session revision and operation ID are required.");
        const fingerprint = canonical(request);
        if (Object.hasOwn(p.operations, request.operationId))
          return p.operations[request.operationId] === fingerprint
            ? { op, status: "ok", data: { session: view } }
            : fail(
                op,
                "Operation ID was already used for a different request.",
                "failed",
              );
        if (request.revision !== p.revision)
          return fail(
            op,
            "Study session changed. Reload it before continuing.",
          );
        // Draft recovery remains possible when source freshness or policy blocks practice.
        if (op !== "study.draft" && view.availability !== "current")
          return fail(op, view.reason);
        if (p.events.length >= 1000 || Object.keys(p.operations).length >= 5000)
          return fail(op, "This session is full. Start another session.");
        const at = time().toISOString();
        let attempt: LearningAttempt | undefined;
        if (op === "study.draft") p.draft = request.draft;
        else {
          const q = p.current;
          if (!q) return fail(op, "This study round is complete.");
          const selected = currentPool(c, session.courseRef!).find(
            (x) => x.item.id === q.itemId && x.item.version === q.itemVersion,
          );
          if (!selected)
            return fail(
              op,
              "The question's source or checks changed. Start a new session.",
            );
          const item = selected.item;
          const event = (
            kind: StudyEvent["kind"],
            text: string,
          ): StudyEvent => ({
            id: crypto.randomUUID(),
            operationId: request.operationId!,
            itemId: item.id,
            itemVersion: item.version,
            kind,
            text,
            createdAt: at,
            assistance: p.assistance,
          });
          if (op === "study.advance") {
            if (request.action === "next" && !p.answered)
              return fail(op, "Answer or skip this question first.");
            if (request.action === "skip" && !p.answered) {
              p.events.push(event("skip", "Skipped without a score."));
              p.round = flagItem(p.round, item.id);
            }
            p.current = nextQuestion(p.round);
            p.answered = false;
            p.assistance = "none";
            p.draft = "";
          } else if (op === "study.hint") {
            if (request.itemId !== item.id)
              return fail(op, "The question changed. Reload the session.");
            if (p.answered)
              return fail(
                op,
                "Continue to the next question before asking for a hint.",
              );
            if (
              !item.explanation ||
              !selected.checks.some(
                (check) =>
                  check.check === "explanation" && check.outcome === "pass",
              )
            )
              return fail(
                op,
                "This question has no prepared explanation. No model was called.",
              );
            // The canonical checked item stores an explanation, not a separate smaller hint. Label the exposure honestly.
            p.assistance = "explained";
            p.events.push(event("explain", item.explanation));
          } else {
            if (p.answered)
              return fail(
                op,
                "This question was already answered. Continue first.",
              );
            if (
              request.itemId !== item.id ||
              request.itemVersion !== item.version
            )
              return fail(op, "The question changed. Reload the session.");
            const response = request.response;
            if (
              item.kind === "mc" || item.kind === "tf"
                ? response.kind !== "choice" ||
                  !item.options?.some((o) => o.id === response.optionId)
                : item.kind === "numeric"
                  ? response.kind !== "number"
                  : response.kind !== "text"
            )
              return fail(
                op,
                "Answer format does not match this question.",
                "failed",
              );
            const grade =
              response.kind === "choice"
                ? gradeChoice(item, response.optionId)
                : response.kind === "number"
                  ? gradeNumeric(item, response.value, response.unit)
                  : gradeTyped(
                      { ...item, key: String(item.key) },
                      response.text,
                    );
            const score =
              "score" in grade
                ? (grade.score as number | null)
                : grade.outcome === "correct"
                  ? 1
                  : 0;
            const answerText =
              response.kind === "text"
                ? response.text
                : response.kind === "choice"
                  ? (item.options?.find((o) => o.id === response.optionId)
                      ?.text ?? response.optionId)
                  : `${response.value}${response.unit ? ` ${response.unit}` : ""}`;
            p.events.push({
              ...event("answer", answerText),
              outcome: grade.outcome,
              score,
              checks: grade.checks,
            });
            p.round = recordAnswer(
              p.round,
              q,
              grade.outcome === "undecided"
                ? "undecided"
                : grade.outcome === "correct"
                  ? "right"
                  : "wrong",
            ).state;
            if (score !== null) {
              const evidence = store.evidence(session.courseRef!);
              attempt = {
                id: crypto.randomUUID(),
                courseRef: session.courseRef!,
                itemId: item.id,
                itemVersion: item.version,
                sourceResourceId: selected.sources[0]?.resourceId ?? null,
                primaryConceptId:
                  selected.tags.find((t) => t.primary)?.conceptId ??
                  selected.tags[0]?.conceptId ??
                  "",
                correct: grade.outcome === "correct",
                assistance: p.assistance,
                seenBefore:
                  evidence.attempts.some((a) => a.itemId === item.id) ||
                  p.events
                    .slice(0, -1)
                    .some((e) => e.itemId === item.id && e.kind === "answer") ||
                  store.sessions(session.courseRef!).some((s) => {
                    if (s.id === session.id) return false;
                    const prior = state(s);
                    return (
                      prior?.current?.itemId === item.id ||
                      prior?.events.some((e) => e.itemId === item.id)
                    );
                  }),
                confidence: request.confidence,
                createdAt: at,
                format: q.format,
                mode: p.blocks.some((b) => b.kind === "diagnostic")
                  ? "diagnostic"
                  : "learn",
                response,
                score,
                gradingMethod: "code",
                responseMs: request.responseMs,
                conceptTags: selected.tags,
                sessionId: session.id,
                localDay: localDay(new Date(at)),
                ...(response.kind === "choice"
                  ? { optionId: response.optionId }
                  : {}),
              };
            }
            p.answered = true;
            p.draft = "";
          }
        }
        p.revision++;
        p.updatedAt = at;
        p.operations = { ...p.operations, [request.operationId]: fingerprint };
        const updated = { ...session, plan: p, endedAt: p.current ? null : at };
        if (signal.aborted) return fail(op, "Study request cancelled.");
        if (!store.commitSession(updated, request.revision, attempt))
          return fail(
            op,
            "Study session changed. Reload it before continuing.",
          );
        return {
          op,
          status: "ok",
          data: { session: projection(updated, p, c) },
        };
      } catch {
        return fail(
          op,
          "The study request could not be completed. Reload the session to check its saved state.",
          "failed",
        );
      }
    },
  };
}
