import { createHash } from "node:crypto";
import { z } from "zod";
import {
  instant,
  resourceInputSchema,
  type ResourceInput,
  type IdentityPerson,
} from "@magic/contracts";
import { canvasContent, safeCanvasEvidenceUrl } from "./canvas-content";
import { CanvasFailure } from "./canvas-http";
import {
  courseAccessState,
  courseSelection,
  type CanvasSelectionOptions,
} from "./canvas-selection";
export const canvasId = z
  .union([
    z.number().int().positive().safe(),
    z.string().regex(/^[1-9]\d{0,29}$/),
  ])
  .transform(String);
const short = z.string().max(500),
  state = z.string().max(100),
  date = instant.nullable().optional(),
  html = z.string().max(1_000_000).nullable().optional();
const common = {
  created_at: date,
  updated_at: date,
  unlock_at: date,
  due_at: date,
  lock_at: date,
  workflow_state: state.optional(),
  html_url: z.string().max(4000).optional(),
};
export const courseSchema = z.object({
  id: canvasId,
  name: z.string().max(200).nullable().optional(),
  course_code: z.string().max(300).nullable().optional(),
  ...common,
  syllabus_body: html,
  start_at: date,
  end_at: date,
  concluded: z.boolean().optional(),
  access_restricted_by_date: z.boolean().optional(),
  // fix/current-courses-only: whether the course's own dates govern enrollment (Course object).
  restrict_enrollments_to_course_dates: z.boolean().nullable().optional(),
  term: z
    .object({
      id: canvasId.optional(),
      name: z.string().max(300).nullable().optional(),
      start_at: date,
      end_at: date,
    })
    .nullable()
    .optional(),
  enrollments: z
    .array(
      z.object({
        type: state.optional(), enrollment_state: state.optional(),
        // Transient identity check only. Course resources never retain this field.
        user_id: canvasId.optional(),
        computed_current_grade: z.string().max(100).nullable().optional(),
        computed_final_grade: z.string().max(100).nullable().optional(),
        computed_current_score: z.number().finite().nullable().optional(),
        computed_final_score: z.number().finite().nullable().optional(),
      }),
    )
    .max(500)
    .nullable()
    .optional(),
  calendar: z
    .object({ ics: z.string().max(4000).optional() })
    .nullable()
    .optional(),
  // include[]=teachers: only display names are kept, to retain them when scrubbing hosted payloads.
  teachers: z
    .array(z.object({ display_name: z.string().max(300).nullable().optional() }))
    .max(50)
    .nullable()
    .optional(),
});
export type CanvasCourse = z.infer<typeof courseSchema> & { historicalOnly?: boolean };
const rating = z.object({
  id: z.union([z.string(), z.number()]).transform(String).optional(),
  description: z.string().max(4000).optional(),
  long_description: z.string().max(20000).optional(),
  points: z.number().nullable().optional(),
});
const rubric = z
  .array(
    rating.extend({
      criterion_id: z
        .union([z.string(), z.number()])
        .transform(String)
        .optional(),
      ratings: z.array(rating).max(100).nullable().optional(),
    }),
  )
  .max(500)
  .nullable()
  .optional();
export const canvasSubmissionSchema = z.object({
  assignment_id: canvasId,
  user_id: canvasId.optional(),
  workflow_state: state.optional(),
  submitted_at: date,
  score: z.number().nullable().optional(),
  grade: z.string().max(100).nullable().optional(),
  late: z.boolean().optional(),
  missing: z.boolean().optional(),
  excused: z.boolean().nullable().optional(),
  submission_comments: z
    .array(z.object({ comment: z.string().max(20000), created_at: date }))
    .max(1000)
    .nullable()
    .optional(),
});
export const assignmentSchema = z.object({
  id: canvasId,
  course_id: canvasId,
  name: short.min(1),
  ...common,
  description: html.unwrap(),
  due_at: instant.nullable(),
  lock_at: instant.nullable(),
  points_possible: z.number().finite().nonnegative().nullable(),
  assignment_group_id: canvasId.nullable().optional(),
  submission_types: z.array(state).max(100).optional(),
  rubric,
  submission: canvasSubmissionSchema
    .partial({ assignment_id: true })
    .nullable()
    .optional(),
});
export const moduleSchema = z.object({
  id: canvasId,
  name: short.min(1),
  ...common,
  position: z.number().int().optional(),
  state: state.optional(),
  items_count: z.number().int().nonnegative().optional(),
  prerequisite_module_ids: z.array(canvasId).max(1000).optional(),
});
export const itemSchema = z.object({
  id: canvasId,
  module_id: canvasId.optional(),
  title: short.min(1),
  type: state,
  position: z.number().int().optional(),
  content_id: canvasId.optional(),
  page_url: z.string().max(300).optional(),
  external_url: z.string().max(4000).optional(),
  html_url: z.string().max(4000).optional(),
  completion_requirement: z
    .object({
      type: state,
      min_score: z.number().optional(),
      completed: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  content_details: z
    .object({
      ...common,
      points_possible: z.number().nullable().optional(),
      locked_for_user: z.boolean().optional(),
      lock_explanation: z.string().max(4000).optional(),
    })
    .optional(),
});
export const pageSchema = z.object({
  page_id: canvasId,
  url: z.string().regex(/^[a-zA-Z0-9_%.-]{1,256}$/),
  title: short.min(1),
  body: html,
  ...common,
  published: z.boolean().optional(),
  locked_for_user: z.boolean().optional(),
});
export const fileSchema = z.object({
  id: canvasId,
  folder_id: canvasId.optional(),
  display_name: z.string().min(1).max(500),
  filename: z.string().max(1000).optional(),
  "content-type": z.string().max(200).optional(),
  size: z.number().int().nonnegative().optional(),
  ...common,
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  locked_for_user: z.boolean().optional(),
});
export const folderSchema = z.object({
  id: canvasId,
  name: short.min(1),
  parent_folder_id: canvasId.nullable().optional(),
  ...common,
  files_count: z.number().int().nonnegative().optional(),
  folders_count: z.number().int().nonnegative().optional(),
});
export const groupSchema = z.object({
  id: canvasId,
  name: short.min(1),
  group_weight: z.number().optional(),
  position: z.number().int().optional(),
  rules: z
    .object({
      drop_lowest: z.number().int().nonnegative().optional(),
      drop_highest: z.number().int().nonnegative().optional(),
      never_drop: z.array(canvasId).max(1000).optional(),
    })
    .optional(),
});
export const quizSchema = z.object({
  id: canvasId,
  title: short.min(1),
  description: html,
  ...common,
  points_possible: z.number().nonnegative().nullable().optional(),
  assignment_id: canvasId.nullable().optional(),
  published: z.boolean().optional(),
});
export const discussionSchema = z.object({
  id: canvasId,
  title: short.min(1),
  message: html,
  // Returned by default on topics/announcements. Used only for the local scrubbing roster; never stored in resources.
  user_name: z.string().max(300).nullable().optional(),
  author: z.object({ display_name: z.string().max(300).nullable().optional() }).nullable().optional(),
  ...common,
  context_code: z.string().max(100).optional(),
  posted_at: date,
  published: z.boolean().optional(),
});
export const activitySchema = z.object({
  id: z.union([canvasId, z.string().min(1).max(100)]),
  title: short.optional(),
  message: html,
  description: html,
  ...common,
  type: state.optional(),
  course_id: canvasId.optional(),
  context_code: z.string().max(100).optional(),
  start_at: date,
  assignment: assignmentSchema.optional(),
});
export const todoSchema = z
  .object({
    type: state,
    course_id: canvasId.optional(),
    assignment: assignmentSchema.optional(),
    quiz: quizSchema.optional(),
    html_url: z.string().max(4000).optional(),
  })
  .refine((item) => Boolean(item.assignment || item.quiz), {
    path: ["assignment"],
    message: "Missing todo content",
  });
export const summarySchema = z.object({
  type: state,
  count: z.number().int().nonnegative(),
  unread_count: z.number().int().nonnegative(),
});
export function hashCanvas(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function courseName(course: CanvasCourse) {
  return course.name?.trim() || `Course ${course.id} (name unavailable)`;
}
function dates(
  raw:
    | z.infer<typeof moduleSchema>
    | z.infer<typeof assignmentSchema>
    | Record<string, unknown>,
) {
  return Object.fromEntries(
    [
      ["created_at", "createdAt"],
      ["updated_at", "updatedAt"],
      ["unlock_at", "unlockAt"],
      ["due_at", "dueAt"],
      ["lock_at", "lockAt"],
      ["workflow_state", "workflowState"],
    ]
      .filter(([key]) => Object.prototype.hasOwnProperty.call(raw, key!))
      .map(([from, to]) => [to, raw[from as keyof typeof raw]]),
  );
}
function deadlines(raw: Record<string, unknown>): ResourceInput["deadlines"] {
  return (
    [
      ["due_at", "due"],
      ["lock_at", "lock"],
    ] as const
  ).flatMap(([field, kind]) =>
    typeof raw[field] === "string"
      ? [
          {
            value: raw[field] as string,
            kind,
            quote: `${field}: ${raw[field]}`,
            authority: "structured" as const,
            scopeConfirmed: true,
          },
        ]
      : [],
  );
}
function base(
  course: CanvasCourse,
  origin: string,
  id: string,
  title: string,
  path: string,
  body?: string | null,
) {
  const url = `${origin}/courses/${course.id}/${path}`;
  return {
    externalId: id,
    courseId: course.id,
    courseName: courseName(course),
    title,
    url,
    ...canvasContent(body ?? "", url),
  };
}
export function courseResource(
  course: CanvasCourse,
  origin: string,
  selection: CanvasSelectionOptions,
  viewerId?: string,
): ResourceInput {
  // Canvas's course endpoint returns the requesting user's enrollments. When an
  // explicit user_id is present, corroborate it against the transient profile.
  // Preserve distinct enrollments and the distinction between current/final and
  // letter/score. Canvas gradebook claims are not transcript grades.
  const gradeEvidence = course.enrollments?.filter((enrollment) =>
    /^(?:student|StudentEnrollment)$/i.test(enrollment.type ?? "") &&
    (!enrollment.user_id || enrollment.user_id === viewerId) &&
    [enrollment.computed_current_grade, enrollment.computed_final_grade,
      enrollment.computed_current_score, enrollment.computed_final_score].some((value) => value !== undefined),
  ).map((enrollment) => ({
    enrollmentState: enrollment.enrollment_state,
    currentGrade: enrollment.computed_current_grade,
    finalGrade: enrollment.computed_final_grade,
    currentScore: enrollment.computed_current_score,
    finalScore: enrollment.computed_final_score,
  }));
  return resourceInputSchema.parse({
    ...base(course, origin, course.id, courseName(course), ""),
    kind: "course",
    ...dates(course),
    course: {
      accessState: courseAccessState(course, selection.currentTime),
      courseCode: course.course_code ?? undefined,
      termId: course.term?.id,
      termName: course.term?.name ?? undefined,
      workflowState: course.workflow_state,
      accessRestricted: course.access_restricted_by_date,
      startAt: course.start_at,
      endAt: course.end_at,
      selection: courseSelection(course, selection),
      gradeEvidence: gradeEvidence?.length ? gradeEvidence : undefined,
      instructors: instructorNames(course),
    },
  });
}
function instructorNames(course: CanvasCourse) {
  const names = [...new Set((course.teachers ?? []).map((t) => t.display_name?.trim()).filter((n): n is string => !!n))];
  return names.length ? names : undefined;
}
export function assignmentResource(
  raw: z.infer<typeof assignmentSchema>,
  course: CanvasCourse,
  origin: string,
  collectComments = true,
): ResourceInput {
  if (raw.course_id !== course.id)
    throw new CanvasFailure("partial", "course_id_mismatch");
  const submission = raw.submission;
  if (submission?.assignment_id && submission.assignment_id !== raw.id)
    throw new CanvasFailure("partial", "submission_assignment_id_mismatch");
  const submitted =
    submission?.submitted_at ||
    ["submitted", "pending_review"].includes(submission?.workflow_state ?? "")
      ? true
      : submission?.workflow_state === "unsubmitted"
        ? false
        : null;
  const mapRating = (value: z.infer<typeof rating>) => ({
    id: value.id,
    description: value.description,
    longDescription: value.long_description,
    points: value.points,
  });
  return resourceInputSchema.parse({
    ...base(
      course,
      origin,
      raw.id,
      raw.name,
      `assignments/${raw.id}`,
      raw.description,
    ),
    kind: "assignment",
    ...dates(raw),
    deadlines: deadlines(raw),
    points: raw.points_possible,
    submitted,
    submissionTypes: raw.submission_types,
    assignmentGroupId: raw.assignment_group_id,
    rubric:
      raw.rubric?.map((row) => ({
        ...mapRating(row),
        criterionId: row.criterion_id,
        ratings: row.ratings?.map(mapRating),
      })) ?? raw.rubric,
    submission: submission
      ? submissionEvidence(submission, origin, collectComments)
      : submission,
  });
}
export function moduleResource(
  raw: z.infer<typeof moduleSchema>,
  course: CanvasCourse,
  origin: string,
): ResourceInput {
  return resourceInputSchema.parse({
    ...base(course, origin, raw.id, raw.name, `modules/${raw.id}`),
    kind: "material",
    ...dates(raw),
    module: {
      id: raw.id,
      position: raw.position,
      state: raw.state,
      prerequisiteModuleIds: raw.prerequisite_module_ids,
      unlockAt: raw.unlock_at,
      itemsCount: raw.items_count,
    },
  });
}
export function itemResource(
  raw: z.infer<typeof itemSchema>,
  course: CanvasCourse,
  origin: string,
  moduleId?: string,
): ResourceInput {
  const content = raw.content_details,
    externalUrl = safeCanvasEvidenceUrl(raw.external_url, origin);
  const row = base(
    course,
    origin,
    raw.id,
    raw.title,
    `modules/items/${raw.id}`,
  );
  if (externalUrl) row.links.push({ url: externalUrl });
  if (raw.page_url)
    row.links.push({
      url: `${origin}/courses/${course.id}/pages/${encodeURIComponent(raw.page_url)}`,
    });
  return resourceInputSchema.parse({
    ...row,
    kind: "material",
    ...dates(content ?? {}),
    deadlines: deadlines(content ?? {}),
    points: content?.points_possible,
    moduleItem: {
      type: raw.type,
      title: raw.title,
      position: raw.position,
      externalUrl,
      pageUrl: raw.page_url,
      moduleId: raw.module_id ?? moduleId,
      contentId: raw.content_id,
      dueAt: content?.due_at,
      points: content?.points_possible,
      completionRequirement: raw.completion_requirement
        ? {
            type: raw.completion_requirement.type,
            minScore: raw.completion_requirement.min_score,
            completed: raw.completion_requirement.completed,
          }
        : undefined,
      lockInfo: content
        ? {
            unlockAt: content.unlock_at,
            lockAt: content.lock_at,
            locked: content.locked_for_user,
            explanation: content.lock_explanation,
          }
        : undefined,
    },
  });
}
export function pageResource(
  raw: z.infer<typeof pageSchema>,
  course: CanvasCourse,
  origin: string,
): ResourceInput {
  return resourceInputSchema.parse({
    ...base(
      course,
      origin,
      raw.page_id,
      raw.title,
      `pages/${encodeURIComponent(raw.url)}`,
      raw.body,
    ),
    kind: "material",
    ...dates(raw),
  });
}
export function fileResource(
  raw: z.infer<typeof fileSchema>,
  course: CanvasCourse,
  origin: string,
): ResourceInput {
  return resourceInputSchema.parse({
    ...base(course, origin, raw.id, raw.display_name, `files/${raw.id}`),
    kind: "material",
    ...dates(raw),
    file: {
      id: raw.id,
      folderId: raw.folder_id,
      displayName: raw.display_name,
      contentType: raw["content-type"],
      size: raw.size,
      updatedAt: raw.updated_at,
      locked: raw.locked_for_user ?? raw.locked,
      hidden: raw.hidden,
    },
  });
}
export function folderResource(
  raw: z.infer<typeof folderSchema>,
  course: CanvasCourse,
  origin: string,
): ResourceInput {
  return resourceInputSchema.parse({
    ...base(course, origin, raw.id, raw.name, `files/folder/${raw.id}`),
    kind: "material",
    ...dates(raw),
  });
}
export function groupResource(
  raw: z.infer<typeof groupSchema>,
  course: CanvasCourse,
  origin: string,
): ResourceInput {
  return resourceInputSchema.parse({
    ...base(course, origin, raw.id, raw.name, "assignments"),
    kind: "material",
    assignmentGroup: {
      weight: raw.group_weight,
      position: raw.position,
      rules: raw.rules
        ? {
            dropLowest: raw.rules.drop_lowest,
            dropHighest: raw.rules.drop_highest,
            neverDrop: raw.rules.never_drop,
          }
        : undefined,
    },
  });
}
export function quizResource(
  raw: z.infer<typeof quizSchema>,
  course: CanvasCourse,
  origin: string,
): ResourceInput {
  return resourceInputSchema.parse({
    ...base(
      course,
      origin,
      raw.id,
      raw.title,
      `quizzes/${raw.id}`,
      raw.description,
    ),
    kind: "assignment",
    ...dates(raw),
    points: raw.points_possible,
    deadlines: deadlines(raw),
  });
}
export function discussionResource(
  raw: z.infer<typeof discussionSchema>,
  course: CanvasCourse,
  origin: string,
): ResourceInput {
  if (raw.context_code && raw.context_code !== `course_${course.id}`)
    throw new CanvasFailure("partial", "course_id_mismatch");
  return resourceInputSchema.parse({
    ...base(
      course,
      origin,
      raw.id,
      raw.title,
      `discussion_topics/${raw.id}`,
      raw.message,
    ),
    kind: "message",
    ...dates(raw),
    deadlines: deadlines(raw),
  });
}
export function activityResource(
  raw: z.infer<typeof activitySchema>,
  course: CanvasCourse,
  origin: string,
): ResourceInput {
  if (raw.assignment) return assignmentResource(raw.assignment, course, origin);
  const row = base(
    course,
    origin,
    raw.id,
    raw.title || raw.type || "Course activity",
    "",
    raw.message ?? raw.description,
  );
  return resourceInputSchema.parse({
    ...row,
    url: safeCanvasEvidenceUrl(raw.html_url, origin) ?? row.url,
    kind: raw.start_at ? "event" : "message",
    ...dates(raw),
    deadlines: raw.start_at
      ? [
          {
            value: raw.start_at,
            kind: "event",
            quote: `start_at: ${raw.start_at}`,
            authority: "structured",
            scopeConfirmed: true,
          },
        ]
      : [],
  });
}

export function submissionEvidence(
  raw: Partial<z.infer<typeof canvasSubmissionSchema>>,
  origin: string,
  collectComments = true,
) {
  return {
    workflowState: raw.workflow_state,
    submittedAt: raw.submitted_at,
    score: raw.score,
    grade: raw.grade,
    late: raw.late,
    missing: raw.missing,
    excused: raw.excused ?? undefined,
    comments: collectComments
      ? raw.submission_comments?.map((comment) => ({
          text: canvasContent(comment.comment, origin).text,
          createdAt: comment.created_at,
        }))
      : undefined,
  };
}
/** Poster display name of a topic/announcement, unless it is a course teacher. */
export function discussionAuthor(
  raw: z.infer<typeof discussionSchema>,
  course: CanvasCourse,
): string | undefined {
  const name = (raw.author?.display_name ?? raw.user_name)?.trim();
  if (!name || name.length < 2) return undefined;
  const teachers = new Set(instructorNames(course)?.map((n) => n.toLocaleLowerCase()));
  return teachers.has(name.toLocaleLowerCase()) ? undefined : name;
}
export const profileSchema = z.object({
  id: canvasId,
  name: z.string().max(300).nullable().optional(),
  short_name: z.string().max(300).nullable().optional(),
  sortable_name: z.string().max(300).nullable().optional(),
  login_id: z.string().max(320).nullable().optional(),
  primary_email: z.string().max(320).nullable().optional(),
});
/**
 * The student's own identity for the local scrubbing roster only. Never part
 * of a capture batch. "Last, First" sortable names are reordered; a login or
 * UW email local part that looks like a NetID is kept as a NetID.
 */
export function profileIdentity(raw: z.infer<typeof profileSchema>): IdentityPerson | undefined {
  const clean = (v: string | null | undefined) => v?.normalize("NFKC").trim() || undefined;
  const sortable = clean(raw.sortable_name)?.match(/^([^,]+),\s*(.+)$/);
  const names = [clean(raw.name), clean(raw.short_name), sortable ? `${sortable[2]} ${sortable[1]}` : clean(raw.sortable_name)]
    .filter((n): n is string => !!n && n.length >= 2 && n.length <= 200);
  const login = clean(raw.login_id), email = clean(raw.primary_email);
  const emails = [login, email].filter((v): v is string => !!v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v));
  const netIds = [login, ...emails.filter((e) => /@wisc\.edu$/i.test(e)).map((e) => e.split("@")[0])]
    .filter((v): v is string => !!v && /^[A-Za-z][A-Za-z0-9]{1,15}$/.test(v));
  const person = {
    names: [...new Set(names)].slice(0, 10),
    emails: [...new Set(emails.map((e) => e.toLowerCase()))].slice(0, 10),
    netIds: [...new Set(netIds.map((n) => n.toLowerCase()))].slice(0, 10),
    studentIds: [],
  };
  return person.names.length || person.emails.length || person.netIds.length ? person : undefined;
}
