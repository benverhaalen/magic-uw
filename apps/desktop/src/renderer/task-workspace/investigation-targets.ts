import type { Resource, SourceHealth, SourceInvestigationResult } from "@magic/contracts";
import { hostOf, httpsUrl, type Target } from "./model";

/**
 * Evidence-to-workspace adapter for a finished source check (`SourceInvestigationResult`).
 *
 * A check can point at pages the assignment itself never links (for example the Lecture 7
 * section of a course schedule). Those pages are offered as optional support with the cited
 * span, never pre-selected and never presented as where the work is done or submitted, even
 * when the check calls them a work target. Every citation is rechecked against what is saved
 * now: same assignment, same account and course, same resource version and address.
 */
export interface InvestigationInput {
  result: SourceInvestigationResult | null | undefined;
  /**
   * The assignment version the check ran for, when the caller knows it. The result itself
   * doesn't carry it yet (see HANDOFF: `assignmentHash`); citations of the assignment are
   * checked against the current version either way.
   */
  forHash?: string;
  assignment: Pick<Resource, "id" | "courseId" | "sourceId" | "contentHash">;
  accountScope: string;
  saved: {
    resources: readonly Pick<Resource, "id" | "sourceId" | "courseId" | "contentHash" | "version" | "url" | "title" | "deleted">[];
    sources: readonly Pick<SourceHealth, "id" | "accountScope" | "status">[];
  };
}
export const MAX_CHECK_PAGES = 4;
const UNREADABLE = new Set<SourceHealth["status"]>(["inaccessible", "not_published", "needs_sign_in"]);

export function withInvestigation(targets: readonly Target[], input: InvestigationInput): { targets: Target[]; notes: string[] } {
  const { result } = input;
  if (!result) return { targets: [...targets], notes: [] };
  if (result.assignmentId !== input.assignment.id || result.workSet.assignmentId !== input.assignment.id)
    return { targets: [...targets], notes: ["The source check was for a different assignment, so its pages aren't offered."] };
  const selfCited = result.findings.flatMap(f => f.citations).filter(c => c.resourceId === input.assignment.id);
  if ((input.forHash !== undefined && input.forHash !== input.assignment.contentHash) || selfCited.some(c => c.contentHash !== input.assignment.contentHash))
    return { targets: [...targets], notes: ["The assignment changed since the source check, so its pages aren't offered. Check again to refresh them."] };

  const accounts = new Map(input.saved.sources.map(s => [s.id, s]));
  const byId = new Map(input.saved.resources.map(r => [r.id, r]));
  const next = targets.map(t => ({ ...t, evidence: { ...t.evidence } }));
  let dropped = 0, added = 0;
  for (const finding of result.findings) {
    for (const c of finding.citations) {
      if (c.resourceId === input.assignment.id) continue; // the instructions are already the left window
      const r = byId.get(c.resourceId);
      const source = r && accounts.get(r.sourceId);
      const url = r && httpsUrl(r.url);
      if (!r || r.deleted || !source || source.accountScope !== input.accountScope || r.courseId !== input.assignment.courseId ||
          r.contentHash !== c.contentHash || r.version !== c.version || UNREADABLE.has(source.status) || !url || r.url !== c.sourceUrl) {
        dropped++;
        continue;
      }
      const cite = { resourceId: r.id, title: r.title, contentHash: r.contentHash, version: r.version, start: c.start, end: c.end, excerpt: c.excerpt };
      const existing = next.find(t => t.url === url);
      if (existing) {
        // Keep the page's own provenance; add what the check cited, once.
        if (!existing.evidence.finding) {
          existing.evidence.finding = { kind: finding.kind, text: finding.text };
          existing.evidence.cite ??= cite;
        }
        continue;
      }
      if (added >= MAX_CHECK_PAGES) continue;
      added++;
      next.push({
        key: `page:${url}`, label: r.title, url, origin: "student",
        detail: `Possibly related · cited by the source check, not linked to this assignment · ${hostOf(url)}`,
        evidence: { source: "source_check", confirmed: false, cite, finding: { kind: finding.kind, text: finding.text } },
      });
    }
  }
  const notes = dropped ? [`${dropped === 1 ? "One cited page" : `${dropped} cited pages`} changed or ${dropped === 1 ? "isn't" : "aren't"} available for this course anymore, so ${dropped === 1 ? "it isn't" : "they aren't"} offered.`] : [];
  return { targets: next, notes };
}

/** The "why offered" text: the finding, then the exact saved span it cites. */
export function targetWhy(target: Pick<Target, "evidence">): string | undefined {
  const { cite, finding, source, confirmed } = target.evidence;
  if (!cite && !finding) return undefined;
  const lead = source === "source_check" || (source === "course_section" && !confirmed)
    ? "Possibly related, not confirmed as this assignment's work or submission page."
    : undefined;
  const quote = cite ? `“${cite.excerpt}” from ${cite.title}${cite.version ? `, version ${cite.version}` : ""}, characters ${cite.start}–${cite.end}.` : undefined;
  return [lead, finding ? `Source check: ${finding.text}` : undefined, quote].filter(Boolean).join(" ");
}
