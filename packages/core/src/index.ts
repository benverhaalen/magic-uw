import { randomUUID } from "node:crypto";
import {
  commandSchema,
  type Store,
  type ContextManifest,
  type CommandResult,
  type Snapshot,
  type CaptureBatch,
  type Resource,
  type Job,
} from "@magic/contracts";
import { maySend, resolveDeadline } from "@magic/domain";
import { judgmentResultSchema, type JudgmentGateway } from "@magic/ai";
import { contentCategories, courseIncluded } from "./access";
import { evidenceFor } from "./evidence";
import { pullGuideForSubject } from "../../connectors/src/planning-public";
import { createPublicClient, type PublicClient } from "../../connectors/src/network";
import { comparePlanning } from "./planning";
import { reconcileAcademicRecords } from "./academic-reconciliation";
import type { UwPlanningHttp } from "../../connectors/src/uw-planning-http";
import { buildUwPublicCourseSearchRequest, normalizeUwPublicCourseSearch, buildUwPublicEnrollmentPackagesRequest, normalizeUwPublicEnrollmentPackages } from "../../connectors/src/uw-planning-catalog";
export interface CoreOptions {
  fixture: CaptureBatch;
  gateway?: JudgmentGateway;
  now?: () => Date;
  planningPublicClient?: PublicClient;
  planningHttp?: Pick<UwPlanningHttp, "read">;
}
export function createCore(store: Store, options: CoreOptions) {
  const planningReads = new Set<AbortController>();
  const publicClient = options.planningPublicClient ?? createPublicClient();
  const now = () => (options.now?.() ?? new Date()).toISOString();
  let generation = 0,
    active: AbortController | undefined,
    working: Promise<void> | undefined,
    closed = false;
  function snapshot(search?: string): Snapshot {
    const evidence = evidenceFor(store);
    const judgments = store.judgments();
    const resources = store
      .resources(search)
      .map((r) => {
        const judgment = judgments.find(
          (j) =>
            j.resourceId === r.id &&
            j.inputHash === r.contentHash &&
            j.questionVersion === "assignment.kind.v1",
        );
        const parsed = judgmentResultSchema.safeParse(judgment?.result);
        // Provisional display threshold; never presented as calibrated correctness.
        const label =
          parsed.success &&
          parsed.data.kind !== "other" &&
          (parsed.data.probabilities[parsed.data.kind] ?? 0) >= 0.9
            ? parsed.data.kind.replaceAll("_", " ")
            : null;
        return {
          ...r,
          deadline: resolveDeadline(evidence.deadlines(r)),
          kindLabel: label,
        };
      })
      .sort(
        (a, b) =>
          Number(a.completed) - Number(b.completed) ||
          (a.deadline.planningAt ?? "9999").localeCompare(
            b.deadline.planningAt ?? "9999",
          ) ||
          a.title.localeCompare(b.title),
      );
    const sources = store.sources();
    return {
      planning: { records: store.planningRecords(), sources: store.planningSources(), reconciliation: reconcileAcademicRecords(store, now()) },
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
    const payload = {
      course: r.courseName.slice(0, 200),
      title: r.title.slice(0, 500),
      text: [r.text, ...supporting.map((s) => `${s.title}\n${s.text}`)]
        .join("\n\n")
        .slice(0, 12000),
      policy: r.policy.evidence.slice(0, 4000),
    };
    const categories = [
      ...new Set([r, ...supporting].flatMap(contentCategories)),
    ];
    const permission = maySend(store.privacy(), recipient, categories);
    if (!courseIncluded(store, r)) {
      permission.allowed = false;
      permission.reason =
        "This course is excluded. Include it in Sources before sharing its data.";
    }
    return {
      recipient,
      purpose: "Classify assignment kind",
      categories,
      resourceIds: [id, ...supporting.map((s) => s.id)],
      characters: JSON.stringify(payload).length,
      ...permission,
      payload,
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
  async function drain() {
    if (
      closed ||
      !options.gateway ||
      !maySend(store.privacy(), "jev", ["course_text"]).allowed
    )
      return;
    let job: Job | undefined;
    while (!closed && (job = store.lease(now(), 60000))) {
      if (job.kind !== "enrich.resource") {
        store.finish(job, "Unsupported job kind", now());
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
          await options.gateway.evaluate(manifest.payload, active.signal),
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
      } catch {
        if (!closed && generation === version) {
          receipt(manifest, "failed");
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
    if (closed || working) return;
    working = drain().finally(() => {
      working = undefined;
    });
  }
  function interrupt() {
    generation++;
    active?.abort();
    for (const read of planningReads) read.abort();
  }
  async function execute(raw: unknown): Promise<CommandResult> {
    if (closed) throw new Error("Workspace is closed.");
    const command = commandSchema.parse(raw);
    let message: string | undefined, manifest: ContextManifest | undefined;
    switch (command.type) {
      case "snapshot":
        return { snapshot: snapshot(command.search) };
      case "import": {
        store.ingest(command.batch);
        wake();
        message = "Capture imported locally.";
        break;
      }
      case "planning-guide": {
        const subjects = store.planningRecords().filter((row) => !row.deleted && row.accountScope === "public").filter((row) => row.kind === "subject");
        const subject = subjects.find((row) => row.code === command.subjectCode);
        if (!subject) throw new Error("Refresh planning to load the official subject list first.");
        const controller = new AbortController(), version = generation;
        planningReads.add(controller);
        try {
          const capture = await pullGuideForSubject(publicClient, subject, subjects, now(), AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]));
          if (closed || version !== generation) throw new Error("Catalog read cancelled; no data was saved.");
          store.ingestPlanning(capture);
          message = capture.records.length ? "Public course descriptions saved. Term offerings and prerequisites need separate verification." : "The Guide page could not be parsed; previous records were preserved.";
        } finally { planningReads.delete(controller); }
        break;
      }
      case "planning-search":
      case "planning-sections": {
        if (!options.planningHttp) throw new Error("Term offerings are available through the desktop UW connection.");
        const controller = new AbortController(), version = generation;
        planningReads.add(controller);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
        try {
          let capture;
          if (command.type === "planning-search") {
            const search = { termCode: command.termCode, subjectCode: command.subjectCode, page: command.page, observedAt: now() };
            const response = await options.planningHttp.read(buildUwPublicCourseSearchRequest(search), signal);
            const result = normalizeUwPublicCourseSearch(response.status === "ok" ? response.data : null, search);
            capture = result.capture;
            message = capture.status === "failed" ? "The offering search could not refresh. Saved results remain available and need verification." : `${result.courses.length} course descriptions saved from this search page${result.found === null ? "" : ` (${result.found} source results)`}. Sections are loaded separately; search text does not establish eligibility.`;
          } else {
            const record = store.planningRecords().find(r => !r.deleted && r.localId === command.recordId && r.accountScope === "public" && r.kind === "catalog_course");
            const match = record?.id.match(/^course:(1\d{2}[246]):(\d{1,6}):(\d{1,12}(?:\.\d{1,6})?)$/);
            if (!record || record.kind !== "catalog_course" || !match) throw new Error("Load a verified term search result before requesting its sections.");
            const course = { termCode: match[1]!, subjectCode: match[2]!, courseId: match[3]!, catalogNumber: record.courseKey.split(":")[2]! };
            const response = await options.planningHttp.read(buildUwPublicEnrollmentPackagesRequest(course), signal);
            capture = normalizeUwPublicEnrollmentPackages(response.status === "ok" ? response.data : null, { course, observedAt: now() });
            message = capture.status === "failed" ? "Sections could not refresh. Saved meetings remain available; seat counts and schedule fit need verification." : `${capture.records.length} section options saved with ${capture.completeness} coverage. Seat counts describe this observation, not a reservation.`;
          }
          signal.throwIfAborted();
          if (closed || version !== generation) throw new Error("Offering read cancelled; no data was saved.");
          store.ingestPlanning(capture);
        } finally { planningReads.delete(controller); }
        break;
      }
      case "planning-compare":
        return { snapshot: snapshot(), planningComparison: comparePlanning(store, command.termCode, command.style, now()) };
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
        store.ingest({ ...options.fixture, observedAt: now() });
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
      case "link":
        store.decideLink(command.id, command.status);
        break;
      case "purge":
        interrupt();
        store.purge();
        message =
          "Local workspace data deleted. Browser sign-in sessions are separate; remove them in Sources.";
        break;
    }
    return {
      snapshot: snapshot(),
      ...(manifest ? { manifest } : {}),
      ...(message ? { message } : {}),
    };
  }
  return {
    execute,
    snapshot,
    context,
    wake,
    async settled() {
      await working;
    },
    async close() {
      closed = true;
      interrupt();
      await working;
      store.close();
    },
  };
}
