/**
 * Generating the "how to approach it" paragraph (owner: page-views), on request only: the `pack`
 * command with pack "page-approach" and scope `{courseId, resourceIds: [assignmentId]}` or
 * `{courseId, assessmentId}`. It follows the existing pack path: the page's facts (code) → the
 * privacy scrubber for a hosted client → the egress decision (consent, preview, receipt) → one
 * checked call through the student's own AI (`runPack`: cache first, retry, escalate) → the code
 * check that every date, number and quote is in the page's facts. The course brief's byte-stable
 * prefix leads the prompt when there is one. The artifact is cached by the page's fact hash, so the
 * query shows it at 0 tokens until a fact on the page changes.
 */
import { z } from "zod";
import { aiRecipientSchema, type PackScope, type Store } from "@magic/contracts";
import { maySend } from "@magic/domain";
import type { BackendCall, ModelRunner } from "../../../runner/src/index";
import { definePack, quotesGrounded, type ArtifactStore, type CourseFrame, type LedgerStore } from "../../../packs/core/src/index";
import { learningArtifactStore, sqlLedgerStore } from "../../../packs/core/src/learning-stores";
import { runPack } from "../jobs/pack";
import { buildReceipt, egressFor, payloadHash } from "../egress";
import { contentCategories } from "../access";
import { payloadScrubber } from "../identity";
import { effectiveCoursePolicy } from "../../../domain/src/course-intelligence";
import { APPROACH_PACK, APPROACH_VERSION, approachFacts, approachHash, approachKey, checkApproach, type ApproachFacts, type ApproachOutput } from "./approach";
import { assessmentPage } from "./assessment";
import { assignmentWorkspace } from "./assignment";
import { PageViewError, viewStore, type ViewStore } from "./common";

const outputSchema = z
  .object({
    paragraph: z.string().min(1).max(1500),
    quotes: z.array(z.object({ sourceId: z.string().max(40), quote: z.string().max(600) }).strict()).max(4),
  })
  .strict();
interface ApproachInput {
  facts: ApproachFacts;
  factHash: string;
}
export const approachPack = definePack<ApproachInput, ApproachOutput>({
  id: APPROACH_PACK,
  version: APPROACH_VERSION,
  tier: "pass",
  system: [
    "You write one short paragraph (at most 120 words) telling a student how to approach one course item.",
    "Use only the facts and passages given. Every date, time, number and quotation you write must appear in them exactly; do not add any.",
    "Put exact quotations from a passage in double quotes and list each in `quotes` with the passage id.",
    "Suggest an order of work and which listed resources to open first. Do not predict grades. Follow the course AI policy.",
  ].join("\n"),
  template: (input) => `Write the paragraph for this ${input.facts.kind}: ${input.facts.title}. The facts passage lists what code knows.`,
  schema: outputSchema,
  checks: [quotesGrounded((o) => o.quotes), (o, input) => checkApproach(o.paragraph, input.facts)],
  cacheKey: (input) => input.factHash,
  categories: ["course_text"],
  intent: "Plan how to approach one assignment or assessment from its checked facts",
});

export interface ApproachRunResult {
  status: "done" | "blocked" | "no_client" | "needs_student" | "paused" | "failed" | "unavailable";
  message: string;
  pack: typeof APPROACH_PACK;
  factHash: string | null;
  text: string | null;
  cached: boolean;
  tokens: { in: number; cached: number; out: number };
  receiptIds: string[];
  checkErrors?: string[];
}
export interface ApproachDeps {
  store: Store;
  runner: () => ModelRunner | null | Promise<ModelRunner | null>;
  artifacts?: ArtifactStore;
  ledger?: LedgerStore;
  now?: () => Date;
}
class ApproachBlocked extends Error {}
const RECIPIENT: Record<string, string> = { local: "local", claude: "claude", anthropic: "claude", codex: "codex", openai: "chatgpt", openrouter: "openrouter", gemini: "gemini" };

export function createApproachHandler(deps: ApproachDeps) {
  const now = deps.now ?? (() => new Date());
  async function run(scope: PackScope, signal?: AbortSignal): Promise<ApproachRunResult> {
    const base: ApproachRunResult = { status: "done", message: "", pack: APPROACH_PACK, factHash: null, text: null, cached: false, tokens: { in: 0, cached: 0, out: 0 }, receiptIds: [] };
    let store: ViewStore;
    try {
      store = viewStore(deps.store);
    } catch (error) {
      return { ...base, status: "unavailable", message: (error as Error).message };
    }
    const learning = store.learning;
    if (!learning) return { ...base, status: "unavailable", message: "Generated text isn't available in this workspace." };
    const at = () => now().toISOString();
    // Each build is a fresh read (viewStore starts a new request), so the fingerprint sees changes.
    const build = () => {
      const fresh = viewStore(deps.store);
      if (scope.resourceIds?.length === 1 && !scope.assessmentId) return assignmentWorkspace(fresh, scope.resourceIds[0]!, at());
      if (scope.assessmentId) return assessmentPage(fresh, scope.assessmentId, at());
      throw new PageViewError("Name one assignment (resourceIds) or one assessment (assessmentId).");
    };
    let page;
    try {
      page = build();
    } catch (error) {
      return { ...base, status: "unavailable", message: error instanceof PageViewError ? error.message : "This page couldn't be read." };
    }
    if (page.course.courseId !== scope.courseId) return { ...base, status: "unavailable", message: "That item isn't in this course." };
    const facts = approachFacts(page);
    const factHash = approachHash(facts);
    const course = { accountScope: page.course.accountScope, courseId: page.course.courseId };
    const courseRef = `${course.accountScope}:${course.courseId}`;
    const resourceId = page.view === "assignment.workspace" ? page.header.resourceId : page.assessment.resourceId;
    const target = resourceId ? store.resource(resourceId) : undefined;
    const profile = store.courseIntelligence().find((p) => p.accountScope === course.accountScope && p.courseId === course.courseId);
    const policy = target ? effectiveCoursePolicy(profile, target) : undefined;
    if (policy?.mode === "restricted") return { ...base, factHash, status: "blocked", message: "This course restricts AI use, so no paragraph was written." };

    learning.course(course.accountScope, course.courseId, page.course.courseName);
    const artifacts = deps.artifacts ?? learningArtifactStore(learning, () => null);
    const ledger = deps.ledger ?? sqlLedgerStore(store, (ref) => (ref === courseRef ? course : null));
    const cacheKey = approachKey(factHash);
    // A change in the page's facts, the sources or the sharing settings between reading and the call blocks it.
    const fingerprint = () => payloadHash({ factHash: approachHash(approachFacts(build())), privacy: store.privacy(), consents: store.consents?.() });
    const first = fingerprint();
    const validate = () => {
      if (signal?.aborted || fingerprint() !== first) throw new ApproachBlocked("The page or your sharing settings changed. Try again with the current page.");
    };
    const runner = await deps.runner();
    const hosted = runner ? runner.client !== "local" : store.privacy().mode !== "local_only";
    const scrubber = payloadScrubber(store, hosted, course.accountScope);
    const scrub = (value: string) => scrubber.field(value, course.courseId);
    const brief = store.courseBrief(course);
    const frame: CourseFrame = {
      courseId: courseRef,
      course: scrub(page.course.courseName),
      skeleton: scrub([...(brief ? [brief.prefixText] : []), `Course: ${page.course.courseName}`].join("\n\n")),
      policy: scrub(policy ? `${policy.mode}: ${policy.evidence}` : ""),
    };
    const passages = facts.passages.map((p) => ({ sourceId: p.sourceId, text: scrub(p.text) }));
    const input: ApproachInput = { facts: { ...facts, lines: facts.lines.map(scrub), passages }, factHash };
    const receiptIds: string[] = [];
    const resources = [resourceId, ...(page.view === "assignment.workspace" ? page.resources.map((r) => r.resourceId) : page.materials.core.map((r) => r.resourceId))].filter((x): x is string => !!x);
    const categories = [...new Set(resources.map((id) => store.resource(id)).filter((r) => !!r).flatMap((r) => contentCategories(r!)))];
    const authorize = (recipient: string, packCategories: string[], payload?: unknown) => {
      validate();
      const all = [...new Set([...packCategories, ...categories])];
      const parsed = aiRecipientSchema.safeParse(recipient);
      if (!parsed.success) return { allowed: false, reason: "This recipient is not supported." };
      const permission = maySend(store.privacy(), recipient, all);
      if (payload === undefined && permission.allowed) return permission;
      const manifest = { recipient: parsed.data, purpose: "Plan how to approach a course item", categories: all, resourceIds: resources, characters: JSON.stringify(payload ?? {}).length, allowed: permission.allowed, reason: permission.reason, payload };
      const decision = egressFor(store).check(manifest, { at: at() });
      if (decision.status === "blocked") {
        receiptIds.push(decision.receiptId);
        return { allowed: false, reason: decision.reason };
      }
      if (decision.status === "preview_required") {
        receiptIds.push(decision.previewId);
        return { allowed: false, reason: decision.reason };
      }
      const receipt = buildReceipt(manifest, "sent", at());
      store.addReceipt(receipt);
      receiptIds.push(receipt.id);
      return { allowed: true, reason: permission.reason };
    };
    const done = (text: string, cached: boolean, usage: ApproachRunResult["tokens"]): ApproachRunResult => {
      const errors = checkApproach(text, facts);
      return errors.length
        ? { ...base, factHash, receiptIds, status: "needs_student", message: "The paragraph didn't pass the app's checks against this page's facts.", checkErrors: errors }
        : { ...base, factHash, receiptIds, status: "done", message: cached ? "Already written for this page (0 tokens)." : "Written from this page's facts; every date, number and quote was checked.", text, cached, tokens: cached ? { in: 0, cached: 0, out: 0 } : usage };
    };
    const hit = artifacts.get(cacheKey);
    const parsedHit = hit ? outputSchema.safeParse(hit.output) : null;
    if (hit && parsedHit?.success) {
      ledger.append({ at: at(), pack: approachPack.id, packVersion: approachPack.version, courseId: courseRef, cacheKey, outcome: "cache_hit", usage: { in: 0, cached: 0, out: 0 } });
      return done(parsedHit.data.paragraph, true, { in: 0, cached: 0, out: 0 });
    }
    if (!runner) return { ...base, factHash, status: "no_client", message: "Connect your AI first: choose Claude or Codex in Settings and sign in, then try again." };
    const beforeCall = (call: BackendCall): BackendCall => {
      const outgoing = { ...call, courseId: hosted ? undefined : call.courseId, systemPrompt: scrub(call.systemPrompt), input: scrub(call.input) };
      const permission = authorize(RECIPIENT[runner.client] ?? runner.client, approachPack.categories, { systemPrompt: outgoing.systemPrompt, input: outgoing.input, jsonSchema: outgoing.jsonSchema });
      if (!permission.allowed) throw new ApproachBlocked(permission.reason);
      return outgoing;
    };
    try {
      validate();
      const result = await runPack(
        { runner, artifacts, ledger, authorize, beforeCall, validate, cacheKey, now: () => now().getTime() },
        approachPack,
        frame,
        input,
        passages,
        { lane: "interactive", scope: page.view, ...(signal ? { signal } : {}) },
      );
      if (result.status === "blocked") return { ...base, factHash, receiptIds, status: "blocked", message: result.reason };
      if (result.status === "paused" || result.status === "failed") return { ...base, factHash, receiptIds, status: result.status, message: result.message };
      if (result.status === "needs_student") return { ...base, factHash, receiptIds, status: "needs_student", message: result.question, checkErrors: result.checkErrors };
      return done(result.artifact.output.paragraph, result.cached, result.artifact.usage);
    } catch (error) {
      if (error instanceof ApproachBlocked) return { ...base, factHash, receiptIds, status: "blocked", message: error.message };
      throw error;
    }
  }
  return { run };
}
