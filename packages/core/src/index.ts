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
} from "@magic/contracts";
import { maySend, resolveDeadline } from "@magic/domain";
import type { JudgmentGateway } from "@magic/ai";
import { contentCategories, courseIncluded, courseInclusion } from "./access";
import { evidenceFor } from "./evidence";
import { readOnce } from "./graph/read-once";
import { rebaseFixture } from "./fixture-dates";
export { rebaseFixture } from "./fixture-dates";
import { clearOutgoingProjections } from "./identity";
// owner: privacy: the protection pass on the context manifest, its projection and citations.
import { classOf, type ContentClass, clearProtectedProjections, protectedPayloadScrubber, protectedProjection, protectionCounts, validateProtectedCitations } from "./privacy/protect";
export { scrubText, rosterFor, toOriginalSpan } from "./identity";
// owner: privacy: resolves protected projections and delegates every other claim to identity.ts.
export { validateProtectedCitations as validateCitations } from "./privacy/protect";
import { pullGuideForSubject } from "../../connectors/src/planning-public";
import { gitlabProjectFromUrl } from "../../connectors/src/gitlab";
import {
  createPublicClient,
  type PublicClient,
} from "../../connectors/src/network";
import { madgradesUpToDate, planningIdentityTable, summarizePlanningGrades } from "./planning-grades"; // owner: planning-perf: madgradesUpToDate
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
// owner: drain. The job registry and the app's one drain (the pipeline loop); Jev's kind is a handler.
import { createJobRegistry, enqueueOnSave, type JobRegistry } from "./jobs/registry";
import { createPipelineLoop, type PipelineTiming } from "./jobs/pipeline";
import { createEnrichJob, judgedHash } from "./jobs/enrich";
// end owner: drain
import { codeAssignmentKind, resourceViews, runQuery, withReads } from "./queries"; // owner: T15
import { createNotifications } from "./notifications";
/** The Jev kind question reads the title, about 2,000 characters, and the item's own stated policy, clipped. */
const JEV_TEXT_CHARS = 2000;
const JEV_POLICY_CHARS = 500;
import type { QueryRequest, QueryResult, ResourceChange } from "@magic/contracts"; // owner: platform-fix (QueryResult, ResourceChange)
import type { NotesRequest, NotesResult } from "@magic/contracts"; // owner: notes
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
  // owner: intent. The command bar's intent router (packages/core/src/intent). Core hands it
  // its own workspace verbs and seams; the router adds no new path to data or the network.
  intent?: {
    handle(command: IntentCommand, host: IntentHost, signal: AbortSignal): Promise<IntentCommandResult>;
    /** The live hint (the `intent.preview` query): the code resolver only, never the model. */
    preview?(text: string, courseId?: string): IntentCommandResult;
  };
  // end owner: intent
  // owner: notes. Session notes (packages/notes): scaffolds, edits, fill and two-way sync.
  notes?: {
    handle(request: NotesRequest, signal: AbortSignal): Promise<NotesResult>;
  };
  // end owner: notes
}
export type { JobRegistry } from "./jobs/registry";
// end owner: T05b
// owner: intent
import type { IntentCommand, IntentCommandResult } from "@magic/contracts";
import type { IntentHost } from "./intent/types";
// end owner: intent
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
  /** Extra job kinds for the drain (the worker passes the pipeline registry); core adds `enrich.resource`. */
  jobs?: JobRegistry;
  seams?: CoreSeams;
  // end owner: T05b
  /** owner: drain. The drain's idle gap and slice sizes (defaults in `jobs/pipeline.ts`). */
  drain?: PipelineTiming;
}
export function createCore(store: Store, options: CoreOptions) {
  const planningReads = new Set<AbortController>();
  // owner: T05b. Seam calls (learning, packs) are cancelled by purge and privacy like planning reads.
  const seamCalls = new Set<AbortController>();
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
  const notifications = createNotifications(store, {
    now,
    timeZone:
      options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    gateway: options.gateway,
    generation: () => generation,
    closed: () => closed,
  });
  // owner: drain. One drain for every job kind. The caller's kinds plus Jev's, which keeps its
  // egress checks through core's manifest and receipts; purge, privacy changes and close cancel it.
  let cancel = new AbortController();
  const jobs = createJobRegistry([
    ...(options.jobs ? options.jobs.kinds().map((kind) => options.jobs!.get(kind)!) : []),
    createEnrichJob({
      gateway: options.gateway,
      context: (id) => context(id, "jev"),
      receipt,
      scope() {
        const version = generation;
        return { signal: cancel.signal, live: () => !closed && generation === version };
      },
    }),
  ]);
  const pipeline = createPipelineLoop({
    ...options.drain,
    store: store as Store & Pick<CourseCoreStore, "lease">,
    registry: jobs,
    now,
  });
  // end owner: drain
  function profileFor(r: Resource, sources = store.sources()): CourseIntelligence | undefined {
    const source = sources.find((s) => s.id === r.sourceId);
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
    // Unsearched, the list is every resource: the views' evidence reuses it (one full read).
    const listed = store.resources(search);
    // One sources, links and jobs read each, shared by the views, the evidence and the fields below.
    const sources = store.sources();
    const links = store.links();
    const jobs = store.jobs();
    const resources = resourceViews(withReads(store, { sources, links }), listed, search?.trim() ? undefined : listed);
    // owner: course-facts. A course waiting on a queued or running `course.facts` job is pending.
    const factsQueued = new Set(
      jobs
        .filter((j) => j.kind === "course.facts" && (j.status === "pending" || j.status === "running"))
        .map((j) => (j as { subjectId?: string }).subjectId ?? ""),
    );
    // end owner: course-facts
    return {
      // One sources read for every profile (it was read again per profile).
      courseIntelligence: store.courseIntelligence().map((p) => ({
        ...intelligenceView(p, sources, now()),
        semantic: semanticAttempts.get(
          `${p.id}:${p.inputHash}:${options.courseExtractor?.version ?? "v1"}`,
        ) ?? {
          status: p.extraction
            ? (p.extraction.coverage?.status ?? "complete")
            : options.courseExtractor || factsQueued.has(`${p.accountScope}:${p.courseId}`) // owner: course-facts
              ? "pending"
              : "unavailable",
        },
      })),
      planning: {
        records: store.planningRecords(),
        sources: store.planningSources(),
        reconciliation: reconcileAcademicRecords(store, now()),
        unreadable: store.planningUnreadable?.() ?? 0, // owner: privacy
      },
      resources,
      sources,
      privacy: store.privacy(),
      links,
      jobs,
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
      // Unsearched snapshots already hold every live view; the feed reuses them.
      notifications: notifications.feed(search ? undefined : resources),
      gitlabLinks: store.gitlabLinks(),
    };
  }
  function context(
    id: string,
    recipient: ContextManifest["recipient"],
  ): ContextManifest {
    const r = store.resource(id);
    if (!r || r.deleted) throw new Error("This item is no longer available.");
    // One call's reads: every resource once (evidence and inclusion share it), privacy and sources once.
    const all = store.resources();
    const sources = store.sources();
    const view = withReads(readOnce(store, all), { sources });
    const included = courseInclusion(view, all);
    const privacy = store.privacy();
    // An explicit allowlist: no source URLs, cookies, credentials, account IDs, grades, or student drafts.
    const supporting =
      recipient === "jev"
        ? []
        : evidenceFor(view)
            .supporting(r)
            .filter(
              (s) =>
                included(s) &&
                contentCategories(s).every(
                  (c) => maySend(privacy, recipient, [c]).allowed,
                ),
            );
    const profile = recipient === "jev" ? undefined : profileFor(r, sources);
    const effectivePolicy = effectiveCoursePolicy(profile, r);
    if (
      profile &&
      intelligenceView(profile, sources, now()).freshness !==
        "current_capture" &&
      effectivePolicy.mode === "allowed"
    )
      effectivePolicy.mode = "coaching";
    const policyResources = effectivePolicy.resourceIds
      .map((id) => store.resource(id))
      .filter((s): s is Resource => !!s && !s.deleted);
    const policyAllowed = policyResources.every(
      (s) =>
        included(s) &&
        contentCategories(s).every(
          (c) => maySend(privacy, recipient, [c]).allowed,
        ),
    );
    // Hosted recipients get identity-scrubbed free text; this payload is both
    // the preview and the exact outgoing body. Each field is scrubbed on its own
    // so citations can be re-validated per source field.
    // The scrubber's roster reads the call's list too (it only reads).
    const scrub = protectedPayloadScrubber(view, recipient !== "local", sources.find((s) => s.id === r.sourceId)?.accountScope, `context:${recipient}:${r.courseId}`); // owner: privacy
    // owner: privacy: teaching material keeps its content; messages, mail and notes get every detector.
    const cls = classOf(r);
    scrub.prime([[r.courseName, "teaching"], [r.title, cls], [r.text, cls], ...supporting.flatMap((s): [string, ContentClass][] => [[s.title, classOf(s)], [s.text, classOf(s)]])], r.courseId);
    const rootText = scrub.field(r.text, r.courseId, cls);
    const payload = {
      course: scrub.field(r.courseName, r.courseId, "teaching").slice(0, 200),
      title: scrub.field(r.title, r.courseId, cls).slice(0, 500),
      text: [
        rootText,
        ...supporting.map((s) => `${scrub.field(s.title, s.courseId, classOf(s))}\n${scrub.field(s.text, s.courseId, classOf(s))}`),
      ]
        .join("\n\n")
        .slice(0, recipient === "jev" ? JEV_TEXT_CHARS : 12000),
      // Jev gets the policy only when the item states one; otherwise it adds nothing to the kind question.
      policy: recipient === "jev" && r.policy.mode === "unknown" ? "" : scrub.field((policyAllowed
        ? effectivePolicy.evidence
        : "Policy evidence is withheld by data-sharing settings; use coaching only."
      ), r.courseId, "teaching").slice(0, recipient === "jev" ? JEV_POLICY_CHARS : 4000),
    };
    const redaction = scrub.summary(r.courseId);
    const categories = [
      ...new Set(
        [r, ...supporting, ...(policyAllowed ? policyResources : [])].flatMap(
          contentCategories,
        ),
      ),
    ];
    const permission = maySend(privacy, recipient, categories);
    if (!included(r)) {
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
      ...(recipient !== "local" ? { citationProjections: [{ resourceId: r.id, contentHash: r.contentHash, field: "text" as const, projectionId: protectedProjection(store, r, "text", { start: 0, end: Math.min(payload.text.length, rootText.length) }, scrub).id }] } : {}),
      ...(redaction ? { redaction } : {}),
      ...(recipient !== "local" ? { protection: protectionCounts(payload) } : {}), // owner: privacy
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
      ...(manifest.protection ? { protection: manifest.protection } : {}), // owner: privacy
    });
  }
  async function extractCourses() {
    if (!options.courseExtractor || closed) return;
    for (const profile of store.courseIntelligence()) {
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
      const resources = profile.dependencies
        .map((d) => store.resource(d.resourceId))
        .filter(
          (r): r is Resource =>
            !!r &&
            !r.deleted &&
            courseIncluded(store, r) &&
            !r.gitlab &&
            (r.externalId === "syllabus" || r.kind === "assignment"),
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
  function wake() {
    if (closed) return;
    pipeline.wake(); // owner: drain: jobs run in the pipeline's idle slices, never inline here
    if (working) {
      wakePending = true;
      return;
    }
    wakePending = false;
    // Course messages and mail have their own category gate (communications); see notifications.ts.
    working = (options.gateway ? notifications.triage() : Promise.resolve())
      .then(extractCourses)
      .finally(() => {
        working = undefined;
        if (wakePending && !closed) wake();
      });
  }
  function interrupt() {
    generation++;
    active?.abort();
    notifications.abort();
    // owner: drain: cancel in-flight job sends and stop the running slice between jobs.
    cancel.abort();
    cancel = new AbortController();
    pipeline.interrupt();
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
        evidence = evidenceFor(store),
        // One inclusion map for the whole list (it reads every resource); per item it was O(n²).
        included = courseInclusion(store);
      const items = store
        .resources()
        .filter(
          (r) =>
            r.kind === "assignment" &&
            !r.deleted &&
            !r.completed &&
            (!value.courseId || r.courseId === value.courseId) &&
            included(r),
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
    let seamResult: Partial<Pick<CommandResult, "learning" | "map" | "pack" | "workspace" | "command" | "notes">> = {};
    // end owner: T05b
    switch (command.type) {
      case "snapshot":
        return { snapshot: snapshot(command.search) };
      case "import": {
        store.bumpGeneration?.(); // fix/sync-events: the workspace was replaced, not refreshed
        store.ingest(command.batch);
        saved(command.batch.source.id); // owner: T05b
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
          // owner: planning-perf: the latest past term is already saved; no request is made.
          if (madgradesUpToDate(store, command.courseKey)) refresh = { status: "saved", message: "Saved Madgrades evidence already covers the latest past term. Averages are not predictions." };
          else if (!table) refresh = { status: "unverified_crosslist", message: "Saved cross-list mappings disagree. Refresh subject and cross-list evidence before loading grades." };
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
        store.bumpGeneration?.(); // fix/sync-events
        store.ingest({ ...moved, observedAt: now() });
        saved(options.fixture.source.id); // owner: T05b
        wake();
        message = "Loaded a synthetic sample course.";
        break;
      }
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
        if (codeAssignmentKind(r)) {
          message = "Canvas names this assignment's kind exactly; no judgment is needed.";
          break;
        }
        store.enqueue("enrich.resource", r.id, judgedHash(r), now());
        wake();
        message = "Judgment queued.";
        break;
      }
      case "identity-roster":
        store.setIdentityRoster(command.value);
        message = "Names to remove saved on this device. Future hosted requests use them; earlier requests are unchanged.";
        break;
      case "validate-citations":
        return { snapshot: snapshot(), citations: validateProtectedCitations(store, command.claims) }; // owner: privacy
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
      case "notifications-read":
        notifications.read(command.ids);
        break;
      case "notification-dismiss":
        notifications.dismiss(command.id);
        break;
      case "gitlab-link": {
        const projectPath = gitlabProjectFromUrl(command.url.trim());
        if (!projectPath)
          throw new Error(
            "That isn't a UW GitLab project link. Copy the project's address from git.doit.wisc.edu, for example https://git.doit.wisc.edu/group/project.",
          );
        const accounts = new Map(store.sources().map((s) => [s.id, s.accountScope]));
        const known = store
          .resources()
          .some((r) => !r.deleted && r.courseId === command.courseId && accounts.get(r.sourceId) === command.accountScope);
        if (!known) throw new Error("That course isn't in your saved coursework, so a GitLab project can't be linked to it.");
        store.setGitlabLink({ accountScope: command.accountScope, courseId: command.courseId, projectPath, addedAt: now() });
        message = `GitLab project linked: ${projectPath}. It is read on the next refresh.`;
        break;
      }
      case "gitlab-unlink":
        store.removeGitlabLink(command.accountScope, command.courseId, command.projectPath);
        message = "GitLab project unlinked. Work already saved from it stays until the next refresh.";
        break;
      case "outlook-disconnect": {
        // Only the student's Outlook calendar; coursework and other feeds are never touched here.
        // owner: T30: the published-ICS link only; the Microsoft (Graph) calendar has its own disconnect.
        for (const s of store.sources())
          if (
            s.kind === "calendar" &&
            s.courseId === OUTLOOK_CALENDAR_COURSE_ID &&
            !s.scope.startsWith("graph_")
          )
            store.removeSource(s.id);
        message = "Outlook calendar disconnected; its meetings were removed from this device.";
        break;
      }
      // owner: T30. Every record read through Microsoft Graph: mail, calendar, OneNote, OneDrive.
      // Main deletes the tokens and delta links; coursework, planning and audit data are untouched.
      case "outlook-disconnect-graph": {
        for (const s of store.sources())
          if (s.scope.startsWith("graph_")) store.removeSource(s.id);
        message = "Outlook disconnected; its mail, calendar and notes were removed from this device.";
        break;
      }
      case "purge":
        clearOutgoingProjections(store);
        clearProtectedProjections(store); // owner: privacy
        interrupt();
        store.purge();
        semanticAttempts.clear();
        // owner: platform-fix. The desktop host also clears both sign-in sessions and their caches,
        // the saved keys and the course bank connections (main.ts, purge-host.ts).
        message =
          "Local data deleted from this device: coursework, sign-ins and their caches, saved keys and course bank connections.";
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
      // owner: intent. The command bar: code resolves first; only language goes on to the model.
      case "command": {
        const intent = seams.intent;
        if (!intent) {
          seamResult = { command: { status: "unavailable", reason: "The command bar isn't built yet.", path: "none", latencyMs: 0, tokens: { in: 0, cached: 0, out: 0 } } };
          break;
        }
        const host: IntentHost = {
          workspace,
          learning: seams.learning,
          pack: seams.pack,
          query: (request) => runQuery(store, request, { now, gatewayConfigured: !!options.gateway }),
        };
        const mode = command.value.mode ?? "run";
        seamResult = {
          command: mode === "run" ? await seamCall((signal) => intent.handle(command.value, host, signal)) : await intent.handle(command.value, host, new AbortController().signal),
        };
        break;
      }
      // end owner: intent
      // owner: notes
      case "notes": {
        const notes = seams.notes;
        seamResult = {
          notes: notes
            ? await seamCall((signal) => notes.handle(command.request, signal))
            : { op: command.request.op, status: "not_built", message: "Notes aren't built yet." },
        };
        break;
      }
      // end owner: notes
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
    pipeline, // owner: drain: the worker feeds it sync, presence and suspend signals
    // owner: T15. A scoped query: reads only, never a command, never the whole workspace.
    query(request: QueryRequest): QueryResult {
      if (closed) throw new Error("Workspace is closed.");
      // owner: intent. The command bar's live hint: code resolver only, 0 tokens, no snapshot.
      if (request.view === "intent.preview" && seams.intent?.preview)
        return { view: "intent.preview", preview: seams.intent.preview(request.text, request.courseId) };
      // end owner: intent
      // owner: platform-fix. The seq change cursor (T10's monotonic resource_changes.seq): a
      // "changes" query with a seq cursor pages forward exactly, however much changed.
      const feed = changeFeed(store);
      if (feed && request.view === "changes") {
        const after = decodeSeqCursor(request.cursor);
        if (after !== undefined) return feed.page(after, request.limit ?? 100, request.courseId);
      }
      const result = runQuery(store, request, {
        now,
        gatewayConfigured: !!options.gateway,
      });
      // A caught-up time-cursor page hands over to a seq cursor from here on.
      if (feed && result.view === "changes" && result.complete)
        return { ...result, cursor: encodeSeqCursor(feed.latest()) };
      return result;
      // end owner: platform-fix
    },
    /** Tests and evals: wait for course extraction, then drain every due job (ignores the idle gap). */
    async settled() {
      while (working) await working;
      if (!closed) await pipeline.runToIdle(); // owner: drain
    },
    async close() {
      closed = true;
      interrupt();
      await pipeline.stop(); // owner: drain
      await working;
      store.close();
    },
  };
}

// owner: platform-fix. The seq change cursor behind core.query({ view: "changes" }).
const encodeSeqCursor = (seq: number) => Buffer.from(JSON.stringify({ s: seq })).toString("base64url");
function decodeSeqCursor(cursor: string | undefined): number | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString()) as Record<string, unknown>;
    if (Object.keys(value).length === 1 && Number.isSafeInteger(value.s) && (value.s as number) >= 0)
      return value.s as number;
  } catch {}
  return undefined; // not a seq cursor: the time cursor path decides (and rejects garbage)
}
/**
 * Changes after a seq, oldest first. `complete: false` means another page follows: call again with
 * the returned cursor. A course filter skips other courses' changes but still advances the cursor.
 */
function changeFeed(store: Store) {
  const after = (store as Store & Partial<Pick<CourseCoreStore, "changesAfter">>).changesAfter?.bind(store);
  if (!after) return undefined;
  const exists = (seq: number) => after(seq, 1).length > 0;
  return {
    /** The newest seq: a galloping then binary search over the seq index (O(log n) point reads). */
    latest(): number {
      if (!exists(0)) return 0;
      let low = 0,
        high = 1;
      while (exists(high)) [low, high] = [high, high * 2];
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (exists(mid)) low = mid;
        else high = mid;
      }
      return high;
    },
    page(from: number, limit: number, courseId?: string): QueryResult {
      // The cursor's own change is gone (a purge restarted the sequence, or its source was
      // removed): the view reloads and follows a fresh cursor, as with an overflowing time cursor.
      if (from > 0 && !exists(from - 1))
        return { view: "changes", changes: [], cursor: encodeSeqCursor(this.latest()), complete: false };
      const changes: ResourceChange[] = [];
      let cursor = from,
        more = false;
      for (;;) {
        const rows = after(cursor, 500);
        for (const { seq, ...change } of rows) {
          if (courseId && change.courseId !== courseId) {
            cursor = seq;
            continue;
          }
          if (changes.length === limit) {
            more = true;
            break;
          }
          changes.push(change);
          cursor = seq;
        }
        if (more || rows.length < 500) break;
      }
      return { view: "changes", changes, cursor: encodeSeqCursor(cursor), complete: !more };
    },
  };
}
// end owner: platform-fix
