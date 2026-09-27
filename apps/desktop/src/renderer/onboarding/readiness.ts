import type { ResourceView, Snapshot, SourceHealth } from "@magic/contracts";
import { hiddenFromStudents, isFileScope, sourceLine, type SourceLine } from "./model";
import { verifiedCanvasEnrollment } from "../enrollment-evidence";

/** A compact index over every saved check. Nothing is discarded from the drilldown. */
export interface ReadinessGroup {
  id: string;
  label: string;
  area: "included" | "other" | "account";
  checks: SourceLine[];
  incomplete: number;
}
export interface ReadinessOverview {
  includedCourses: number;
  currentCourses: number;
  checks: number;
  incomplete: number;
  signIn: number;
  failed: number;
  important: number;
  importantAreas: string[];
  primaryGap: boolean;
  groups: ReadinessGroup[];
}

const importantScopes = new Set(["assignments", "syllabus", "announcements", "modules", "submissions", "calendar_feed"]);
const key = (accountScope: string, courseId: string) => JSON.stringify([accountScope, courseId]);
const incomplete = (line: SourceLine) => line.state === "partial" || line.state === "failed";
const historical = (source: SourceHealth) => source.diagnostics?.some((d) => d.code === "historical_course_metadata_only") ?? false;

/**
 * Every saved check behind the summary's lines. The Populating summary folds course files into one
 * line per course and leaves out courses the student excluded (03795ec); the drilldown still holds
 * each of those checks, secondary. Lists Canvas hides from students are not checks.
 */
function everyCheck(snapshot: Snapshot, lines: SourceLine[]): SourceLine[] {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const sourceIds = new Set(snapshot.sources.map((source) => source.id));
  const leaves = snapshot.sources.filter((source) => !hiddenFromStudents(source)).map((source): SourceLine => {
    const line = byId.get(source.id);
    if (line) return line;
    // A file the budget deferred is still coming in, as the summary says, not a partial read.
    if (isFileScope(source.scope) && source.diagnostics?.some((d) => d.code === "file_budget_deferred"))
      return { id: source.id, label: source.label, state: "reading", status: "Still coming in" };
    return sourceLine(source, false);
  });
  // A course-files line stands for leaf checks listed above; any other producer line stays as it is.
  return [...leaves, ...lines.filter((line) => !sourceIds.has(line.id) && !line.id.startsWith("files:"))];
}

export function projectReadiness(snapshot: Snapshot, summaryLines: SourceLine[], now = new Date()): ReadinessOverview {
  const lines = everyCheck(snapshot, summaryLines);
  const sourceById = new Map(snapshot.sources.map((source) => [source.id, source]));
  const courseResources = new Map<string, ResourceView>();
  for (const resource of snapshot.resources) {
    if (resource.deleted || resource.kind !== "course") continue;
    const source = sourceById.get(resource.sourceId);
    if (!source) continue;
    courseResources.set(key(source.accountScope, resource.courseId), resource);
  }
  const canvasAccounts = new Set(snapshot.sources.filter((source) => source.kind === "canvas" && source.scope === "course").map((source) => source.accountScope));
  const verified = verifiedCanvasEnrollment(snapshot.planning, canvasAccounts, now);
  const current = new Set([...courseResources].filter(([id, resource]) => {
    const [accountScope] = JSON.parse(id) as [string, string];
    return accountScope === verified?.canvasAccountScope && verified.enrollment.match({ course_code: resource.course?.courseCode, name: resource.courseName });
  }).map(([id]) => id));
  const selected = new Set([...courseResources].filter(([id, resource]) => current.has(id) || resource.course?.selection?.included === true).map(([id]) => id));
  const groups = new Map<string, ReadinessGroup>();
  let signIn = 0;
  let failed = 0;
  let important = 0;
  const importantAreas = new Set<string>();
  let problems = 0;
  lines.forEach((line) => {
    const source = sourceById.get(line.id);
    if (!source) {
      // A producer may summarize many leaf checks as one line. Keep that line inspectable.
      const groupId = "other:summary";
      const group = groups.get(groupId) ?? { id: groupId, label: "Other read checks", area: "other" as const, checks: [], incomplete: 0 };
      group.checks.push(line);
      if (incomplete(line)) { group.incomplete++; problems++; }
      groups.set(groupId, group);
      return;
    }
    const courseKey = key(source.accountScope, source.courseId);
    const isCourse = source.kind === "canvas" && source.scope === "course" || courseResources.has(courseKey) || selected.has(courseKey);
    const isAccount = !isCourse && (source.courseId === "account" || source.courseId === "connection");
    const area: ReadinessGroup["area"] = isAccount ? "account" : selected.has(courseKey) ? "included" : "other";
    const groupId = isAccount ? `account:${source.kind}:${source.accountScope}` : isCourse ? `course:${courseKey}` : `other:${source.kind}:${source.accountScope}`;
    const title = courseResources.get(courseKey)?.title || snapshot.sources.find((candidate) => candidate.accountScope === source.accountScope && candidate.courseId === source.courseId && candidate.scope === "course")?.label;
    const label = isAccount ? `${source.kind === "canvas" ? "Canvas" : source.kind} account` : isCourse ? title || "Course site" : source.kind === "web" ? "Linked websites" : `${source.kind} checks`;
    const group = groups.get(groupId) ?? { id: groupId, label, area, checks: [], incomplete: 0 };
    group.checks.push(line);
    if (incomplete(line)) {
      group.incomplete++;
      problems++;
      if ((isAccount || area === "included") && source.status === "needs_sign_in") signIn++;
      else if ((isAccount || area === "included") && (source.status === "error" || source.status === "needs_attention")) failed++;
      if (area === "included" && importantScopes.has(source.scope) && !historical(source)) {
        important++;
        const scope = source.scope === "calendar_feed" ? "Calendar" : source.scope.charAt(0).toUpperCase() + source.scope.slice(1);
        const result = source.status === "needs_sign_in" ? "sign-in needed" : line.state === "failed" ? "not read" : "partly read";
        importantAreas.add(`${scope} for ${group.label}: ${result}.`);
      }
    }
    groups.set(groupId, group);
  });
  const ordered = [...groups.values()].sort((a, b) => {
    const rank = { included: 0, account: 1, other: 2 };
    return rank[a.area] - rank[b.area] || Number(b.incomplete > 0) - Number(a.incomplete > 0) || a.label.localeCompare(b.label);
  });
  return { includedCourses: selected.size, currentCourses: current.size, checks: lines.length, incomplete: problems, signIn, failed, important, importantAreas: [...importantAreas], primaryGap: signIn > 0 || failed > 0 || important > 0, groups: ordered };
}
