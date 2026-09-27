import type { CanvasFetch } from "./canvas-http";

export interface SyntheticUniversityOptions {
  revision?: 1 | 2 | 3;
  expireDuringPagination?: boolean;
  rateLimit?: boolean;
  malformedAssignment?: boolean;
  pageCount?: number;
  origin?: string;
}
/** Entirely fabricated university; no captured identities, URLs, cookies or coursework. */
export function createSyntheticCanvasUniversity(
  options: SyntheticUniversityOptions = {},
) {
  const origin = options.origin ?? "https://canvas.synthetic.test",
    revision = options.revision ?? 1;
  const calls: Array<{
    url: string;
    method: string;
    credentials: RequestCredentials | undefined;
    headers: Headers;
  }> = [];
  let rateSent = false,
    expired = false,
    active = 0,
    maxActive = 0;
  const codes = [
    "COMP SCI 577",
    "MATH 340",
    "HISTORY 201",
    "CHEM 103",
    "ENGLISH 120",
  ];
  const courses = [
    ...codes.map((code, index) => ({
      id: 101 + index,
      name: `${code} — Synthetic course`,
      course_code: code,
      workflow_state: "available",
      enrollments: [{ type: "student", enrollment_state: "active" }],
      term: { id: 10, name: "Fall 2026 to 2027" },
      syllabus_body: `<p>Synthetic course syllabus.</p><a href="https://courses.synthetic.test/${101 + index}/">Course site</a>`,
    })),
    ...[
      "Student Society",
      "Orientation",
      "Career Fair",
      "Advising",
      "Training Sandbox",
    ].map((name, index) => ({
      id: 201 + index,
      name,
      course_code: name,
      workflow_state: "available",
      enrollments: [{ type: "student", enrollment_state: "active" }],
      term: { id: 1, name: "Ongoing" },
      syllabus_body: "",
    })),
    { id: 301, access_restricted_by_date: true, workflow_state: "unpublished" },
  ];
  const assignment = (courseId: number, id: number) => ({
    id,
    course_id: courseId,
    name: `Synthetic assignment ${id}`,
    description:
      courseId === 101
        ? ""
        : `<p>Explain the course concepts.</p><a href="/courses/${courseId}/pages/spec">Full instructions</a>`,
    created_at: "2026-09-01T12:00:00Z",
    updated_at: revision > 1 ? "2026-09-27T12:00:00Z" : "2026-09-25T12:00:00Z",
    due_at:
      revision > 1 && courseId === 101
        ? "2026-10-02T23:00:00Z"
        : "2026-09-29T23:00:00Z",
    unlock_at: null,
    lock_at: null,
    points_possible: 20,
    assignment_group_id: 11,
    submission_types: ["online_upload"],
    workflow_state: "published",
    rubric: [
      {
        id: "analysis",
        description:
          revision > 1
            ? "Explain and justify assumptions"
            : "Explain assumptions",
        points: 20,
        ratings: null,
      },
    ],
    submission: {
      assignment_id: id,
      workflow_state:
        revision > 1 && courseId === 102 ? "graded" : "unsubmitted",
      submitted_at:
        revision > 1 && courseId === 102 ? "2026-09-26T12:00:00Z" : null,
      score: revision > 1 && courseId === 102 ? 18 : null,
      grade: revision > 1 && courseId === 102 ? "18" : null,
      late: false,
      missing: false,
      excused: false,
    },
  });
  const json = (
    data: unknown,
    status = 200,
    extra: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "content-type": "application/json",
        "x-rate-limit-remaining": "650",
        "x-request-cost": "0.5",
        ...extra,
      },
    });
  const fetch: CanvasFetch = async (input, init) => {
    const url = new URL(input);
    calls.push({
      url: input,
      method: init?.method ?? "GET",
      credentials: init?.credentials,
      headers: new Headers(init?.headers),
    });
    if (url.origin !== origin)
      throw new Error("Synthetic Canvas client received outside request");
    if (
      init?.method !== "GET" ||
      init.credentials !== "include" ||
      new Headers(init.headers).has("authorization") ||
      new Headers(init.headers).has("cookie")
    )
      throw new Error("Unexpected session boundary");
    active++;
    maxActive = Math.max(active, maxActive);
    try {
      await Promise.resolve();
      if (expired) return json({ status: "unauthenticated", errors: [{ message: "user authorization required" }] }, 401);
      const path = url.pathname;
      if (path === "/api/v1/users/self/profile")
        return json({
          id: 9001,
          name: "Synthetic student - should not be stored",
          primary_email: "never-store@example.test",
        });
      if (path === "/api/v1/courses") return json(courses);
      if (path === "/api/v1/users/self/todo")
        return json([
          {
            type: "submitting",
            course_id: 101,
            assignment: assignment(101, 1001),
          },
        ]);
      if (path === "/api/v1/users/self/upcoming_events")
        return json([
          {
            id: "assignment_1001",
            context_code: "course_101",
            title: "Upcoming assignment",
            start_at: "2026-09-29T23:00:00Z",
            assignment: assignment(101, 1001),
          },
        ]);
      if (path === "/api/v1/users/self/activity_stream")
        return json([
          {
            id: 99,
            type: "DiscussionTopic",
            course_id: 102,
            title: "Weekly discussion",
            message: "<p>Use course evidence.</p>",
          },
        ]);
      if (path === "/api/v1/users/self/activity_stream/summary")
        return json([
          { type: "DiscussionTopic", count: revision, unread_count: revision },
        ]);
      if (path === "/api/v1/announcements") {
        const id = Number(
          url.searchParams.get("context_codes[]")?.replace("course_", ""),
        );
        return json([
          {
            id: id * 10,
            title: "Course announcement",
            context_code: `course_${id}`,
            message: `<p>See <a href="https://courses.synthetic.test/${id}/spec.html">the spec</a>.</p>`,
            posted_at: "2026-09-25T12:00:00Z",
          },
        ]);
      }
      const match = path.match(/^\/api\/v1\/courses\/(\d+)(.*)$/);
      if (!match) return json({}, 404);
      const courseId = Number(match[1]),
        tail = match[2]!;
      if (courseId < 101 || courseId > 105)
        throw new Error("Excluded course was requested");
      if (!tail)
        return json({
          ...courses.find((course) => course.id === courseId),
          calendar: {
            ics: `${origin}/feeds/calendars/course_SYNTHETIC_CAPABILITY_${courseId}.ics`,
          },
        });
      if (tail === "/assignments") {
        if (options.rateLimit !== false && courseId === 102 && !rateSent) {
          rateSent = true;
          return json({ errors: [{ message: "Rate limit exceeded" }] }, 429, {
            "retry-after": "0",
            "x-rate-limit-remaining": "90",
          });
        }
        const page = Number(url.searchParams.get("page") ?? 1),
          pageCount = courseId === 105 ? (options.pageCount ?? 3) : 1;
        if (options.expireDuringPagination && courseId === 105 && page === 2) {
          expired = true;
          return json({ status: "unauthenticated", errors: [{ message: "user authorization required" }] }, 401);
        }
        const id = courseId === 105 ? 5000 + page : 1000 + courseId - 100;
        const rows: unknown[] =
          courseId === 105
            ? Array.from({ length: page < pageCount ? 100 : 5 }, (_, index) =>
                assignment(courseId, 5000 + (page - 1) * 100 + index + 1),
              )
            : [assignment(courseId, id)];
        if (courseId === 101 && (revision === 1 || revision === 3))
          rows.push(assignment(courseId, 1099));
        if (options.malformedAssignment && courseId === 103)
          rows.push({
            ...assignment(courseId, 9999),
            due_at: "INVALID_PRIVATE_VALUE",
          });
        return json(
          rows,
          200,
          page < pageCount
            ? {
                link: `<${origin}${path}?per_page=100&include[]=submission&order_by=due_at&page=${page + 1}>; rel="next"`,
              }
            : {},
        );
      }
      if (tail === "/students/submissions")
        return json([
          {
            assignment_id: 1000 + courseId - 100,
            user_id: 9001,
            workflow_state: "graded",
            submitted_at: null,
            score: 18,
            grade: "18",
            submission_comments: [
              {
                comment: "Private synthetic feedback: explain the last step.",
                created_at: "2026-09-26T12:00:00Z",
                author_id: 888,
              },
            ],
          },
        ]);
      if (tail === "/modules")
        return json([
          {
            id: 1,
            name: "Week one",
            position: 1,
            items_count: 2,
            state: "unlocked",
          },
        ]);
      if (tail === "/modules/1/items")
        return json([
          {
            id: 2,
            module_id: 1,
            type: "Page",
            title: "Full assignment spec",
            page_url: "spec",
            content_details: {
              due_at: "2026-09-29T23:00:00Z",
              points_possible: 20,
            },
            completion_requirement: { type: "must_view", completed: false },
          },
          {
            id: 3,
            module_id: 1,
            type: "ExternalUrl",
            title: "Course website",
            external_url: `https://courses.synthetic.test/${courseId}/spec.html`,
          },
        ]);
      if (tail === "/pages")
        return json([
          {
            page_id: 7,
            url: "spec",
            title: "Full assignment specification",
            updated_at:
              revision > 1 ? "2026-09-27T12:00:00Z" : "2026-09-25T12:00:00Z",
          },
          {
            page_id: 8,
            url: "unreferenced",
            title: "Unreferenced page",
            updated_at: "2026-09-25T12:00:00Z",
          },
        ]);
      if (tail === "/pages/unreferenced")
        return json({
          page_id: 8,
          url: "unreferenced",
          title: "Unreferenced page",
          updated_at: "2026-09-25T12:00:00Z",
          body: "<p>Additional course guidance available outside the module list.</p>",
        });
      if (tail === "/pages/spec")
        return json({
          page_id: 7,
          url: "spec",
          title: "Full assignment specification",
          updated_at:
            revision > 1 ? "2026-09-27T12:00:00Z" : "2026-09-25T12:00:00Z",
          body: `<h1>Complete specification</h1><p>Explain the method, show your steps, and cite course evidence.</p><a href="https://courses.synthetic.test/${courseId}/spec.html">Extended requirements</a><a href="${origin}/courses/${courseId}/files/9?verifier=SYNTHETIC_DOWNLOAD_SECRET">PDF</a>`,
        });
      if (tail === "/files")
        return json([
          {
            id: 9,
            folder_id: 1,
            display_name: "Course reading.pdf",
            size: 128,
            "content-type": "application/pdf",
            updated_at: "2026-09-25T12:00:00Z",
            url: `https://downloads.synthetic.test/reading.pdf?signature=SYNTHETIC_DOWNLOAD_SECRET`,
          },
        ]);
      if (tail === "/folders")
        return json([
          { id: 1, name: "Readings", files_count: 1, folders_count: 0 },
        ]);
      if (tail === "/assignment_groups")
        return json([
          {
            id: 11,
            name: "Homework",
            group_weight: 40,
            rules: { drop_lowest: 1, drop_highest: 0, never_drop: [1001] },
          },
        ]);
      if (tail === "/quizzes")
        return json([
          {
            id: 4,
            title: "Practice quiz",
            description: "<p>Practice concepts.</p>",
            due_at: null,
            points_possible: 10,
          },
        ]);
      if (tail === "/discussion_topics")
        return json([
          {
            id: 5,
            title: "Explain your approach",
            message: "<p>Bring an example.</p>",
          },
        ]);
      return json({}, 404);
    } finally {
      active--;
    }
  };
  return {
    fetch,
    calls,
    courses,
    origin,
    stats: () => ({ requests: calls.length, maxActive, rateSent, expired }),
  };
}
