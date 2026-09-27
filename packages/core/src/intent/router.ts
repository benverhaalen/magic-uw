/**
 * The command bar's intent router (D40 extended): any plain-language request becomes one
 * registered action with code-validated arguments, a clarification with candidates, or a
 * grounded answer. Code first (0 tokens); the model only classifies what code missed, never
 * gets tools, and never decides an ID, a date or a permission.
 *
 * Latency: when a command arrives, the AI branch's preparation (client lookup, catalogue
 * prompt, cache lookup) starts at once and overlaps the code resolver; the send itself is gated
 * on the resolver's verdict (`speculation: "gate"`, the default), so a code hit bills nothing and
 * a miss starts the call as soon as preparation is done. `race` (send at once, abort on a code
 * hit) is kept for measurement: in this single-threaded worker the synchronous resolver answers
 * before the send's first await resumes, so it measured the same as gate (see the architecture
 * doc, "Command bar and intent router").
 */
import { randomUUID } from "node:crypto";
import { courseInclusion } from "../access";
import type { CommandOutcome, IntentCandidate, IntentCommand, IntentCommandResult, IntentSlots } from "@magic/contracts";
import type { ModelRunner, WarmRequest } from "../../../runner/src/index";
import { buildPrompt, memoryArtifactStore, memoryLedgerStore, type ArtifactStore, type CourseFrame, type LedgerStore } from "../../../packs/core/src/index";
import { classifyPack, SLOT_GLOSSARY, type ClassifyInput, type ClassifyOutput, type ClassifySlots } from "../../../packs/intent/src/index";
import { readPackArtifact, runPack } from "../jobs/pack";
import { defaultActions } from "./adapters";
import { groundedAsk, refersBack, type PreviousExchange } from "./ask";
import { coursePrefixes, type CoursePrefixSource } from "../course-facts/prefix"; // owner: course-facts
import { createCourseBriefs } from "../course-facts/brief";
import { authorizer } from "./consent";
import { buildIndex, createResolve, findCourseMentions, indexSignature, norm, refreshTopics, type IntentIndex } from "./courses";
import { createRegistry, type ActionRegistry, type AnyAction } from "./registry";
import { candidate, courseDisplay, normaliseUtterance, resolveCode, resolveSlots, type CodeOutcome } from "./resolve";
import type { ActionContext, AskResult, IntentHost, IntentStore, ResolvedArgs, ResolvedCourse } from "./types";
import { intentProtection } from "../privacy/intent"; // owner: privacy

export interface IntentRouterDeps {
  store: IntentStore;
  /** The student's own client, or null when none is connected. */
  runner: () => ModelRunner | null | Promise<ModelRunner | null>;
  artifacts?: ArtifactStore;
  ledger?: LedgerStore;
  now?: () => Date;
  timeZone?: string;
  /** Actions registered ahead of the built-ins (the notes lane's, via intent/adapters/notes.ts). */
  actions?: AnyAction[];
  /** Starts the client for the classify prefix without sending anything (SessionPool.warm). */
  warm?: (request: WarmRequest) => Promise<unknown>;
  speculation?: "gate" | "race";
  /** Replaces the index build (tests use a slow one to prove it stays outside the budget). */
  buildIndex?: (store: IntentStore) => IntentIndex;
  /** false skips the code resolver: the AI-only baseline, for measurement. */
  codePath?: boolean;
  /** owner: privacy. false skips the protection pass: the unprotected baseline, for measurement only. */
  protect?: boolean;
  resolverBudgetMs?: number;
  clock?: () => number;
  /** owner: course-facts. The course prefix (brief + pack catalogue) for a one-course ask. */
  coursePrefix?: CoursePrefixSource;
}

const zero = () => ({ in: 0, cached: 0, out: 0 });
type Tokens = ReturnType<typeof zero>;
const add = (a: Tokens, b: Tokens): Tokens => ({ in: a.in + b.in, cached: a.cached + b.cached, out: a.out + b.out });
const INDEX_RECHECK_MS = 2000;
/** How long the last ask's exchange stays available to a question that refers back (the pool's idle close). */
export const PREVIOUS_EXCHANGE_MS = 10 * 60 * 1000;
export const NO_CLIENT_REASON =
  "Only exact commands work without an AI connected (like \"what's due tomorrow\" or \"quiz me on recursion in CS 400\"). Connect Claude or Codex in Settings to ask in your own words.";

type ClassifyAttempt =
  | { status: "done"; output: ClassifyOutput; cached: boolean; tokens: Tokens; model: string }
  | { status: "no_client" }
  | { status: "blocked"; reason: string }
  | { status: "failed"; reason: string };

/** owner: privacy. The model's arguments with this request's placeholders put back as the student wrote them. */
function restoreArgs(output: ClassifyOutput, restore: (v: string) => string): ClassifyOutput {
  const fix = (a: ClassifySlots): ClassifySlots =>
    Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === "string" ? restore(v) : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? restore(x) : x)) : v])) as ClassifySlots;
  return { ...output, args: fix(output.args), alternatives: output.alternatives?.map((a) => ({ ...a, args: fix(a.args) })) ?? output.alternatives };
}

const clean = (s: ClassifySlots): IntentSlots =>
  Object.fromEntries(Object.entries(s).filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && !v.length))) as IntentSlots;

export function createIntentRouter(deps: IntentRouterDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const clock = deps.clock ?? (() => performance.now());
  const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const artifacts = deps.artifacts ?? memoryArtifactStore();
  const ledger = deps.ledger ?? memoryLedgerStore();
  const registry: ActionRegistry = createRegistry(defaultActions(deps.actions));
  const speculation = deps.speculation ?? "gate";
  // owner: privacy: runs only in classify (after a code miss) and in ask; warmed with the index.
  const protection = intentProtection(store, deps.protect !== false);
  // The course prefix (brief + pack catalogue) opens every one-course ask, so the pooled session's
  // prefix is byte-stable and past the prompt-cache minimum. Built in memory when the host passes
  // none, the same default as the pack handler's.
  const coursePrefix = deps.coursePrefix ?? coursePrefixes(createCourseBriefs({ store }).courseBrief);
  // The last answered exchange per ask scope. Each ask sends only its question and passages; this one
  // exchange goes along only when the next question refers back to it.
  const exchanges = new Map<string, PreviousExchange & { at: number }>();

  let cached: IntentIndex | null = null;
  let checkedAt = -Infinity;
  /**
   * The resolver's index (courses, assignments, compiled matchers, current courses' concept maps).
   * Built at launch and at prewarm, and otherwise once, synchronously, before a command's resolver
   * budget starts. Rechecked at most every 2 s: a change in the sources' revision (a sync added or
   * changed courses or assignments) rebuilds it; a changed concept map is re-read.
   */
  const index = (): IntentIndex => {
    const t = performance.now();
    if (!cached) {
      cached = (deps.buildIndex ?? buildIndex)(store);
      checkedAt = t;
    } else if (t - checkedAt > INDEX_RECHECK_MS) {
      checkedAt = t;
      if (cached.signature !== indexSignature(store)) cached = (deps.buildIndex ?? buildIndex)(store);
      else refreshTopics(store, cached);
    }
    return cached;
  };
  // Inside a command the resolvers read the index as prepared; they never rebuild it mid-budget.
  const current = () => cached ?? index();
  const resolve = createResolve(store, current, now, timeZone);
  const acquire = (): Promise<ModelRunner | null> =>
    (async () => deps.runner())().catch(() => null);

  /** The byte-stable prefix: the catalogue, the argument glossary and the course codes and names. */
  function classifyFrame(): CourseFrame {
    const courses = resolve.courses().map((c) => `- ${c.code ? `${c.code}: ` : ""}${c.name}`);
    return {
      courseId: "intent",
      course: "Command bar",
      skeleton: [`Actions:\n${registry.catalogue()}`, `Arguments:\n${SLOT_GLOSSARY}`, `The student's courses:\n${courses.join("\n") || "- none yet"}`].join("\n\n"),
      policy: "Not applicable: this call only routes a command and reads no course material.",
    };
  }
  const hintsOf = (slots: IntentSlots) =>
    Object.entries(slots)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(", ") : String(v)}`);

  async function classify(text: string, hints: IntentSlots, contextCourse: ResolvedCourse | null, runnerP: Promise<ModelRunner | null>, signal: AbortSignal): Promise<ClassifyAttempt> {
    // owner: privacy: the command and hints are the student's words; the catalogue and courses are teaching text.
    const p = protection.request("classify");
    const plainFrame = classifyFrame();
    // The prefix and course labels are protected when the bar opens and cached by content; only
    // the student's own words are protected here, between submit and send.
    const frame: CourseFrame = { ...plainFrame, skeleton: protection.prefix(plainFrame.skeleton) };
    const input: ClassifyInput = {
      utterance: p.text(normaliseUtterance(text) || text.trim().toLowerCase(), "personal"),
      currentCourse: contextCourse ? protection.prefix(courseDisplay(contextCourse)) : null,
      hints: hintsOf(hints).map((h) => p.text(h, "personal")),
    };
    const runner = await runnerP;
    if (signal.aborted) return { status: "failed", reason: "Cancelled." };
    const prompt = buildPrompt(classifyPack, frame, input, []);
    const receiptIds: string[] = [];
    const authorize = authorizer(
      store,
      { purpose: "Understand a command-bar request", course: "Command bar", title: "command", text: prompt.input, policy: frame.policy, resourceIds: [], characters: prompt.systemPrompt.length + prompt.input.length },
      () => now().toISOString(),
      receiptIds,
    );
    if (!runner) {
      // No client: a cached classification still serves (0 tokens); a miss is the code path only.
      const art = readPackArtifact(artifacts, classifyPack, frame, input, []);
      if (art) return { status: "done", output: restoreArgs(art.output, p.restore), cached: true, tokens: zero(), model: art.model };
      return { status: "no_client" };
    }
    const result = await runPack({ runner, artifacts, ledger, authorize, now: () => now().getTime() }, classifyPack, frame, input, [], { lane: "interactive", scope: "command", signal });
    if (result.status === "done") return { status: "done", output: restoreArgs(result.artifact.output, p.restore), cached: result.cached, tokens: result.cached ? zero() : result.artifact.usage, model: result.artifact.model }; // owner: privacy
    if (result.status === "blocked") return { status: "blocked", reason: result.reason };
    if (result.status === "needs_student") return { status: "failed", reason: "The AI's reading of that request didn't pass the app's checks." };
    return { status: "failed", reason: result.message };
  }

  function context(host: IntentHost, signal: AbortSignal, runnerP: Promise<ModelRunner | null>, spent: { tokens: Tokens }, request: ActionContext["request"]): ActionContext {
    return {
      request,
      store,
      host,
      resolve,
      now: now(),
      timeZone,
      signal,
      ask: async (question, courses, s): Promise<AskResult> => {
        const list = courses === "all" ? resolve.courses() : courses;
        const selected = request.resourceId ? store.resource(request.resourceId) : undefined;
        const usesOriginCourse = courses !== 'all' && list.length === 1 && [list[0]!.ref, list[0]!.courseId].includes(request.courseId ?? "");
        if (request.resourceId && usesOriginCourse && (!selected || selected.deleted)) return {text: '', citations: [], notFound: false, dropped: 0, path: 'none', tokens: {in: 0, cached: 0, out: 0}, unavailable: 'This saved item is no longer available. Choose another item.'};
        const sourceAccounts = new Map(store.sources().map(source => [source.id, source.accountScope]));
        const sourceAccount = selected ? sourceAccounts.get(selected.sourceId) : undefined;
        // An explicit course or all-courses request wins over the originating item.
        const normalizeTitle = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const questionTitle = normalizeTitle(question);
        const namedOther = selected && store.resources().some(row => !row.deleted && row.id !== selected.id && row.courseId === selected.courseId && sourceAccounts.get(row.sourceId) === sourceAccount && normalizeTitle(row.title).length > 4 && questionTitle.includes(normalizeTitle(row.title)));
        const resourceId = courses !== "all" && !namedOther && selected && !selected.deleted && list.length === 1 && list[0]!.courseId === selected.courseId && list[0]!.accountScope === sourceAccount ? selected.id : undefined;
        const key = list.map((c) => c.ref).sort().join("\n");
        const last = exchanges.get(key);
        const previous = last && now().getTime() - last.at <= PREVIOUS_EXCHANGE_MS && refersBack(question) ? { question: last.question, answer: last.answer } : null;
        // Retrieval searches without the course the question names ("in cs 400"): code already resolved it, and no passage contains it.
        const said = norm(question);
        const mentions = findCourseMentions(current(), said);
        const searchText = mentions.length ? [...mentions].reverse().reduce((t, m) => `${t.slice(0, m.start)} ${t.slice(m.end)}`, said).replace(/\s+/g, " ").trim() : undefined;
        const r = await groundedAsk({ store, runner: () => runnerP, artifacts, ledger, now, resourceId, protection, timeZone, coursePrefix /* owner: course-facts */ }, question, list, s, { previous, ...(searchText ? { searchText } : {}) }); // owner: privacy
        if (!r.notFound && !r.unavailable) exchanges.set(key, { question, answer: r.text, at: now().getTime() });
        spent.tokens = add(spent.tokens, r.tokens);
        return r;
      },
    };
  }

  function record(path: IntentCommandResult["path"], action: string | null, latencyMs: number, course: ResolvedCourse | undefined, model: string, escalated = false) {
    try {
      store.addLedgerEntry({
        // No "~" in the id: the pack ledger reader skips route rows, and tokens stay on the call rows.
        id: randomUUID(),
        pack: "intent-route",
        packVersion: action ?? "none",
        tier: path,
        model: model || path,
        tokensIn: 0,
        tokensCached: 0,
        tokensOut: 0,
        latencyMs: Math.max(0, Math.round(latencyMs)),
        checkFailures: 0,
        escalated,
        course: course ? { accountScope: course.accountScope, courseId: course.courseId } : null,
        createdAt: now().toISOString(),
      });
    } catch {
      // The ledger is observability; a failed row never fails the command.
    }
  }

  function runAction(spec: AnyAction, args: ResolvedArgs, host: IntentHost, signal: AbortSignal, runnerP: Promise<ModelRunner | null>, spent: { tokens: Tokens }, request: ActionContext["request"] = {}, allowedActions?: readonly string[]) {
    // The authoritative dispatch boundary, after code/model resolution and before effects.
    signal.throwIfAborted();
    if (allowedActions && !allowedActions.includes(spec.name))
      return { kind: "answer", unavailable: `“${spec.label?.(args) ?? spec.name}” needs review in its action screen before it can change anything. Nothing was changed.` };
    // Cached lookup finds candidates; current store inclusion authorizes their use.
    if (args.course || args.assignment) {
      const rows = store.resources(), included = courseInclusion(store, rows);
      const sources = new Map(store.sources().map(source => [source.id, source]));
      const current = rows.filter(row => !row.deleted && included(row));
      if (args.course && !current.some(row => row.courseId === args.course!.courseId && sources.get(row.sourceId)?.accountScope === args.course!.accountScope))
        return { kind: "answer", unavailable: "This course is no longer included. Choose an included course and try again." };
      if (args.assignment && !current.some(row => row.id === args.assignment!.resourceId && (!args.course || (row.courseId === args.course.courseId && sources.get(row.sourceId)?.accountScope === args.course.accountScope))))
        return { kind: "answer", unavailable: "This item is no longer available in the current course. Choose it again." };
    }
    signal.throwIfAborted();
    return spec.run(args, context(host, signal, runnerP, spent, request));
  }

  function outcomeOf(spec: AnyAction, args: ResolvedArgs, result: unknown) {
    const r = result as ({ kind?: unknown } & Partial<AskResult>) | null;
    if (r && r.kind === "answer") {
      if (r.unavailable) return { status: "unavailable" as const, reason: r.unavailable };
      return { status: "answer" as const, text: r.text ?? "", citations: r.citations ?? [], notFound: !!r.notFound, dropped: r.dropped ?? 0 };
    }
    const { text: _text, ...shown } = args;
    return { status: "ran" as const, action: spec.name, args: shown as Record<string, unknown>, result };
  }

  async function handle(command: IntentCommand, host: IntentHost, signal: AbortSignal): Promise<IntentCommandResult> {
    const mode = command.mode ?? "run";
    if (mode === "preview") return preview(command.text, command.context?.courseId);
    if (mode === "prewarm") return prewarm();
    const t0 = clock();
    const text = command.text.trim();
    const spent = { tokens: zero() };
    const done = (o: CommandOutcome, path: IntentCommandResult["path"], action: string | null, course?: ResolvedCourse, model = ""): IntentCommandResult => {
      const latencyMs = clock() - t0;
      record(path, action, latencyMs, course, model);
      return { ...o, path, latencyMs, tokens: spent.tokens };
    };
    if (!text) return done({ status: "clarify", question: "What would you like to do?", candidates: [] }, "none", null);

    // Speculation: the AI branch starts preparing now, overlapping the code resolver.
    const runnerP = acquire();
    const aiAbort = new AbortController();
    const onAbort = () => aiAbort.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const contextCourse = command.context?.courseId ? resolve.courseById(command.context.courseId) : null;
    const raced = speculation === "race" ? classify(text, {}, contextCourse, runnerP, aiAbort.signal).catch((): ClassifyAttempt => ({ status: "failed", reason: "Cancelled." })) : null;
    try {
      const code: CodeOutcome = deps.codePath === false ? { status: "miss", slots: {} } : resolveCode(text, command.context?.courseId, { registry, resolve, index, budgetMs: deps.resolverBudgetMs });
      if (code.status === "hit") {
        aiAbort.abort();
        const spec = registry.get(code.action)!;
        const result = await runAction(spec, code.args, host, signal, runnerP, spent, command.context, command.allowedActions);
        return done(outcomeOf(spec, code.args, result), "code", spec.name, code.args.course);
      }
      if (code.status === "clarify") {
        aiAbort.abort();
        return done({ status: "clarify", question: code.question, candidates: code.candidates }, "code", code.action);
      }
      const attempt = await (raced ?? classify(text, code.slots, contextCourse, runnerP, aiAbort.signal));
      if (attempt.status === "no_client") return done({ status: "unavailable", reason: NO_CLIENT_REASON }, "none", null);
      if (attempt.status !== "done") return done({ status: "unavailable", reason: attempt.reason }, "none", null);
      spent.tokens = add(spent.tokens, attempt.tokens);
      const path = attempt.cached ? "cache" : "ai";
      const out = attempt.output;
      // Code-settled slots win over the model's where the model left them out.
      const slots: IntentSlots = { ...code.slots, ...clean(out.args) };
      const spec = registry.get(out.action);
      const alternatives = (out.alternatives ?? []).flatMap((a): IntentCandidate[] => {
        const s = registry.get(a.action);
        return s ? [candidate(s, clean(a.args))] : [];
      });
      if (!spec || out.confidence === "low") {
        const primary = spec ? [candidate(spec, slots)] : [];
        return done(
          { status: "clarify", question: out.question?.trim() || "I'm not sure what you'd like to do. Did you mean one of these?", candidates: [...primary, ...alternatives].slice(0, 4) },
          path,
          spec?.name ?? null,
          undefined,
          attempt.model,
        );
      }
      const checked = resolveSlots(spec, slots, resolve, text, command.context?.courseId);
      if (!checked.ok) return done({ status: "clarify", question: checked.question, candidates: checked.candidates.length ? checked.candidates : alternatives }, path, spec.name, undefined, attempt.model);
      const result = await runAction(spec, checked.args, host, signal, runnerP, spent, command.context, command.allowedActions);
      return done(outcomeOf(spec, checked.args, result), path, spec.name, checked.args.course, attempt.model);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** The live hint while typing or dictating: the code resolver only, 0 tokens, never the model. */
  function preview(text: string, courseId?: string): IntentCommandResult {
    const t0 = clock();
    const code = resolveCode(text, courseId, { registry, resolve, index, budgetMs: deps.resolverBudgetMs });
    const base = { path: "code" as const, tokens: zero() };
    if (code.status === "hit") {
      const spec = registry.get(code.action)!;
      return { status: "preview", hint: candidate(spec, code.slots, code.args).label, action: spec.name, slots: code.slots, ...base, latencyMs: clock() - t0 };
    }
    if (code.status === "clarify") return { status: "preview", hint: code.question, action: code.action, slots: code.slots, ...base, latencyMs: clock() - t0 };
    return { status: "preview", hint: null, action: null, slots: code.slots, ...base, latencyMs: clock() - t0 };
  }

  /** Called when the bar opens: builds the index and the prefix, finds the client, warms it. */
  async function prewarm(): Promise<IntentCommandResult> {
    const t0 = clock();
    index();
    const frame = classifyFrame();
    protection.warm(frame.skeleton); // owner: privacy: the roster and the protected prefix
    const runner = await acquire();
    if (runner && deps.warm) {
      const prompt = buildPrompt(classifyPack, frame, { utterance: "", currentCourse: null, hints: [] }, []);
      // The same lane, tier and prefix the classify call uses, so that call finds the session warm.
      await deps
        .warm({ systemPrompt: prompt.systemPrompt, pack: { id: classifyPack.id, version: classifyPack.version }, tier: classifyPack.tier, lane: "interactive", courseId: frame.courseId })
        .catch(() => undefined);
    }
    return { status: "ready", ai: !!runner, path: "none", latencyMs: clock() - t0, tokens: zero() };
  }

  /** Builds the index now (at launch, after the first bootstrap query) so no command waits on it. */
  function ready(): void {
    index();
    protection.warm(classifyFrame().skeleton); // owner: privacy: the roster and the protected prefix
  }

  return { registry, handle, preview, prewarm, ready, resolve, index };
}
export type IntentRouter = ReturnType<typeof createIntentRouter>;
