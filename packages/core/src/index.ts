import type { CourseCoreStore } from "../../contracts/src/course-core";
import {
  effectiveCoursePolicy,
  intelligenceView,
  courseExtractionHash,
} from "../../domain/src/course-intelligence";
import type {
  CourseExtractionBatch,
  CourseIntelligence,
} from "@magic/contracts";
import { randomUUID } from "node:crypto";
import {
  commandSchema,
  courseExtractionBatchSchema,
  OUTLOOK_CALENDAR_COURSE_ID,
  type Store,
  type ContextManifest,
  type CommandResult,
  type Snapshot,
  type CaptureBatch,
  type Resource,
  type Job,
} from "@magic/contracts";
import { maySend, resolveDeadline } from "@magic/domain";
import { JudgmentBudgetError, judgmentResultSchema, type JudgmentGateway } from "@magic/ai";
import { contentCategories, courseIncluded, courseInclusion } from "./access";
import { evidenceFor, linkExactEvidence } from "./evidence";
import { rebaseFixture } from "./fixture-dates";
export { rebaseFixture } from "./fixture-dates";
import { buildWorkSet } from "./work-set";
export { buildWorkSet, launchWorkSet, materializeCopy, safeWebLink, selectWorkRetry, MAX_WORK_ITEMS, type WorkLaunchHost } from "./work-set";
import { clearOutgoingProjections, outgoingProjection, payloadScrubber, validateCitations } from "./identity";
export { scrubText, rosterFor, toOriginalSpan, validateCitations } from "./identity";
import { pullGuideForSubject } from "../../connectors/src/planning-public";
import {
  createPublicClient,
  type PublicClient,
} from "../../connectors/src/network";
import { planningIdentityTable, summarizePlanningGrades } from "./planning-grades";
import { pullMadgradesGrades, type MadgradesTransport } from "../../connectors/src/madgrades";
import { comparePlanning } from "./planning";
import { applyConsent, egressFor } from "./egress"; // owner: T06
import { reconcileAcademicRecords } from "./academic-reconciliation";
import type { UwPlanningHttp } from "../../connectors/src/uw-planning-http";
import {
  buildUwPublicCourseSearchRequest,
  normalizeUwPublicCourseSearch,
  buildUwPublicEnrollmentPackagesRequest,
  normalizeUwPublicEnrollmentPackages,
} from "../../connectors/src/uw-planning-catalog";
// owner: T05b. The seams: the job registry, the stub drain and the injected handlers.
import { enqueueOnSave, type JobRegistry } from "./jobs/registry";
import { defaultJobRegistry, runRegistered } from "./jobs/default-registry";
import { resourceViews, runQuery } from "./queries"; // owner: T15
import type { QueryRequest } from "@magic/contracts";
import type {
  Correction,
  LearningRequest,
  LearningResult,
  PackScope,
  UiEvent,
  WorkspaceCommand,
  WorkspaceResult,
} from "@magic/contracts";
/**
 * Each seam is filled by its owning lane; an absent seam answers honestly ("not built")
 * instead of pretending. None of them receives the network: a handler that sends goes
 * through egress like every other send.
 */
export interface CoreSeams {
  /** N25's learning router (packages/learning/src/router.ts). */
  learning?: {
    handle(request: LearningRequest, signal: AbortSignal): Promise<LearningResult>;
  };
  /** The course map reader (schema v5, the data builder). */
  map?(courseId: string, accountScope: string | undefined): unknown;
  /** D33 corrections; the data builder stores them, and a correction wins. */
  correct?(value: Correction, at: string): string;
  /** The runtime builder's pack runner (packages/runner, packages/packs). */
  pack?(pack: string, scope: PackScope, signal: AbortSignal): Promise<unknown>;
  /** ui_events (schema v5). */
  uiEvent?(value: UiEvent, at: string): void;
}
export type { JobRegistry } from "./jobs/registry";
// end owner: T05b
export interface CoreOptions {
  fixture: CaptureBatch;
  courseExtractor?: {
    version?: string;
    extract(
      input: {
        inputHash: string;
        resources: Pick<
          Resource,
          "id" | "contentHash" | "text" | "kind" | "externalId"
        >[];
      },
      signal: AbortSignal,
    ): Promise<CourseExtractionBatch | null>;
  };
  gateway?: JudgmentGateway;
  now?: () => Date;
  /** Local time zone used to place the sample course on today. Defaults to the system zone. */
  timeZone?: string;
  planningPublicClient?: PublicClient;
  planningHttp?: Pick<UwPlanningHttp, "read">;
  madgrades?: MadgradesTransport;
  // owner: T05b
  jobs?: JobRegistry;
  seams?: CoreSeams;
  // end owner: T05b
}
export function createCore(store: Store, options: CoreOptions) {
  const planningReads = new Set<AbortController>();
  // owner: T05b. Seam calls (learning, packs) are cancelled by purge and privacy like planning reads.
  const seamCalls = new Set<AbortController>();
  const jobs = options.jobs ?? defaultJobRegistry();
  const seams = options.seams ?? {};
  // end owner: T05b
  const publicClient = options.planningPublicClient ?? createPublicClient();
  const semanticAttempts = new Map<
    string,
    {
      status: "running" | "complete" | "partial" | "unavailable";
      attemptedAt: string;
    }
  >();
  let wakePending = false;
  const now = () => (options.now?.() ?? new Date()).toISOString();
  let generation = 0,
    active: AbortController | undefined,
    working: Promise<void> | undefined,
    closed = false;
  function profileFor(r: Resource): CourseIntelligence | undefined {
    const source = store.sources().find((s) => s.id === r.sourceId);
    return source
      ? store
          .courseIntelligence()
          .find(
            (p) =>
              p.accountScope === source.accountScope &&
              p.courseId === r.courseId,
          )
      : undefined;
  }
  function snapshot(search?: string): Snapshot {
    // owner: T15. The full snapshot stays for debugging; views use scoped queries (queries.ts).
    const resources = resourceViews(store, store.resources(search));
    const sources = store.sources();
    return {
      courseIntelligence: store.courseIntelligence().map((p) => ({
        ...intelligenceView(p, store.sources(), now()),
        semantic: semanticAttempts.get(
          `${p.id}:${p.inputHash}:${options.courseExtractor?.version ?? "v1"}`,
        ) ?? {
          status: p.extraction
            ? (p.extraction.coverage?.status ?? "complete")
            : options.courseExtractor
              ? "pending"
              : "unavailable",
        },
      })),
      planning: {
        records: store.planningRecords(),
        sources: store.planningSources(),
        reconciliation: reconcileAcademicRecords(store, now()),
      },
      resources,
      sources,
      privacy: store.privacy(),
      links: store.links(),
      jobs: store.jobs(),
      receipts: store.receipts(),
      attempts: store.attempts(),
      fixtureMode: sources.some((s) => s.kind === "fixture"),
      gatewayConfigured: !!options.gateway,
      generatedAt: now(),
      ingestionSettings: store.ingestionSettings(),
      courseOverrides: store.courseOverrides(),
      changes: store.changes({ limit: 100 }),
      syncRuns: store.syncRuns(),
      mcpGrants: store
        .mcpGrants()
        .map(({ tokenHash: _secretHash, ...grant }) => grant),
      // owner: T06: the renderer routes on these and main's consent gate mirrors them.
      consents: store.consents?.() ?? [],
      dayPlan: store.dayPlan(),
      personalReports: store.personalReports(),
    };
  }
  function context(
    id: string,
    recipient: ContextManifest["recipient"],
  ): ContextManifest {
    const r = store.resource(id);
    if (!r || r.deleted) throw new Error("This item is no longer available.");
    // An explicit allowlist: no source URLs, cookies, credentials, account IDs, grades, or student drafts.
    const supporting =
      recipient === "jev"
        ? []
        : evidenceFor(store)
            .supporting(r)
            .filter(
              (s) =>
                courseIncluded(store, s) &&
                contentCategories(s).every(
                  (c) => maySend(store.privacy(), recipient, [c]).allowed,
                ),
            );
    const profile = recipient === "jev" ? undefined : profileFor(r);
    const effectivePolicy = effectiveCoursePolicy(profile, r);
    if (
      profile &&
      intelligenceView(profile, store.sources(), now()).freshness !==
        "current_capture" &&
      effectivePolicy.mode === "allowed"
    )
      effectivePolicy.mode = "coaching";
    const policyResources = effectivePolicy.resourceIds
      .map((id) => store.resource(id))
      .filter((s): s is Resource => !!s && !s.deleted);
    const policyAllowed = policyResources.every(
      (s) =>
        courseIncluded(store, s) &&
        contentCategories(s).every(
          (c) => maySend(store.privacy(), recipient, [c]).allowed,
        ),
    );
    // Hosted recipients get identity-scrubbed free text; this payload is both
    // the preview and the exact outgoing body. Each field is scrubbed on its own
    // so citations can be re-validated per source field.
    const scrub = payloadScrubber(store, recipient !== "local", store.sources().find((s) => s.id === r.sourceId)?.accountScope);
    const rootText = scrub.field(r.text, r.courseId);
    const payload = {
      course: scrub.field(r.courseName, r.courseId).slice(0, 200),
      title: scrub.field(r.title, r.courseId).slice(0, 500),
      text: [
        rootText,
        ...supporting.map((s) => `${scrub.field(s.title, s.courseId)}\n${scrub.field(s.text, s.courseId)}`),
      ]
        .join("\n\n")
        .slice(0, 12000),
      policy: scrub.field((policyAllowed
        ? effectivePolicy.evidence
        : "Policy evidence is withheld by data-sharing settings; use coaching only."
      ), r.courseId).slice(0, 4000),
    };
    const redaction = scrub.summary(r.courseId);
    const categories = [
      ...new Set(
        [r, ...supporting, ...(policyAllowed ? policyResources : [])].flatMap(
          contentCategories,
        ),
      ),
    ];
    const permission = maySend(store.privacy(), recipient, categories);
    if (!courseIncluded(store, r)) {
      permission.allowed = false;
      permission.reason =
        "This course is excluded. Include it in Sources before sharing its data.";
    }
    return {
      recipient,
      effectivePolicy:
        recipient === "local"
          ? effectivePolicy
          : {
              ...effectivePolicy,
              mode: policyAllowed ? effectivePolicy.mode : "unknown",
              evidence: payload.policy,
              claimIds: [],
              resourceIds: [],
            },
      purpose:
        recipient === "jev"
          ? "Classify assignment kind"
          : "Explain coursework with course policy",
      categories,
      resourceIds: [
        ...new Set([
          id,
          ...supporting.map((s) => s.id),
          ...(policyAllowed ? policyResources.map((s) => s.id) : []),
        ]),
      ],
      characters: JSON.stringify(payload).length,
      ...permission,
      payload,
      ...(recipient !== "local" ? { citationProjections: [{ resourceId: r.id, contentHash: r.contentHash, field: "text" as const, projectionId: outgoingProjection(store, r, "text", { start: 0, end: Math.min(payload.text.length, rootText.length) }).id }] } : {}),
      ...(redaction ? { redaction } : {}),
    };
  }
  function receipt(
    manifest: ContextManifest,
    status: "blocked" | "sent" | "failed",
  ) {
    store.addReceipt({
      id: randomUUID(),
      recipient: manifest.recipient,
      purpose: manifest.purpose,
      categories: manifest.categories,
      resourceIds: manifest.resourceIds,
      characters: manifest.characters,
      status,
      createdAt: now(),
    });
  }
  function current(job: Job, version: number) {
    const r = store.resource(job.resourceId);
    const live = store.jobs().find((j) => j.id === job.id);
    return (
      !closed &&
      generation === version &&
      r &&
      !r.deleted &&
      r.contentHash === job.inputHash &&
      live?.leaseToken === job.leaseToken &&
      live.status === "running" &&
      !!live.leaseUntil &&
      live.leaseUntil > now()
    );
  }
  async function extractCourses() {
    if (!options.courseExtractor || closed) return;
    for (const profile of store.courseIntelligence()) {
      // Let interactive IPC run between profiles; reuse access lookup within this synchronous batch.
      await new Promise<void>(resolve => setImmediate(resolve));
      if (closed) return;
      const key = `${profile.id}:${profile.inputHash}:${options.courseExtractor.version ?? "v1"}`;
      if (
        options.courseExtractor.version &&
        profile.extraction?.extractorVersion.startsWith(
          `${options.courseExtractor.version}:`,
        )
      )
        continue;
      const prior = semanticAttempts.get(key);
      if (
        prior &&
        (prior.status !== "unavailable" ||
          Date.parse(now()) - Date.parse(prior.attemptedAt) < 300_000)
      )
        continue;
      const attemptedAt = now();
      semanticAttempts.set(key, { status: "running", attemptedAt });
      const included = courseInclusion(store);
      const resources = profile.dependencies
        .map((d) => store.resource(d.resourceId))
        .filter(
          (r): r is Resource =>
            !!r &&
            !r.deleted &&
            !r.gitlab &&
            (r.externalId === "syllabus" || r.kind === "assignment") &&
            included(r),
        );
      if (!resources.length) {
        semanticAttempts.set(key, { status: "unavailable", attemptedAt });
        continue;
      }
      const version = generation;
      active = new AbortController();
      const timer = setTimeout(() => active?.abort(), 90_000);
      try {
        const batch = await options.courseExtractor.extract(
          {
            inputHash: profile.inputHash,
            resources: resources.map(
              ({ id, contentHash, text, kind, externalId }) => ({
                id,
                contentHash,
                text,
                kind,
                externalId,
              }),
            ),
          },
          active.signal,
        );
        if (
          batch &&
          !closed &&
          generation === version &&
          !active.signal.aborted
        ) {
          const applied = store.applyCourseExtraction(
            profile.accountScope,
            profile.courseId,
            batch,
            now(),
          );
          const parsedBatch = courseExtractionBatchSchema.safeParse(batch);
          const accepted =
            parsedBatch.success &&
            store
              .courseIntelligence()
              .find(
                (p) =>
                  p.id === profile.id &&
                  p.inputHash === profile.inputHash &&
                  p.extraction?.resultHash ===
                    courseExtractionHash(parsedBatch.data),
              );
          semanticAttempts.set(key, {
            status:
              applied || accepted
                ? (accepted && accepted.extraction?.coverage?.status) ||
                  "complete"
                : "unavailable",
            attemptedAt,
          });
        } else
          semanticAttempts.set(key, { status: "unavailable", attemptedAt });
      } catch {
        semanticAttempts.set(key, {
          status: "unavailable",
          attemptedAt,
        }); /* No cloud fallback. */
      } finally {
        clearTimeout(timer);
        active = undefined;
      }
      if (generation !== version) break;
    }
  }
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleBudgetWake() {
    clearTimeout(budgetTimer);
    const until = store.jobCooldown("enrich.resource");
    const delay = until ? Date.parse(until) - Date.parse(now()) : 0;
    if (!closed && delay > 0) {
      budgetTimer = setTimeout(wake, Math.min(delay, 2_147_483_647));
      budgetTimer.unref?.();
    }
  }
  async function drain() {
    if (closed) return;
    scheduleBudgetWake();
    let job: Job | undefined;
    while (!closed) {
      // Each registered handler retains its own egress checks. Jev availability only
      // controls assignment enrichment; storage excludes kinds with durable cooldowns.
      const kinds = jobs.readyKinds().filter((kind) => kind !== "enrich.resource");
      if (options.gateway && maySend(store.privacy(), "jev", ["course_text"]).allowed)
        kinds.push("enrich.resource");
      if (!kinds.length) break;
      job = (store as Store & Pick<CourseCoreStore, "lease">).lease(now(), 60000, kinds);
      if (!job) break;
      if (job.kind !== "enrich.resource") {
        // Registered kinds retain their handler-specific refusal and consent checks.
        const version = generation;
        active = new AbortController();
        try {
          if (!(await runRegistered(job, jobs, store, now, active.signal))) break;
        } finally {
          active = undefined;
        }
        if (generation !== version) break;
        continue;
      }
      const r = store.resource(job.resourceId);
      if (
        !r ||
        r.deleted ||
        r.contentHash !== job.inputHash ||
        r.kind !== "assignment"
      ) {
        store.finish(job, undefined, now());
        continue;
      }
      const manifest = context(r.id, "jev");
      if (!manifest.allowed) {
        receipt(manifest, "blocked"); // owner: T06: a refused Jev send writes a receipt too.
        store.finish(job, "Data sharing is disabled", now());
        break;
      }
      const version = generation;
      active = new AbortController();
      const timer = setTimeout(() => active?.abort(), 20000);
      try {
        // Log the attempt before crossing the boundary. This does not claim delivery.
        receipt(manifest, "sent");
        const result = judgmentResultSchema.parse(
          await options.gateway!.evaluate(manifest.payload, active.signal),
        );
        if (
          !current(job, version) ||
          !maySend(store.privacy(), "jev", manifest.categories).allowed ||
          active.signal.aborted
        ) {
          store.finish(job, "Discarded after data or privacy changed", now());
          continue;
        }
        store.putJudgment({
          key: `${r.id}:${r.contentHash}:assignment.kind.v1`,
          resourceId: r.id,
          inputHash: r.contentHash,
          model: result.model,
          questionVersion: result.questionVersion,
          result,
          createdAt: now(),
        });
        store.finish(job, undefined, now());
      } catch (error) {
        if (!closed && generation === version) {
          receipt(manifest, "failed");
          if (error instanceof JudgmentBudgetError && !active.signal.aborted) {
            store.defer(job, new Date(Date.parse(now()) + error.retryAfterMs).toISOString(),
              "Judgment budget reached; waiting to retry. Local data is still usable.", now());
            scheduleBudgetWake();
            continue;
          }
          store.finish(
            job,
            "Judgment unavailable; local data is still usable",
            now(),
          );
        }
      } finally {
        clearTimeout(timer);
        active = undefined;
      }
      if (generation !== version) break;
    }
  }
  function wake() {
    if (closed) return;
    if (working) {
      wakePending = true;
      return;
    }
    wakePending = false;
    working = drain()
      .then(extractCourses)
      .finally(() => {
        working = undefined;
        if (wakePending && !closed) wake();
      });
  }
  function interrupt() {
    generation++;
    active?.abort();
    for (const read of planningReads) read.abort();
    for (const call of seamCalls) call.abort(); // owner: T05b
  }
  // owner: T05b. The save → enqueue hook: every save path calls this after store.ingest.
  function saved(sourceId: string) {
    if (closed) return 0;
    const calls = enqueueOnSave(store, jobs, sourceId, now());
    if (calls) wake();
    return calls;
  }
  /** Runs one seam call; its result is discarded if purge or a privacy change landed meanwhile. */
  async function seamCall<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(),
      version = generation;
    seamCalls.add(controller);
    try {
      const result = await run(controller.signal);
      if (closed || version !== generation || controller.signal.aborted)
        throw new Error("Cancelled after data or privacy changed; nothing was kept.");
      return result;
    } finally {
      seamCalls.delete(controller);
    }
  }
  /** D40: code resolves the command bar first; only language goes on to a pack or the router. */
  async function workspace(value: WorkspaceCommand): Promise<WorkspaceResult> {
    const { verb } = value;
    if (verb === "open") {
      const r = value.resourceId ? store.resource(value.resourceId) : undefined;
      if (!r || r.deleted)
        return { verb, status: "unresolved", message: "Choose a source to open." };
      let url: URL | undefined;
      try {
        url = new URL(r.url);
      } catch {}
      if (!url || url.protocol !== "https:" || url.username || url.password)
        return { verb, status: "unresolved", message: "This source has no web link to open." };
      return { verb, status: "ok", url: url.href };
    }
    if (verb === "due") {
      const days = value.days ?? 7,
        start = Date.parse(now()),
        end = start + days * 86_400_000,
        evidence = evidenceFor(store);
      const items = store
        .resources()
        .filter(
          (r) =>
            r.kind === "assignment" &&
            !r.deleted &&
            !r.completed &&
            (!value.courseId || r.courseId === value.courseId) &&
            courseIncluded(store, r),
        )
        .flatMap((r) => {
          const at = resolveDeadline(evidence.deadlines(r)).dueAt;
          const ms = at ? Date.parse(at) : NaN;
          return at && Number.isFinite(ms) && ms >= start && ms <= end
            ? [{ id: r.id, title: r.title, courseName: r.courseName, dueAt: at, url: r.url }]
            : [];
        })
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.title.localeCompare(b.title));
      return { verb, status: "ok", items };
    }
    const courseId = value.courseId;
    if (!courseId) return { verb, status: "unresolved", message: "Choose a course first." };
    if (verb === "quiz") {
      const learning = seams.learning;
      if (!learning) return { verb, status: "not_built", message: "Quizzes aren't built yet." };
      const result = await seamCall((signal) =>
        learning.handle(
          {
            op: "practice.target",
            courseId,
            ...(value.topicIds?.length ? { topicIds: value.topicIds } : {}),
            ...(value.text?.trim() ? { description: value.text.trim() } : {}),
            mode: "test",
            count: 10,
          },
          signal,
        ),
      );
      return {
        verb,
        status:
          result.status === "ok" ? "ok" : result.status === "not_built" ? "not_built" : "unresolved",
        ...(result.message ? { message: result.message } : {}),
      };
    }
    // cards and explain are packs for a scope (the runtime builder's runner).
    const pack = seams.pack;
    if (!pack) return { verb, status: "not_built", message: "This command isn't built yet." };
    await seamCall((signal) =>
      pack(
        verb,
        {
          courseId,
          ...(value.resourceId ? { resourceIds: [value.resourceId] } : {}),
          ...(value.topicIds?.length ? { topicIds: value.topicIds } : {}),
        },
        signal,
      ),
    );
    return { verb, status: "ok" };
  }
  // end owner: T05b
  async function execute(raw: unknown): Promise<CommandResult> {
    if (closed) throw new Error("Workspace is closed.");
    const command = commandSchema.parse(raw);
    let message: string | undefined, manifest: ContextManifest | undefined;
    // owner: T05b
    let seamResult: Partial<Pick<CommandResult, "learning" | "map" | "pack" | "workspace">> = {};
    // end owner: T05b
    switch (command.type) {
      case "snapshot":
        return { snapshot: snapshot(command.search) };
      case "import": {
        store.ingest(command.batch);
        saved(command.batch.source.id); // owner: T05b
        // Same exact-link pass as live ingestion, so imported captures keep their evidence links.
        linkExactEvidence(store);
        wake();
        message = "Capture imported locally.";
        break;
      }
      case "planning-guide": {
        const subjects = store
          .planningRecords()
          .filter((row) => !row.deleted && row.accountScope === "public")
          .filter((row) => row.kind === "subject");
        const subject = subjects.find(
          (row) => row.code === command.subjectCode,
        );
        if (!subject)
          throw new Error(
            "Refresh planning to load the official subject list first.",
          );
        const controller = new AbortController(),
          version = generation;
        planningReads.add(controller);
        try {
          const capture = await pullGuideForSubject(
            publicClient,
            subject,
            subjects,
            now(),
            AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
          );
          if (closed || version !== generation)
            throw new Error("Catalog read cancelled; no data was saved.");
          store.ingestPlanning(capture);
          message = capture.records.length
            ? "Public course descriptions saved. Term offerings and prerequisites need separate verification."
            : "The Guide page could not be parsed; previous records were preserved.";
        } finally {
          planningReads.delete(controller);
        }
        break;
      }
      case "planning-search":
      case "planning-sections": {
        if (!options.planningHttp)
          throw new Error(
            "Term offerings are available through the desktop UW connection.",
          );
        const controller = new AbortController(),
          version = generation;
        planningReads.add(controller);
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(30_000),
        ]);
        try {
          let capture;
          if (command.type === "planning-search") {
            const search = {
              termCode: command.termCode,
              subjectCode: command.subjectCode,
              page: command.page,
              observedAt: now(),
            };
            const response = await options.planningHttp.read(
              buildUwPublicCourseSearchRequest(search),
              signal,
            );
            const result = normalizeUwPublicCourseSearch(
              response.status === "ok" ? response.data : null,
              search,
            );
            capture = result.capture;
            message =
              capture.status === "failed"
                ? "The offering search could not refresh. Saved results remain available and need verification."
                : `${result.courses.length} course descriptions saved from this search page${result.found === null ? "" : ` (${result.found} source results)`}. Sections are loaded separately; search text does not establish eligibility.`;
          } else {
            const record = store
              .planningRecords()
              .find(
                (r) =>
                  !r.deleted &&
                  r.localId === command.recordId &&
                  r.accountScope === "public" &&
                  r.kind === "catalog_course",
              );
            const match = record?.id.match(
              /^course:(1\d{2}[246]):(\d{1,6}):(\d{1,12}(?:\.\d{1,6})?)$/,
            );
            if (!record || record.kind !== "catalog_course" || !match)
              throw new Error(
                "Load a verified term search result before requesting its sections.",
              );
            const course = {
              termCode: match[1]!,
              subjectCode: match[2]!,
              courseId: match[3]!,
              catalogNumber: record.courseKey.split(":")[2]!,
            };
            const response = await options.planningHttp.read(
              buildUwPublicEnrollmentPackagesRequest(course),
              signal,
            );
            capture = normalizeUwPublicEnrollmentPackages(
              response.status === "ok" ? response.data : null,
              { course, observedAt: now() },
            );
            message =
              capture.status === "failed"
                ? "Sections could not refresh. Saved meetings remain available; seat counts and schedule fit need verification."
                : `${capture.records.length} section options saved with ${capture.completeness} coverage. Seat counts describe this observation, not a reservation.`;
          }
          signal.throwIfAborted();
          if (closed || version !== generation)
            throw new Error("Offering read cancelled; no data was saved.");
          store.ingestPlanning(capture);
        } finally {
          planningReads.delete(controller);
        }
        break;
      }
      case "work-set":
        return { snapshot: snapshot(), workSet: buildWorkSet(store, command.id) };
      case "planning-compare":
        return {
          snapshot: snapshot(),
          planningComparison: comparePlanning(
            store,
            command.termCode,
            command.style,
            now(),
          ),
        };
      case "planning-grades": {
        let refresh: { status: string; message: string } | null = null;
        if (command.refresh) {
          if (!options.madgrades) throw new Error("Madgrades refresh is available through the desktop app.");
          const table = planningIdentityTable(store);
          if (!table) refresh = { status: "unverified_crosslist", message: "Saved cross-list mappings disagree. Refresh subject and cross-list evidence before loading grades." };
          else {
            const controller = new AbortController(), version = generation;
            planningReads.add(controller);
            try {
              const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]);
              const result = await pullMadgradesGrades(options.madgrades, { courseKey: command.courseKey, table, observedAt: now() }, signal)
                .catch(() => signal.aborted
                  ? { status: "cancelled" as const, message: "Madgrades read cancelled or timed out; no data was saved.", capture: null }
                  : { status: "error" as const, message: "Madgrades could not be reached. Saved evidence was kept.", capture: null });
              if (closed || version !== generation) throw new Error("Madgrades read cancelled; no data was saved.");
              if (result.capture) store.ingestPlanning(result.capture);
              refresh = { status: result.status, message: result.message };
            } finally { planningReads.delete(controller); }
          }
        }
        return { snapshot: snapshot(), planningGrades: summarizePlanningGrades(store, command.courseKey, now(), refresh), ...(refresh ? { message: refresh.message } : {}) };
      }
      case "madgrades-token":
        throw new Error("Madgrades tokens are stored by the desktop app, not the local workspace.");
      case "planning-import": {
        store.ingestPlanning(command.batch);
        message = "Planning capture saved on this device.";
        break;
      }
      case "fixture": {
        if (store.sources().some((s) => s.kind !== "fixture"))
          throw new Error(
            "Use a separate workspace for sample data. Your real sources are already connected.",
          );
        const moved = rebaseFixture(
          options.fixture,
          options.now?.() ?? new Date(),
          options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        );
        store.ingest({ ...moved, observedAt: now() });
        saved(options.fixture.source.id); // owner: T05b
        linkExactEvidence(store);
        wake();
        message = "Loaded a synthetic sample course.";
        break;
      }
      case "personal-report":
        store.setPersonalReport(command.value);
        break;
      case "complete":
        store.setCompleted(command.id, command.completed);
        break;
      case "ingestion-settings":
        store.setIngestionSettings(command.value);
        break;
      case "course-override":
        interrupt();
        store.setCourseOverride(command.value);
        break;
      case "mcp-grant": {
        // Settings edits cannot erase an existing connection credential accidentally.
        const existing = store
          .mcpGrants()
          .find((g) => g.id === command.value.id);
        store.setMcpGrant({
          ...command.value,
          ...(existing?.tokenHash ? { tokenHash: existing.tokenHash } : {}),
        });
        break;
      }
      case "privacy":
        interrupt();
        store.setPrivacy(command.value);
        wake();
        message =
          "Data settings saved. Revoking access stops future requests; it cannot retract data already sent.";
        break;
      // owner: T06. The only writer of consent records, and the answer to a payload preview.
      case "consent":
        if (command.value.action === "revoke") interrupt();
        message = applyConsent(store, command.value, now());
        wake();
        break;
      case "preview.ack":
        message = egressFor(store).acknowledge(command.value, now());
        wake();
        break;
      // end owner: T06
      case "context":
        manifest = context(command.id, command.recipient);
        break;
      case "enrich": {
        manifest = context(command.id, "jev");
        if (!manifest.allowed) {
          receipt(manifest, "blocked");
          message = manifest.reason;
          break;
        }
        if (!options.gateway) {
          message =
            "Configure the shared judgment gateway before requesting Jev.";
          break;
        }
        const r = store.resource(command.id)!;
        store.enqueue("enrich.resource", r.id, r.contentHash, now());
        wake();
        message = "Judgment queued.";
        break;
      }
      case "identity-roster":
        store.setIdentityRoster(command.value);
        message = "Names to remove saved on this device. Future hosted requests use them; earlier requests are unchanged.";
        break;
      case "validate-citations":
        return { snapshot: snapshot(), citations: validateCitations(store, command.claims) };
      case "link":
        store.decideLink(command.id, command.status);
        break;
      case "day-plan": {
        // A self-report cannot stand in for a Canvas submission.
        if (command.entry.block.type === "work" && command.entry.doneAt)
          throw new Error(
            "Assignment blocks are completed by a Canvas submission, not marked done here.",
          );
        store.setDayPlanEntry(command.entry);
        break;
      }
      case "day-plan-remove":
        store.removeDayPlanEntry(command.key, command.date);
        break;
      case "outlook-disconnect": {
        // Only the student's Outlook calendar; coursework and other feeds are never touched here.
        for (const s of store.sources())
          if (s.kind === "calendar" && s.courseId === OUTLOOK_CALENDAR_COURSE_ID)
            store.removeSource(s.id);
        message = "Outlook calendar disconnected; its meetings were removed from this device.";
        break;
      }
      case "purge":
        clearOutgoingProjections(store);
        interrupt();
        store.purge();
        semanticAttempts.clear();
        message =
          "Local workspace data deleted. Browser sign-in sessions are separate; remove them in Sources.";
        break;
      // owner: T05b. The seams. Each case routes to its lane's handler; absent means "not built".
      case "map":
        if (!seams.map) message = "The course map isn't built yet.";
        else seamResult = { map: seams.map(command.courseId, command.accountScope) };
        break;
      case "correct":
        message = seams.correct
          ? seams.correct(command.value, now())
          : "Corrections aren't built yet; nothing was changed.";
        break;
      case "pack": {
        const pack = seams.pack;
        if (!pack) message = "This pack isn't built yet.";
        else
          seamResult = {
            pack: await seamCall((signal) => pack(command.pack, command.scope, signal)),
          };
        break;
      }
      case "ui_event":
        seams.uiEvent?.(command.value, now());
        break;
      case "workspace":
        seamResult = { workspace: await workspace(command.value) };
        break;
      case "learning": {
        const learning = seams.learning;
        seamResult = {
          learning: learning
            ? await seamCall((signal) => learning.handle(command.request, signal))
            : {
                op: command.request.op,
                status: "not_built",
                message: "This study feature isn't built yet.",
              },
        };
        break;
      }
      default: {
        // An unknown Command is a type error here (T05b).
        const unhandled: never = command;
        throw new Error(
          `Unsupported command: ${String((unhandled as { type?: unknown }).type)}`,
        );
      }
      // end owner: T05b
    }
    return {
      snapshot: snapshot(),
      ...(manifest ? { manifest } : {}),
      ...(message ? { message } : {}),
      ...seamResult, // owner: T05b
    };
  }
  return {
    execute,
    snapshot,
    context,
    wake,
    saved, // owner: T05b
    jobs, // owner: T05b
    // owner: T15. A scoped query: reads only, never a command, never the whole workspace.
    query(request: QueryRequest) {
      if (closed) throw new Error("Workspace is closed.");
      return runQuery(store, request, {
        now,
        gatewayConfigured: !!options.gateway,
      });
    },
    async settled() {
      while (working) await working;
    },
    async close() {
      closed = true;
      clearTimeout(budgetTimer);
      interrupt();
      await working;
      store.close();
    },
  };
}
