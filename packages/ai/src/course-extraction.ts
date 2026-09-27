import { z } from "zod";
import type { CourseExtractionBatch, Resource } from "@magic/contracts";
import { createLocalAi, type LocalCommandRunner } from "./local";

const VERSION = "course-extraction.local.v1";
const MAX_CHARACTERS = 6000;
const sourceSchema = z.object({
  id: z.string().min(1).max(500), contentHash: z.string().min(1).max(200),
  text: z.string().max(200000), kind: z.string().max(100), externalId: z.string().max(500),
});
const inputSchema = z.object({ inputHash: z.string().min(1).max(200),
  resources: z.array(sourceSchema).max(1000) });
const candidateSchema = z.object({
  kind: z.enum(["ai_policy", "grading", "topic", "assessment"]),
  resourceId: z.string().min(1).max(500), contentHash: z.string().min(1).max(200),
  start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
  quote: z.string().min(1).max(4000), label: z.string().min(1).max(300),
  value: z.string().min(1).max(4000),
}).strict();
const responseSchema = z.object({ candidates: z.array(candidateSchema).max(40) }).strict();
export interface LocalCourseExtractionInput {
  inputHash: string;
  resources: Pick<Resource, "id" | "contentHash" | "text" | "kind" | "externalId">[];
}

/** Optional local semantic selection; no construction I/O, cloud route or model install.
 * Ollama format/schema + validation pattern inspected 2026-09-26:
 * https://docs.ollama.com/capabilities/structured-outputs
 * Returned candidates still require the compiler's current-source/scope checks.
 */
export function createLocalCourseExtractor(options: {
  fetcher?: typeof fetch; run?: LocalCommandRunner;
} = {}) {
  const local = createLocalAi(options);
  return {
    version: VERSION,
    async extract(input: LocalCourseExtractionInput, signal?: AbortSignal): Promise<CourseExtractionBatch | null> {
      signal?.throwIfAborted();
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return null;
      if (new Set(parsed.data.resources.map(r => r.id)).size !== parsed.data.resources.length) return null;
      const eligible = parsed.data.resources.filter(r =>
        r.externalId === "syllabus" || r.kind === "assignment")
        .sort((a, b) => Number(b.externalId === "syllabus") - Number(a.externalId === "syllabus") || a.id.localeCompare(b.id));
      const selected: z.infer<typeof sourceSchema>[] = [];
      const omitted = new Set<string>();
      let remaining = MAX_CHARACTERS;
      for (const source of eligible) {
        if (selected.length >= 6 || remaining === 0) { omitted.add(source.id); continue; }
        if (!source.text.trim()) continue;
        const text = source.text.slice(0, remaining);
        selected.push({ ...source, text });
        remaining -= text.length;
        if (text.length < source.text.length) omitted.add(source.id);
      }
      if (!selected.length) return null;
      try {
        const answer = await local.extractCourseText({
          sourceData: JSON.stringify({ sources: selected.map(({ id, contentHash, text }) =>
            ({ resourceId: id, contentHash, text })) }),
          format: z.toJSONSchema(responseSchema),
        }, signal);
        signal?.throwIfAborted();
        // Validate rows individually: one malformed candidate does not hide valid evidence.
        const envelope = z.object({ candidates: z.array(z.unknown()).max(40) }).strict()
          .safeParse(JSON.parse(answer.text));
        if (!envelope.success) return null;
        const candidates: CourseExtractionBatch["candidates"] = [];
        let rejected = 0;
        for (const raw of envelope.data.candidates) {
          const checked = candidateSchema.safeParse(raw);
          if (!checked.success) { rejected++; continue; }
          const row = checked.data;
          const source = selected.find(r => r.id === row.resourceId && r.contentHash === row.contentHash);
          if (!source || row.value !== row.quote) { rejected++; continue; }
          let { start, end } = row;
          if (source.text.slice(start, end) !== row.quote) {
            // Models count positions poorly. Code may recover an unambiguous literal quote.
            start = source.text.indexOf(row.quote);
            if (start < 0 || source.text.indexOf(row.quote, start + 1) !== -1) { rejected++; continue; }
            end = start + row.quote.length;
          }
          if (end !== start + row.quote.length || end > source.text.length) { rejected++; continue; }
          candidates.push({ ...row, start, end });
        }
        return {
          inputHash: parsed.data.inputHash,
          extractorVersion: `${VERSION}:${answer.model}:${answer.digest}`,
          candidates,
          coverage: { status: omitted.size || rejected ? "partial" : "complete",
            examinedResourceIds: selected.map(r => r.id), omittedResourceIds: [...omitted], rejectedCandidates: rejected },
        };
      } catch {
        signal?.throwIfAborted();
        // No runtime/model response text or local paths leak through errors.
        return null;
      }
    },
  };
}
