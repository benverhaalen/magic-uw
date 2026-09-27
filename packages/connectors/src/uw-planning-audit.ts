import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";
import { z } from "zod";
import {
  planningAuditSchema,
  planningCaptureSchema,
  uwTermCodeSchema,
  type PlanningAudit,
  type PlanningCapture,
  type PlanningSubject,
} from "@magic/contracts";
import {
  buildCourseIdentityTable,
  parseNormalizedAuditBlocks,
  type NormalizedAuditBlock,
} from "../../domain/src/planning";
import type { UwPlanningHttp, UwPlanningReadResult } from "./uw-planning-http";

const origin = "https://enroll.wisc.edu";
const metadataUrl = `${origin}/api/dars/audit-metadata`;
const metadataScope = { kind: "audit_program" as const, key: "saved-audits" };
const contextSchema = z.object({
  accountScope: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value !== "public"),
  observedAt: z.iso.datetime({ offset: true }),
  currentTermCode: uwTermCodeSchema,
});
// Explicit projection excludes student identity, advisor, request-user, and job fields.
const metadataSchema = z.object({
  darsDegreeAuditReportId: z
    .number()
    .int()
    .positive()
    .max(999_999_999_999_999)
    .nullable(),
  darsInstitutionCode: z.string().trim().min(1).max(100),
  darsDegreeProgramCode: z.string().trim().min(1).max(100),
  darsHonorsOptionCode: z.string().max(100).optional(),
  darsAuditRunDate: z.string().max(100),
  darsCatalogYearTerm: z.string().max(100),
});
const reportSchema = z.object({
  header: z.object({
    darsDegreeProgramCode: z.string().max(100),
    darsCatalogYearTerm: z.string().max(100),
    degreeProgramTitle1: z.string().max(2000),
    degreeProgramTitle2: z.string().max(2000).nullable().optional(),
  }),
  requirements: z.array(z.unknown()).max(500),
  errorText: z.array(z.unknown()).max(100),
});
const requirementSchema = z.object({
  requirementName: z.string().max(200),
  status: z.object({ status: z.string().max(100) }),
  requirementContents: z.array(z.unknown()).max(500),
});
const blockSchema = z.object({
  contentType: z.string().max(100),
  lines: z.array(z.string().max(20_000)).max(300).optional(),
  subRequirementCourses: z.array(z.unknown()).max(1000).optional(),
});
const courseSchema = z.object({
  term: z.string().max(30).nullable(),
  course: z.string().min(1).max(300),
  credits: z.string().max(30).nullable(),
  grade: z.string().max(20).nullable(),
  courseNote: z.string().max(2000).nullable().optional(),
});
type Metadata = z.infer<typeof metadataSchema>;
type Heading = Extract<NormalizedAuditBlock, { kind: "heading" }>;
export interface UwSavedAuditContext {
  accountScope: string;
  observedAt: string;
  currentTermCode: string;
  subjects: PlanningSubject[];
}
export interface UwSavedAuditOptions extends UwSavedAuditContext {
  metadata: unknown;
}

function checkedContext(input: UwSavedAuditContext): UwSavedAuditContext {
  const result = contextSchema.safeParse(input);
  if (!result.success || !Array.isArray(input.subjects))
    throw new Error("Invalid saved-audit capture context.");
  return { ...result.data, subjects: input.subjects };
}
function text(input: string): string {
  let result = "",
    hidden = 0;
  new Parser(
    {
      onopentag(name) {
        if (["script", "style", "template"].includes(name)) hidden++;
        if (!hidden && ["br", "p", "div", "li"].includes(name)) result += " ";
      },
      ontext(value) {
        if (!hidden) result += value;
      },
      onclosetag(name) {
        if (["script", "style", "template"].includes(name))
          hidden = Math.max(0, hidden - 1);
      },
    },
    { decodeEntities: true },
  ).end(input);
  return result
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function programKey(metadata: Metadata): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        metadata.darsInstitutionCode,
        metadata.darsDegreeProgramCode,
        metadata.darsHonorsOptionCode ?? "",
      ]),
    )
    .digest("hex");
}
function capture(
  context: UwSavedAuditContext,
  scope: PlanningCapture["scope"],
  sourceUrl: string,
  records: PlanningAudit[],
  status: PlanningCapture["status"],
  diagnostics: PlanningCapture["diagnostics"] = [],
): PlanningCapture {
  return planningCaptureSchema.parse({
    schemaVersion: 1,
    id: `saved-audit-${scope.key}-${context.observedAt}`,
    accountScope: context.accountScope,
    observedAt: context.observedAt,
    source: "uw_dars",
    scope,
    sourceUrl,
    records,
    status,
    completeness:
      status === "complete"
        ? "complete"
        : status === "partial"
          ? "partial"
          : "unknown",
    diagnostics,
  });
}
function rawStatus(value: string): Heading["rawStatus"] {
  return value === "OK" || value === "NO" || value === "NONE" ? value : null;
}
function flags(value: string): string[] {
  const prefix =
    /^(?:(?:IN-P|IP|PL|R|<>|\+|-|\*)\s*)+(?![A-Za-z])/.exec(value)?.[0] ?? "";
  return [
    ...new Set(
      (prefix.match(/IN-P|IP|PL|R|<>|\+|-|\*/g) ?? []).map((flag) =>
        flag === "IN-P" ? "IP" : flag,
      ),
    ),
  ];
}
function decimal(value: string | null): number | null {
  if (value === null || !/^\s*\d+(?:\.\d+)?\s*$/.test(value)) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 && result <= 1000
    ? result
    : null;
}
function knownTimestamp(value: string): string | null {
  return z.iso.datetime({ offset: true }).safeParse(value).success
    ? value
    : null;
}
function sortableTimestamp(value: string): string | null {
  // The observed UW metadata uses local ISO dates; sorting does not assign them a timezone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value))
    return null;
  const date = new Date(`${value}Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 19) === value.slice(0, 19)
    ? value
    : null;
}

/**
 * Parses the actual saved JSON report used by UW's DARS view, not a new audit request.
 * UW's view supplies typed requirement/line/course blocks. Unknown blocks remain local
 * evidence. Identity-bearing header, topSection, bottomSection and arbitrary fields are
 * never copied. Applied grades and earned GPA remain audit-scoped, never transcript rows.
 */
export function parseUwSavedAudit(
  input: unknown,
  options: UwSavedAuditOptions,
): PlanningCapture {
  const context = checkedContext(options);
  const parsedMetadata = metadataSchema.safeParse(options.metadata);
  if (
    !parsedMetadata.success ||
    parsedMetadata.data.darsDegreeAuditReportId === null
  ) {
    return capture(context, metadataScope, metadataUrl, [], "failed", [
      {
        code: "saved_audit_metadata_shape",
        message:
          "A saved audit reference could not be validated; prior audits were retained.",
      },
    ]);
  }
  const metadata = parsedMetadata.data;
  const key = programKey(metadata);
  const scope = { kind: "audit_program" as const, key };
  const sourceUrl = `${origin}/api/dars/reports/${metadata.darsDegreeAuditReportId}`;
  const parsedReport = reportSchema.safeParse(input);
  if (!parsedReport.success || parsedReport.data.errorText.length) {
    return capture(context, scope, sourceUrl, [], "failed", [
      {
        code: "saved_audit_report_shape",
        message:
          "The saved audit report could not be recognized or contains a report error; prior audits were retained.",
      },
    ]);
  }
  const report = parsedReport.data;
  if (
    report.header.darsDegreeProgramCode.trim() !==
      metadata.darsDegreeProgramCode ||
    report.header.darsCatalogYearTerm.trim() !==
      metadata.darsCatalogYearTerm.trim()
  ) {
    return capture(context, scope, sourceUrl, [], "failed", [
      {
        code: "saved_audit_scope_mismatch",
        message:
          "The saved report did not match its program and catalog metadata; prior audits were retained.",
      },
    ]);
  }
  const blocks: NormalizedAuditBlock[] = [];
  const earnedByNode = new Map<
    string,
    { credits: number | null; gpa: number | null }
  >();
  const needsByNode = new Map<
    string,
    { credits: number | null; courses: number | null }
  >();
  let rejected = 0,
    truncated = false;
  const add = (block: NormalizedAuditBlock) => {
    if (blocks.length >= 9000) {
      truncated = true;
      return;
    }
    if (block.kind !== "layout" && block.quote.length > 2000) {
      block.quote = block.quote.slice(0, 2000);
      truncated = true;
    }
    blocks.push(block);
  };
  const unknown = (blockId: string, quote: string) =>
    add({
      kind: "unknown",
      blockId,
      quote: quote || "Unrecognized audit block.",
    });
  const title = [
    report.header.degreeProgramTitle1,
    report.header.degreeProgramTitle2 ?? "",
  ]
    .map(text)
    .filter(Boolean)
    .join(" ");
  const localGeneratedAt = sortableTimestamp(metadata.darsAuditRunDate);
  const programQuote = `${title || "Saved degree audit"}${localGeneratedAt ? `; Report generation time: ${localGeneratedAt} (timezone unverified).` : ""}`;
  add({
    kind: "heading",
    blockId: "program",
    nodeId: "program",
    parentId: null,
    title: title.slice(0, 500) || "Saved degree audit",
    rawStatus: null,
    flags: [],
    quote: programQuote,
  });
  for (let ri = 0; ri < report.requirements.length; ri++) {
    const result = requirementSchema.safeParse(report.requirements[ri]);
    const requirementId = `requirement-${ri}`;
    if (!result.success) {
      rejected++;
      unknown(requirementId, "Unrecognized requirement structure.");
      continue;
    }
    const requirement = result.data;
    // The UW renderer explicitly excludes the symbol legend from requirements.
    if (requirement.requirementName === "LEGEND") continue;
    const contents = requirement.requirementContents.map((block) =>
      blockSchema.safeParse(block),
    );
    const titleLines = contents
      .flatMap((block) =>
        block.success &&
        ["okRequirementTitle", "noRequirementTitle", "hText"].includes(
          block.data.contentType,
        )
          ? (block.data.lines ?? [])
          : [],
      )
      .map(text)
      .filter(Boolean);
    const fullTitle = titleLines.join(" ");
    let current: Heading = {
      kind: "heading",
      blockId: requirementId,
      nodeId: requirementId,
      parentId: "program",
      title: (fullTitle || "Untitled audit requirement").slice(0, 500),
      rawStatus: rawStatus(requirement.status.status),
      flags: [
        ...new Set([
          ...flags(fullTitle),
          ...(["IP", "PL"].includes(requirement.status.status)
            ? [requirement.status.status]
            : []),
        ]),
      ],
      quote: fullTitle || "Untitled audit requirement",
    };
    add(current);
    if (
      !fullTitle ||
      !["OK", "NO", "NONE", "IP", "PL"].includes(requirement.status.status)
    )
      unknown(
        `${requirementId}-status`,
        "Requirement title or status was not recognized.",
      );
    for (let bi = 0; bi < contents.length; bi++) {
      const parsedBlock = contents[bi];
      const blockId = `${requirementId}-block-${bi}`;
      if (!parsedBlock.success) {
        rejected++;
        unknown(blockId, "Unrecognized content block structure.");
        continue;
      }
      const block = parsedBlock.data;
      const lines = (block.lines ?? []).map(text).filter(Boolean);
      if (
        [
          "okRequirementTitle",
          "noRequirementTitle",
          "hText",
          "blankLine",
        ].includes(block.contentType)
      )
        continue;
      if (
        ["okSubrequirementTLine", "noSubrequirementTLine"].includes(
          block.contentType,
        )
      ) {
        const heading = lines.join(" ");
        current = {
          kind: "heading",
          blockId,
          nodeId: blockId,
          parentId: requirementId,
          title: heading.slice(0, 500) || "Untitled audit subrequirement",
          rawStatus: null,
          flags: flags(heading),
          quote: heading || "Untitled audit subrequirement",
        };
        add(current);
        if (!heading)
          unknown(`${blockId}-empty`, "Subrequirement heading is empty.");
        continue;
      }
      if (
        ["okSubrequirementCourses", "noSubrequirementCourses"].includes(
          block.contentType,
        )
      ) {
        if (!block.subRequirementCourses)
          unknown(blockId, "Applied-course block is missing course rows.");
        for (const [ci, value] of (
          block.subRequirementCourses ?? []
        ).entries()) {
          const parsedCourse = courseSchema.safeParse(value);
          const courseBlockId = `${blockId}-course-${ci}`;
          if (!parsedCourse.success) {
            rejected++;
            unknown(courseBlockId, "Unrecognized applied-course row.");
            continue;
          }
          const course = parsedCourse.data;
          const grade = course.grade?.trim() ?? null;
          const courseFlags =
            grade === "PL"
              ? ["PL"]
              : ["INP", "TI", "IP"].includes(grade ?? "")
                ? ["IP"]
                : [];
          const credits = decimal(course.credits);
          add({
            kind: "applied",
            blockId: courseBlockId,
            course: text(course.course),
            term: course.term?.trim() ?? "",
            credits,
            grade,
            flags: courseFlags,
            quote: [course.term, course.course, course.credits, course.grade]
              .filter((part): part is string => part !== null)
              .map(text)
              .join(" | "),
          });
          if (course.credits !== null && credits === null)
            unknown(
              `${courseBlockId}-credits`,
              "Applied credits could not be interpreted.",
            );
          if (course.courseNote)
            unknown(`${courseBlockId}-note`, text(course.courseNote));
        }
        continue;
      }
      if (
        /^(ok|no)(?:Subrequirement|Requirement)EarnedLine$/.test(
          block.contentType,
        )
      ) {
        for (const [li, line] of lines.entries()) {
          // IN-P and PL amounts are contingent credits, never earned totals.
          const lineFlags = flags(line);
          current.flags = [
            ...new Set([
              ...current.flags,
              ...lineFlags.filter((flag) => flag === "IP" || flag === "PL"),
            ]),
          ];
          const earned =
            /\bEARNED\s*:\s*(\d+(?:\.\d+)?)\s+(?:CREDITS?|HOURS?)\b/i.exec(
              line,
            );
          const gpa = /(?:^|\s)(\d+(?:\.\d+)?)\s+GPA\b/i.exec(line);
          const credits = earned ? decimal(earned[1]) : null;
          const gradePoint = gpa && Number(gpa[1]) <= 4 ? Number(gpa[1]) : null;
          if (credits !== null || gradePoint !== null) {
            const prior = earnedByNode.get(current.nodeId);
            const earned = {
              credits: credits ?? prior?.credits ?? null,
              gpa: gradePoint ?? prior?.gpa ?? null,
            };
            earnedByNode.set(current.nodeId, earned);
            add({
              kind: "earned",
              blockId: `${blockId}-${li}`,
              ...earned,
              quote: line,
            });
          } else unknown(`${blockId}-${li}`, line);
        }
        if (!lines.length) unknown(blockId, "Earned-summary block is empty.");
        continue;
      }
      if (
        [
          "okRequirementNeedsLine",
          "noRequirementNeedsLine",
          "okSubrequirementNeedsSummaryLine",
          "noSubrequirementNeedsSummaryLine",
        ].includes(block.contentType)
      ) {
        for (const [li, line] of lines.entries()) {
          const creditMatch =
            /\bNEEDS\s*:[^:]*?\b(\d+(?:\.\d+)?)\s+(?:CREDITS?|HOURS?)\b/i.exec(
              line,
            );
          const courseMatch = /\bNEEDS\s*:[^:]*?\b(\d+)\s+COURSES?\b/i.exec(
            line,
          );
          const credits = creditMatch ? decimal(creditMatch[1]) : null;
          const courses = courseMatch ? Number(courseMatch[1]) : null;
          // A count of subrequirements is not a count of courses.
          if (credits !== null || courses !== null) {
            const prior = needsByNode.get(current.nodeId);
            const needs = {
              credits: credits ?? prior?.credits ?? null,
              courses: courses ?? prior?.courses ?? null,
            };
            needsByNode.set(current.nodeId, needs);
            add({
              kind: "needs",
              blockId: `${blockId}-${li}`,
              ...needs,
              quote: line,
            });
          } else unknown(`${blockId}-${li}`, line);
        }
        if (!lines.length) unknown(blockId, "Needs-summary block is empty.");
        continue;
      }
      if (
        [
          "okSubrequirementAcceptCourses",
          "noSubrequirementAcceptCourses",
        ].includes(block.contentType)
      ) {
        const quote = lines.join(" ");
        const list = /^SELECT FROM\s*:\s*(.*)$/i.exec(quote);
        if (list) add({ kind: "select_from", blockId, text: list[1], quote });
        else unknown(blockId, quote);
        continue;
      }
      if (lines.length)
        for (const [li, line] of lines.entries())
          unknown(`${blockId}-${li}`, line);
      else unknown(blockId, "Unrecognized audit content type.");
    }
  }
  const parsed = parseNormalizedAuditBlocks(
    blocks,
    buildCourseIdentityTable(context.subjects),
    context.currentTermCode,
  );
  // Dropped/withdrawn or unclassified attempts cannot support a completed requirement.
  for (const node of parsed.nodes) {
    if (
      node.appliedCourses.some((course) =>
        ["dropped", "withdrawn", "unknown"].includes(course.state),
      )
    ) {
      node.coverage = "partial";
      if (node.status === "completed") node.status = "unknown";
    }
  }
  const byId = new Map(parsed.nodes.map((node) => [node.nodeId, node]));
  for (const node of parsed.nodes.filter(
    (node) => node.coverage !== "complete",
  )) {
    let parent = node.parentId;
    for (let depth = 0; parent && depth < 32; depth++) {
      const ancestor = byId.get(parent);
      if (!ancestor) break;
      ancestor.coverage = "partial";
      if (ancestor.status === "completed") ancestor.status = "unknown";
      parent = ancestor.parentId;
    }
  }
  const generatedAt = knownTimestamp(metadata.darsAuditRunDate);
  const diagnostics: PlanningCapture["diagnostics"] = [];
  if (!generatedAt)
    diagnostics.push({
      code: "saved_audit_time_unverified",
      message:
        "The report generation time has no verified timezone; refresh time is not report generation time.",
    });
  if (rejected)
    diagnostics.push({
      code: "saved_audit_rejected_blocks",
      message: `${rejected} audit blocks could not be validated. Their values were excluded from diagnostics.`,
    });
  if (truncated)
    diagnostics.push({
      code: "saved_audit_bounds",
      message:
        "The report exceeded a normalization limit; only bounded evidence was retained.",
    });
  const partial =
    parsed.coverage !== "complete" ||
    parsed.nodes.some((node) => node.coverage !== "complete") ||
    !generatedAt ||
    rejected > 0 ||
    truncated ||
    !report.requirements.length;
  if (partial)
    diagnostics.push({
      code: "saved_audit_partial",
      message:
        "Some saved audit content or its generation time could not be interpreted. Unrecognized requirement evidence remains local and does not establish completion.",
    });
  if (partial && parsed.nodes[0]) {
    parsed.nodes[0].coverage = "partial";
    if (parsed.nodes[0].status === "completed")
      parsed.nodes[0].status = "unknown";
  }
  const audit = planningAuditSchema.safeParse({
    id: `saved-${key}`,
    kind: "audit",
    programKey: key,
    generatedAt,
    catalogTerm: /^\d{4}[123]$/.test(metadata.darsCatalogYearTerm)
      ? metadata.darsCatalogYearTerm
      : null,
    coverage: partial ? "partial" : "complete",
    nodes: parsed.nodes,
    provenance: { sourceUrl, observedAt: context.observedAt, scope },
  });
  if (!audit.success)
    return capture(context, scope, sourceUrl, [], "failed", [
      {
        code: "saved_audit_normalization_failed",
        message:
          "The saved report could not form a valid requirement tree; prior audit evidence was retained.",
      },
    ]);
  return capture(
    context,
    scope,
    sourceUrl,
    [audit.data],
    partial ? "partial" : "complete",
    diagnostics,
  );
}

function unavailable(
  context: UwSavedAuditContext,
  scope: PlanningCapture["scope"],
  sourceUrl: string,
  result?: Exclude<UwPlanningReadResult, { status: "ok" }>,
): PlanningCapture {
  const status =
    result?.status === "needs_sign_in" || result?.status === "forbidden"
      ? "blocked"
      : result?.status === "unsupported"
        ? "unsupported"
        : "failed";
  return capture(context, scope, sourceUrl, [], status, [
    {
      code: "saved_audit_read_unavailable",
      message:
        "Saved audits could not be read; existing audit evidence was retained. Reconnect UW if access expired.",
    },
  ]);
}

/** Reads only saved report metadata and GET report descriptors; never requests a new audit. */
export async function pullUwSavedAudits(
  client: Pick<UwPlanningHttp, "read">,
  options: UwSavedAuditContext & { signal?: AbortSignal },
): Promise<PlanningCapture[]> {
  const context = checkedContext(options);
  options.signal?.throwIfAborted();
  let list: UwPlanningReadResult;
  try {
    list = await client.read({ kind: "audit-metadata" }, options.signal);
  } catch {
    options.signal?.throwIfAborted();
    return [unavailable(context, metadataScope, metadataUrl)];
  }
  options.signal?.throwIfAborted();
  if (list.status !== "ok")
    return [unavailable(context, metadataScope, metadataUrl, list)];
  if (!Array.isArray(list.data) || list.data.length > 1000)
    return [
      capture(context, metadataScope, metadataUrl, [], "failed", [
        {
          code: "saved_audit_metadata_shape",
          message:
            "Saved audit metadata could not be recognized; existing audits were retained.",
        },
      ]),
    ];
  const selected = new Map<string, Metadata>();
  const ambiguous = new Set<string>();
  let rejected = 0,
    pending = 0;
  for (const value of list.data) {
    const parsed = metadataSchema.safeParse(value);
    if (!parsed.success) {
      rejected++;
      continue;
    }
    const row = parsed.data;
    if (row.darsDegreeAuditReportId === null) {
      pending++;
      continue;
    }
    const key = programKey(row),
      prior = selected.get(key);
    if (!prior) {
      selected.set(key, row);
      continue;
    }
    if (prior.darsDegreeAuditReportId === row.darsDegreeAuditReportId) continue;
    const date = sortableTimestamp(row.darsAuditRunDate),
      priorDate = sortableTimestamp(prior.darsAuditRunDate);
    if (!date || !priorDate || date === priorDate) {
      ambiguous.add(key);
      continue;
    }
    if (date > priorDate) selected.set(key, row);
  }
  const captures: PlanningCapture[] = [];
  // A missing/pending report is not evidence that a previous program or audit was removed.
  if (!selected.size || rejected || pending)
    captures.push(
      capture(context, metadataScope, metadataUrl, [], "partial", [
        {
          code: "saved_audit_inventory_partial",
          message: `Saved report inventory: ${selected.size} program scopes, ${pending} pending reports, ${rejected} unrecognized entries. Absence does not establish removal.`,
        },
      ]),
    );
  for (const [key, metadata] of selected) {
    options.signal?.throwIfAborted();
    const scope = { kind: "audit_program" as const, key };
    const sourceUrl = `${origin}/api/dars/reports/${metadata.darsDegreeAuditReportId}`;
    if (ambiguous.has(key)) {
      captures.push(
        capture(context, scope, sourceUrl, [], "partial", [
          {
            code: "saved_audit_selection_ambiguous",
            message:
              "A unique latest saved report could not be established for this program; prior evidence was retained.",
          },
        ]),
      );
      continue;
    }
    try {
      const report = await client.read(
        {
          kind: "audit-report",
          reportId: String(metadata.darsDegreeAuditReportId),
        },
        options.signal,
      );
      options.signal?.throwIfAborted();
      captures.push(
        report.status === "ok"
          ? parseUwSavedAudit(report.data, { ...context, metadata })
          : unavailable(context, scope, sourceUrl, report),
      );
    } catch {
      options.signal?.throwIfAborted();
      captures.push(unavailable(context, scope, sourceUrl));
    }
  }
  return captures;
}
