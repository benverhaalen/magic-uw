/**
 * owner: drain. A synthetic workspace sized like the live one (≥ 2,000 resources over 7 courses),
 * shaped like a real Canvas capture: course records, modules and their items, pages whose bodies
 * link to each other and name course files, files (some with extracted text), assignments with
 * links and due dates around NOW, quizzes, announcements, discussions, a syllabus, account-level
 * duplicates, and a calendar feed with timed lectures, labs and discussions (note sessions).
 * Deterministic; every title, URL and body is invented.
 */
import type { CaptureBatch, ResourceInput } from "@magic/contracts";

export const BIG_ACCOUNT = "student-big";
export const BIG_NOW = "2026-10-01T15:00:00.000Z";
const TOPICS = ["Vectors", "Matrices", "Determinants", "Eigenvalues", "Orthogonality", "Least squares", "Markov chains", "Graphs", "Recursion", "Sorting", "Hashing", "Trees", "Probability", "Sampling"];

type Item = Partial<ResourceInput> & Pick<ResourceInput, "externalId" | "kind" | "title" | "url">;
const day = (offset: number, time = "05:00:00.000Z") => {
  const d = new Date(Date.parse("2026-09-02T00:00:00.000Z") + offset * 86_400_000);
  return `${d.toISOString().slice(0, 10)}T${time}`;
};

function paragraph(c: number, i: number, links: string[]): string {
  const topic = TOPICS[(c + i) % TOPICS.length]!;
  const lines = [
    `${topic} notes, part ${i}`,
    `Definition: ${topic.toLowerCase()} basis — a set of objects that spans the space and is independent.`,
    `A ${topic.toLowerCase()} kernel is defined as the set of inputs mapped to zero by the operator.`,
    `The result is called the spectral radius.`,
    `x = a + b * c`,
    `y = sqrt(x) + log(2)`,
    `Worked example on Oct ${(i % 27) + 1}; problems due by 10/${(i % 27) + 2}.`,
    `See ${links.join(" and ")} before class.`,
  ];
  // Body text of a few KB, like an extracted page or handout.
  const filler = Array.from({ length: 12 }, (_, k) => `Step ${k + 1}: apply the ${topic.toLowerCase()} rule to case ${k} and check the invariant holds.`);
  return [...lines, ...filler].join("\n");
}

export function bigWorkspaceBatches(courses = 7): CaptureBatch[] {
  const out: CaptureBatch[] = [];
  for (let c = 0; c < courses; c++) {
    const courseId = String(301 + c);
    const base = `https://canvas.wisc.edu/courses/${courseId}`;
    const courseName = `MATH ${301 + c}: Synthetic Course ${c}`;
    const item = (value: Item): ResourceInput => ({
      courseId,
      courseName,
      text: "",
      deadlines: [],
      points: null,
      submitted: null,
      policy: { mode: "unknown", evidence: "" },
      ...value,
    });
    const batch = (scope: string, resources: ResourceInput[], kind = "canvas"): CaptureBatch => ({
      source: { id: `big-${courseId}-${scope}`, label: "Synthetic Canvas", kind: kind as "canvas", accountScope: BIG_ACCOUNT, courseId, scope },
      observedAt: "2026-09-30T12:00:00.000Z",
      complete: true,
      status: "ok",
      resources,
    });
    const weeks = TOPICS.length;
    const pageSlug = (w: number, k: number) => `week-${w}-notes-${k}`;
    const fileTitle = (w: number, k: number) =>
      [`Lecture ${w * 2 + k} slides.pdf`, `Reading chapter ${w + 1} part ${k}.pdf`, `Worksheet ${w}-${k}.pdf`, `figure ${w}-${k}.png`][k % 4]!;
    const fileId = (w: number, k: number) => `${courseId}${String(w).padStart(2, "0")}${k}`;

    out.push(
      batch("course", [
        item({
          externalId: courseId,
          kind: "course",
          title: courseName,
          url: base,
          course: { courseCode: `FA26 MATH ${301 + c} 001`, termName: "Fall 2026", startAt: day(0), endAt: day(110), accessState: "open" },
        }),
      ]),
    );
    out.push(
      batch(
        "modules",
        Array.from({ length: weeks }, (_, w) =>
          item({ externalId: `m${w}`, kind: "material", title: `Week ${w + 1}: ${TOPICS[w]}`, url: `${base}/modules/m${w}`, module: { id: `m${w}`, position: w + 1, unlockAt: day(w * 7) } }),
        ),
      ),
    );
    for (let w = 0; w < weeks; w++)
      out.push(
        batch(`module-items:m${w}`, [
          item({ externalId: `mi${w}0`, kind: "material", title: `Week ${w + 1}`, url: `${base}/modules/items/mi${w}0`, moduleItem: { type: "SubHeader", title: `Week ${w + 1}`, position: 0 } }),
          item({ externalId: `mi${w}1`, kind: "material", title: `Notes ${w}`, url: `${base}/modules/items/mi${w}1`, moduleItem: { type: "Page", title: `Notes ${w}`, position: 1, pageUrl: pageSlug(w, 0) } }),
          item({ externalId: `mi${w}2`, kind: "material", title: fileTitle(w, 0), url: `${base}/modules/items/mi${w}2`, moduleItem: { type: "File", title: fileTitle(w, 0), position: 2, contentId: fileId(w, 0) } }),
          item({ externalId: `mi${w}3`, kind: "material", title: `Homework ${w}`, url: `${base}/modules/items/mi${w}3`, moduleItem: { type: "Assignment", title: `Homework ${w}`, position: 3, contentId: `${courseId}9${w}` } }),
          item({ externalId: `mi${w}4`, kind: "material", title: `Video ${w}`, url: `${base}/modules/items/mi${w}4`, moduleItem: { type: "ExternalUrl", title: `Video ${w}`, position: 4, externalUrl: `https://www.youtube.com/embed/course-${courseId}-${w}` } }),
          item({ externalId: `mi${w}5`, kind: "material", title: `Quiz ${w}`, url: `${base}/modules/items/mi${w}5`, moduleItem: { type: "Quiz", title: `Quiz ${w}`, position: 5, contentId: `${courseId}7${w}` } }),
        ]),
      );
    const pages: ResourceInput[] = [];
    for (let w = 0; w < weeks; w++)
      for (let k = 0; k < 3; k++) {
        const next = `${base}/pages/${pageSlug((w + 1) % weeks, k)}`;
        const file = `${base}/files/${fileId(w, (k + 1) % 4)}/download`;
        pages.push(
          item({
            externalId: `p${w}-${k}`,
            kind: "material",
            title: k === 0 ? `Week ${w + 1} notes` : `${TOPICS[w]} notes ${k}`,
            url: `${base}/pages/${pageSlug(w, k)}`,
            text: paragraph(c, w * 3 + k, [fileTitle(w, 1).replace(/\.pdf$/, ""), `https://example.org/${TOPICS[w]!.toLowerCase().replace(/ /g, "-")}/${k}`]),
            links: [
              { url: next, text: "next notes" },
              { url: file, text: "the handout" },
              { url: `${base}/assignments/${courseId}9${w}`, text: `Homework ${w}` },
              { url: "https://canvas.wisc.edu/equation_images/x" },
            ],
            createdAt: day(w * 7 - 1),
          }),
        );
      }
    out.push(batch("pages", pages));
    out.push(
      batch("folders", [
        item({ externalId: "fold-slides", kind: "material", title: "Lecture slides", url: `${base}/files/folder/slides` }),
        item({ externalId: "fold-readings", kind: "material", title: "Readings", url: `${base}/files/folder/readings` }),
        item({ externalId: "fold-worksheets", kind: "material", title: "Worksheets", url: `${base}/files/folder/worksheets` }),
      ]),
    );
    const files: ResourceInput[] = [];
    for (let w = 0; w < weeks; w++)
      for (let k = 0; k < 4; k++) {
        const id = fileId(w, k);
        const title = fileTitle(w, k);
        files.push(
          item({
            externalId: id,
            kind: "material",
            title,
            url: `${base}/files/${id}`,
            text: k % 2 === 0 ? paragraph(c, 100 + w * 4 + k, [`Worksheet ${w}-2`]) : "",
            file: {
              id,
              folderId: ["fold-slides", "fold-readings", "fold-worksheets", "fold-slides"][k]!,
              displayName: title,
              contentType: k === 3 ? "image/png" : "application/pdf",
            },
            createdAt: day(w * 7 - 1),
          }),
        );
      }
    out.push(batch("files", files));
    out.push(
      batch("assignment-groups", [
        item({ externalId: "g-hw", kind: "material", title: "Homework", url: `${base}/assignments#group-hw` }),
        item({ externalId: "g-exam", kind: "material", title: "Exams", url: `${base}/assignments#group-exam` }),
        item({ externalId: "g-lab", kind: "material", title: "Labs", url: `${base}/assignments#group-lab` }),
        item({ externalId: "g-read", kind: "material", title: "Readings", url: `${base}/assignments#group-read` }),
      ]),
    );
    const assignments: ResourceInput[] = [];
    for (let w = 0; w < weeks; w++)
      assignments.push(
        item({
          externalId: `${courseId}9${w}`,
          kind: "assignment",
          title: `Homework ${w}`,
          url: `${base}/assignments/${courseId}9${w}`,
          text: `Use the ${fileTitle(w, 2).replace(/\.pdf$/, "")} and the week ${w + 1} notes. Background: https://example.org/hw/${w}`,
          links: [{ url: `${base}/pages/${pageSlug(w, 0)}`, text: "notes" }, { url: `${base}/files/${fileId(w, 2)}/preview`, text: "worksheet" }],
          dueAt: day(w * 7 + 6, "04:59:00.000Z"),
          assignmentGroupId: "g-hw",
          submissionTypes: ["online_upload"],
        }),
      );
    for (const [n, at] of [[1, 34], [2, 69]] as const)
      assignments.push(
        item({
          externalId: `${courseId}8${n}`,
          kind: "assignment",
          title: `Midterm Exam ${n}`,
          url: `${base}/assignments/${courseId}8${n}`,
          text: `Exam ${n} covers chapters ${n * 3 - 2}-${n * 3} and lectures 1-${n * 12}.`,
          dueAt: day(at, "19:00:00.000Z"),
          assignmentGroupId: "g-exam",
          submissionTypes: ["on_paper"],
        }),
      );
    for (let l = 0; l < 4; l++)
      assignments.push(
        item({ externalId: `${courseId}6${l}`, kind: "assignment", title: `Lab ${l + 1} write-up`, url: `${base}/assignments/${courseId}6${l}`, dueAt: day(l * 14 + 10, "04:59:00.000Z"), assignmentGroupId: "g-lab", submissionTypes: ["online_text_entry"] }),
      );
    out.push(batch("assignments", assignments));
    out.push(
      batch(
        "quizzes",
        Array.from({ length: 6 }, (_, q) =>
          item({ externalId: `${courseId}7${q}`, kind: "assignment", title: `Quiz ${q}`, url: `${base}/quizzes/${courseId}7${q}`, dueAt: day(q * 14 + 3, "04:59:00.000Z") }),
        ),
      ),
    );
    out.push(
      batch(
        "announcements",
        Array.from({ length: 20 }, (_, a) =>
          item({
            externalId: `ann${a}`,
            kind: "material",
            title: `Announcement ${a}: week ${(a % weeks) + 1}`,
            url: `${base}/discussion_topics/ann${a}`,
            text: `Reminder: office hours move to Friday. Read ${fileTitle(a % weeks, 1).replace(/\.pdf$/, "")} before lecture on Oct ${(a % 27) + 1}.`,
            createdAt: day(a * 3),
          }),
        ),
      ),
    );
    out.push(
      batch(
        "discussions",
        Array.from({ length: 10 }, (_, d) =>
          item({ externalId: `dis${d}`, kind: "material", title: `Discussion ${d}`, url: `${base}/discussion_topics/dis${d}`, text: `Post one question about ${TOPICS[d]} and reply to two classmates.` }),
        ),
      ),
    );
    out.push(
      batch("syllabus", [
        item({
          externalId: "syllabus",
          kind: "material",
          title: "Syllabus",
          url: `${base}/assignments/syllabus`,
          text: `Schedule\nHomework is due Fridays.\nExam 1 on Oct 6 covers chapters 1-3.\nExam 2 on Nov 10.\nFinal exam on December 15.\nOffice hours: Monday 2-3pm.`,
        }),
      ]),
    );
    out.push(
      batch(
        "account-todo",
        Array.from({ length: 5 }, (_, a) =>
          item({ externalId: `${courseId}9${a + 3}`, kind: "assignment", title: `Homework ${a + 3}`, url: `${base}/assignments/${courseId}9${a + 3}`, dueAt: day((a + 3) * 7 + 6, "05:00:00.000Z") }),
        ),
      ),
    );
    // Timed class meetings (note sessions): lectures Mon/Wed/Fri, a discussion Tuesday, a lab Thursday.
    const events: ResourceInput[] = [];
    for (let d = 0; d < 42; d++) {
      const date = day(d).slice(0, 10);
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      const kind = weekday === 1 || weekday === 3 || weekday === 5 ? "Lecture" : weekday === 2 ? "Discussion" : weekday === 4 ? "Lab" : null;
      if (!kind) continue;
      events.push(
        item({
          externalId: `cal:${d}`,
          kind: "event",
          title: `${kind} [MATH ${301 + c}]`,
          url: `${base}/calendar_events/${d}`,
          calendar: { uid: `event-${courseId}-${d}`, start: `${date}T14:55:00.000Z`, end: `${date}T15:45:00.000Z`, allDay: false, location: "Room 1" },
        }),
      );
    }
    for (let w = 0; w < weeks; w++)
      events.push(
        item({
          externalId: `cal:hw${w}`,
          kind: "event",
          title: `Homework ${w}`,
          url: `${base}/assignments/${courseId}9${w}`,
          calendar: { uid: `event-assignment-${courseId}9${w}`, start: day(w * 7 + 6, "04:59:00.000Z"), allDay: false },
        }),
      );
    out.push(batch("calendar_feed", events, "calendar"));
  }
  return out;
}
