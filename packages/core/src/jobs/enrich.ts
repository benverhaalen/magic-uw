/**
 * `enrich.resource`: Jev's assignment-kind judgment (`assignment.kind.v1`) as a registered job.
 * Storage queues it for every saved item; code answers the unambiguous kinds and reuses a cached
 * judgment for the same title and text, so only the rest cross the boundary. Every send keeps
 * its egress rules:
 *
 * - leased only while a gateway is configured and privacy lets Jev read course text (`available`);
 * - the payload is core's `context(id, "jev")` manifest; a refusal writes a `blocked` receipt and
 *   stops the drain for this wake; each attempt writes `sent`, and a failure `failed`;
 * - a budget refusal (429) becomes the drain's retry-after: the job and the kind wait for it;
 * - a purge, privacy change or close (core's cancellation scope) aborts the call and discards the
 *   result. A sync or the student's return only stops the drain between jobs, not mid-call.
 */
import type { ContextManifest, Job, Resource } from "@magic/contracts";
import { maySend } from "@magic/domain";
import { JudgmentBudgetError, judgmentResultSchema, type JudgmentGateway } from "@magic/ai";
import { textHash } from "../../../retrieval/src/index";
import { codeAssignmentKind } from "../queries";
import type { JobHandler } from "./registry";

export const ENRICH_JOB_KIND = "enrich.resource";
/** Judgments are keyed on the title-and-text hash, so a grade or submission change reuses them (O5). */
export const judgedHash = (r: Resource) => textHash(r.title, r.text);
const JEV_TIMEOUT_MS = 20_000;

export interface EnrichDeps {
  gateway: JudgmentGateway | undefined;
  /** Core's outgoing manifest for one item: the exact payload, categories and permission. */
  context(resourceId: string): ContextManifest;
  receipt(manifest: ContextManifest, status: "blocked" | "sent" | "failed"): void;
  /** Core's cancellation scope: aborted, and no longer live, after a purge, privacy change or close. */
  scope(): { signal: AbortSignal; live(): boolean };
}

export function createEnrichJob(deps: EnrichDeps): JobHandler {
  return {
    kind: ENRICH_JOB_KIND,
    subject: "resource",
    owner: "core",
    ready: true,
    // No onSave: storage's ingest queues this kind itself, and the `enrich` command re-queues one.
    available: ({ store }) => !!deps.gateway && maySend(store.privacy(), "jev", ["course_text"]).allowed,
    async run(job, { store, now }) {
      const r = store.resource(job.resourceId);
      if (
        !r ||
        r.deleted ||
        (r.contentHash !== job.inputHash && judgedHash(r) !== job.inputHash) ||
        r.kind !== "assignment" ||
        // Code decides the unambiguous kinds from Canvas submission types; no Jev call.
        codeAssignmentKind(r) ||
        // A judgment for the same title and text is reused: a grade or submission change spends 0 budget.
        store.judgment(`${r.id}:${judgedHash(r)}:assignment.kind.v1`)
      )
        return { status: "done" };
      const gateway = deps.gateway;
      if (!gateway) return { status: "stop", error: "Configure the shared judgment gateway before requesting Jev." };
      const manifest = deps.context(r.id);
      if (!manifest.allowed) {
        deps.receipt(manifest, "blocked"); // owner: T06: a refused Jev send writes a receipt too.
        return { status: "stop", error: "Data sharing is disabled" };
      }
      const scope = deps.scope();
      const call = new AbortController();
      const abort = () => call.abort();
      scope.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, JEV_TIMEOUT_MS);
      const live = scope.live;
      try {
        // Log the attempt before crossing the boundary. This does not claim delivery.
        deps.receipt(manifest, "sent");
        const result = judgmentResultSchema.parse(await gateway.evaluate(manifest.payload, call.signal));
        if (
          !live() ||
          !current(job, r) ||
          !maySend(store.privacy(), "jev", manifest.categories).allowed ||
          call.signal.aborted
        )
          return { status: "retry", error: "Discarded after data or privacy changed" };
        store.putJudgment({
          key: `${r.id}:${judgedHash(r)}:assignment.kind.v1`,
          resourceId: r.id,
          inputHash: judgedHash(r),
          model: result.model,
          questionVersion: result.questionVersion,
          result,
          createdAt: now(),
        });
        return { status: "done" };
      } catch (error) {
        if (!live()) return { status: "retry", error: "Discarded after data or privacy changed" };
        deps.receipt(manifest, "failed");
        if (error instanceof JudgmentBudgetError && !call.signal.aborted)
          return {
            status: "defer",
            until: new Date(Date.parse(now()) + error.retryAfterMs).toISOString(),
            error: "Judgment budget reached; waiting to retry. Local data is still usable.",
          };
        return { status: "retry", error: "Judgment unavailable; local data is still usable" };
      } finally {
        clearTimeout(timer);
        scope.signal.removeEventListener("abort", abort);
      }

      /** The lease is still ours and the item unchanged. */
      function current(leased: Job, resource: Resource) {
        const fresh = store.resource(resource.id);
        // One indexed row, not the whole job table (thousands of rows after a backfill).
        const lookup = (store as Partial<{ job(id: string): Job | undefined }>).job;
        const live = lookup ? lookup(leased.id) : store.jobs().find((j) => j.id === leased.id);
        return (
          !!fresh &&
          !fresh.deleted &&
          (fresh.contentHash === leased.inputHash || judgedHash(fresh) === leased.inputHash) &&
          live?.leaseToken === leased.leaseToken &&
          live.status === "running" &&
          !!live.leaseUntil &&
          live.leaseUntil > now()
        );
      }
    },
  };
}
