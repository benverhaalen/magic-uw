import type { CourseCoreStore, Store } from "@magic/contracts";
import { persistCourseSpaces } from "../apps/desktop/src/course-space-storage";

/** Explicit synthetic preview data; never used by the desktop or a live refresh. */
export function seedSyncResilienceFixture(store: Store & CourseCoreStore) {
  const at = "2026-09-26T18:00:00.000Z";
  store.ingest({
    source: {
      id: "synthetic-sync",
      label: "Sync recovery · synthetic",
      kind: "canvas",
      accountScope: "synthetic",
      courseId: "321",
      scope: "course",
    },
    observedAt: at,
    complete: true,
    status: "ok",
    resources: [
      {
        externalId: "9",
        kind: "material",
        courseId: "321",
        courseName: "Sync recovery · synthetic",
        title: "Saved course reading",
        url: "https://canvas.wisc.edu/courses/321/files/9",
        text: "Synthetic saved reading remains available after an access failure.",
        deadlines: [],
      },
    ],
  });
  persistCourseSpaces(store, "synthetic", "321", [
    {
      id: "saved",
      courseId: "321",
      kind: "canvas_file",
      host: "canvas.wisc.edu",
      url: "https://canvas.wisc.edu/files/9/download",
      foundIn: "body",
      foundAt: "9",
      route: "canvas_session",
      treatment: "store",
      label: "Saved course reading",
      readState: "unread",
      jev: false,
      access: {
        state: "blocked",
        checkedAt: at,
        reason: "not_authorized",
        action: "none",
      },
    },
    {
      id: "pending",
      courseId: "321",
      kind: "canvas_file",
      host: "canvas.wisc.edu",
      url: "https://canvas.wisc.edu/courses/321/files/10/preview",
      foundIn: "body",
      foundAt: "9",
      route: "canvas_session",
      treatment: "store",
      label: "Discovered reading awaiting a check",
      readState: "unread",
      jev: false,
      access: { state: "unknown", checkedAt: null, action: "none" },
    },
  ]);
}
