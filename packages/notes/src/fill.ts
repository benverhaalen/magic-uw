/**
 * "Fill from slides" (optional, on request): one checked call through the student's own client
 * proposes outline bullets for the note's student blocks from that session's slides. Every bullet
 * carries a verbatim quote that code checks (in the call's checks, then `findQuote` on the
 * resource text). Bullets become suggestions; nothing the student wrote is ever overwritten.
 * Sent: the passages and the template's block headings only; never the class meeting's time,
 * place or section, and never the student's notes.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { aiRecipientSchema, type NoteBlock, type NoteSuggestion, type Resource } from "@magic/contracts";
import { maySend } from "@magic/domain";
import { definePack, quotesGrounded, type CourseFrame, type Passage } from "../../packs/core/src/index";
import { learningArtifactStore, sqlLedgerStore } from "../../packs/core/src/learning-stores";
import { readPackArtifact, runPack } from "../../core/src/jobs/pack";
import { buildReceipt, egressFor } from "../../core/src/egress";
import { courseInclusion } from "../../core/src/access";
import { eligibleStudySource } from "../../learning/src/router";
import { findQuote } from "../../retrieval/src/quotes";
import type { ModelRunner } from "../../runner/src/index";
import type { NotesWorkspaceStore } from "./service";

export interface FillInput {
  blocks: { id: string; heading: string }[];
  count: number;
}
const bulletSchema = z
  .object({
    blockId: z.string().min(1).max(100),
    text: z.string().min(1).max(400),
    sourceId: z.string().min(1).max(200),
    quote: z.string().min(1).max(400),
  })
  .strict();
export const fillOutputSchema = z.object({ bullets: z.array(bulletSchema).max(40) }).strict();
export type FillOutput = z.infer<typeof fillOutputSchema>;

export const notesFillPack = definePack<FillInput, FillOutput>({
  id: "notes-fill",
  version: "v1",
  tier: "pass",
  system:
    "You draft outline bullets for a university student's class notes from that session's own slides and readings. Each bullet is one short idea in plain words, placed under the note section it fits, and grounded in one verbatim quote from the passage it comes from. Do not invent content that the passages do not state. Return only JSON matching the schema.",
  template: (i) =>
    `Note sections (use their ids as blockId):\n${i.blocks.map((b) => `- ${b.id}: ${b.heading}`).join("\n")}\n\nWrite up to ${i.count} bullets. Each quote must be copied exactly from the passage named by sourceId.`,
  schema: fillOutputSchema,
  checks: [
    quotesGrounded((o) => o.bullets),
    (o, i) => o.bullets.filter((b) => !i.blocks.some((x) => x.id === b.blockId)).map((b) => `unknown blockId ${b.blockId}`),
  ],
  cacheKey: (i) => i,
  categories: ["course_text"],
  intent: "notes",
});

export const FILL_TOKEN_BUDGET = 4000;
const MAX_PASSAGES = 16;
/** Which blocks the fill may suggest into: the student's blocks, never the scaffold's head. */
const HEAD = new Set(["context", "sources", "terms", "due"]);

export interface FillDeps {
  store: NotesWorkspaceStore;
  runner: () => ModelRunner | null | Promise<ModelRunner | null>;
  now: () => Date;
}
export type FillOutcome =
  | { status: "ok"; suggestions: Omit<NoteSuggestion, "status">[]; cached: boolean; tokens: { in: number; cached: number; out: number }; dropped: number; receiptIds: string[] }
  | { status: "empty" | "blocked" | "no_client" | "failed"; message: string; receiptIds: string[] };

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export async function fillFromSlides(
  deps: FillDeps,
  note: { id: string; accountScope: string; courseId: string; courseName: string; blocks: NoteBlock[] },
  resourceIds: string[],
  signal?: AbortSignal,
): Promise<FillOutcome> {
  const { store } = deps;
  const sources = new Map(store.sources().map((s) => [s.id, s]));
  const included = courseInclusion(store);
  const course = store
    .resources()
    .filter((r) => !r.deleted && r.courseId === note.courseId && sources.get(r.sourceId)?.accountScope === note.accountScope);
  const receiptIds: string[] = [];
  if (course.some((r) => r.policy.mode === "restricted"))
    return { status: "blocked", message: "This course restricts AI help with course materials, so nothing was sent.", receiptIds };
  const chosen: Resource[] = resourceIds
    .map((id) => course.find((r) => r.id === id))
    .filter((r): r is Resource => !!r && sources.get(r.sourceId)?.kind !== "notes" && included(r) && eligibleStudySource(r) && r.text.trim().length > 0);
  if (!chosen.length) return { status: "empty", message: "This session has no slides or readings with text to fill from yet.", receiptIds };
  const passages: Passage[] = [];
  const resourceOf = new Map<string, Resource>();
  let used = 0;
  const lists = chosen.map((r) => store.passages(r.id).filter((p) => !p.redacted));
  for (let i = 0; lists.some((l) => i < l.length) && passages.length < MAX_PASSAGES; i++)
    for (const l of lists) {
      const p = l[i];
      if (!p || passages.length >= MAX_PASSAGES) continue;
      const t = store.passage(p.pid);
      if (!t || !t.text.trim() || (used + p.tokEst > FILL_TOKEN_BUDGET && passages.length)) continue;
      used += p.tokEst;
      passages.push({ sourceId: `p${p.pid}`, text: t.text });
      resourceOf.set(`p${p.pid}`, chosen.find((r) => r.id === p.resourceId)!);
    }
  if (!passages.length) return { status: "empty", message: "The session's materials haven't been split into passages yet. Try again after they sync.", receiptIds };
  const targets = note.blocks.filter((b) => !HEAD.has(b.id) && b.kind !== "summary").map((b) => ({ id: b.id, heading: b.heading }));
  if (!targets.length) return { status: "empty", message: "This note has no section to fill.", receiptIds };
  const input: FillInput = { blocks: targets, count: 12 };
  const courseRef = `${note.accountScope}:${note.courseId}`;
  store.learning.course(note.accountScope, note.courseId, note.courseName); // artifacts belong to a learning course
  const frame: CourseFrame = { courseId: courseRef, course: note.courseName, skeleton: `Course: ${note.courseName}`, policy: "" };
  const sourceOf = (sourceId: string) => {
    const r = resourceOf.get(sourceId);
    return r ? { resourceId: r.id, contentHash: r.contentHash } : null;
  };
  const courseOf = (ref: string) => (ref === courseRef ? { accountScope: note.accountScope, courseId: note.courseId } : null);
  const runner = await deps.runner();
  const at = () => deps.now().toISOString();
  const authorize = (recipient: string, categories: string[]) => {
    const parsed = aiRecipientSchema.safeParse(recipient);
    if (!parsed.success) return { allowed: false, reason: "This recipient is not supported." };
    const permission = maySend(store.privacy(), recipient, categories);
    const text = passages.map((p) => p.text).join("\n\n");
    const manifest = {
      recipient: parsed.data,
      purpose: "Suggest note bullets from this session's slides",
      categories,
      resourceIds: [...new Set([...resourceOf.values()].map((r) => r.id))],
      characters: text.length,
      allowed: permission.allowed,
      reason: permission.reason,
      payload: { course: note.courseName, title: "notes.fill", text, policy: "" },
    };
    const decision = egressFor(store).check(manifest, { at: at(), background: false });
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
  const artifacts = learningArtifactStore(store.learning, sourceOf);
  const ledger = sqlLedgerStore(store, courseOf);
  // With no client, only a cached result can answer (0 tokens).
  const offline: ModelRunner | null = runner;
  if (!offline) {
    const hit = readPackArtifact(artifacts, notesFillPack, frame, input, passages);
    if (!hit) return { status: "no_client", message: "Connect your AI first: choose Claude or Codex in Settings and sign in, then try again.", receiptIds };
    return finish(hit.output, hit.cacheKey, true, { in: 0, cached: 0, out: 0 });
  }
  const result = await runPack(
    { runner: offline, artifacts, ledger, authorize, now: () => deps.now().getTime() },
    notesFillPack,
    frame,
    input,
    passages,
    { lane: "interactive", scope: "resources", ...(signal ? { signal } : {}) },
  );
  if (result.status === "blocked") return { status: "blocked", message: result.reason, receiptIds };
  if (result.status !== "done")
    return { status: "failed", message: result.status === "needs_student" ? result.question : result.message, receiptIds };
  return finish(result.artifact.output, result.artifact.cacheKey, result.cached, result.cached ? { in: 0, cached: 0, out: 0 } : result.artifact.usage);

  function finish(output: FillOutput, cacheKey: string, cached: boolean, tokens: { in: number; cached: number; out: number }): FillOutcome {
    const written = new Set(note.blocks.flatMap((b) => b.items.map((i) => norm(i.text))));
    const suggestions: Omit<NoteSuggestion, "status">[] = [];
    let dropped = 0;
    output.bullets.forEach((b, index) => {
      const r = resourceOf.get(b.sourceId);
      const found = r ? findQuote(r.text, b.quote) : null;
      if (!r || !found || found.status !== "unique" || !targets.some((t) => t.id === b.blockId) || written.has(norm(b.text))) {
        dropped++;
        return;
      }
      suggestions.push({
        id: `sg-${createHash("sha256").update(`${note.id}\u0000${cacheKey}\u0000${index}`).digest("hex").slice(0, 16)}`,
        blockId: b.blockId,
        text: b.text.trim(),
        resourceId: r.id,
        quote: r.text.slice(found.start, found.end),
      });
    });
    return { status: "ok", suggestions, cached, tokens, dropped, receiptIds };
  }
}
