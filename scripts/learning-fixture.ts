// Explicit browser QA fixture only. Never imported by the desktop worker.
import type { Snapshot } from "@magic/contracts";
import type { Concept, LearningStore } from "../packages/learning/src/store";
import {
  runPipeline,
  type CandidateItem,
} from "../packages/learning/src/items";
import { findQuote } from "../packages/retrieval/src/quotes";

/** Seed synthetic items through the real deterministic checked-item pipeline. No model calls. */
export function seedLearningFixture(
  store: LearningStore,
  snapshot: Snapshot,
): void {
  const source = snapshot.sources.find(
    (source) => source.accountScope === "synthetic",
  );
  const material = snapshot.resources.find(
    (resource) =>
      resource.sourceId === source?.id && resource.kind === "material",
  );
  if (!source || !material) return;
  const course = store.course(
    source.accountScope,
    material.courseId,
    material.courseName,
  );
  const concept: Concept = {
    id: "synthetic-argument",
    courseRef: course.id,
    parentId: null,
    label: "Claims and evidence · synthetic",
    kind: "concept",
    position: 0,
    origin: "code",
    status: "active",
    mergedInto: null,
    studentLabel: null,
    mapVersion: "synthetic-v1",
    sources: [],
  };
  store.putConceptMap(course.id, [concept], "synthetic-v1");
  const quote = "A claim states a position. Evidence supports it.";
  const base = {
    version: 1,
    courseRef: course.id,
    keyIdeas: [],
    explanation: {
      text: "Synthetic saved explanation: a claim states a position, and evidence supports it.",
      citation: { resourceId: material.id, quote },
    },
    tempting: {},
    bloom: "remember",
    tier: "T1",
    sourceTerm: null,
    origin: "instructor",
    generator: null,
    sources: [{ resourceId: material.id, quote }],
    tags: [{ conceptId: concept.id, primary: true }],
  } as const;
  const candidates: CandidateItem[] = [
    {
      ...base,
      id: "synthetic-typed",
      familyId: "synthetic-typed",
      kind: "typed",
      stem: "Synthetic practice: what states a position?",
      options: null,
      key: "claim",
      keyIdeas: [{ idea: "claim", synonyms: ["a claim"], required: true }],
      sources: [...base.sources],
      tags: [...base.tags],
    },
    {
      ...base,
      id: "synthetic-choice",
      familyId: "synthetic-choice",
      kind: "mc",
      stem: "Synthetic practice: what supports a claim?",
      options: [
        { id: "evidence", text: "Evidence" },
        { id: "title", text: "A title" },
        { id: "deadline", text: "A deadline" },
      ],
      key: "evidence",
      keyIdeas: [],
      sources: [...base.sources],
      tags: [...base.tags],
    },
  ];
  for (const candidate of candidates) {
    const checked = runPipeline(candidate, {
      courseRestricted: false,
      resources: [{ ...material }],
      validate: findQuote,
      map: [concept],
      seenStems: [],
      now: new Date(),
    });
    if (!checked.accepted || !checked.item)
      throw new Error(
        `Synthetic item failed its checks: ${checked.dropped?.reason}`,
      );
    store.putItem(checked.item, checked.sources, checked.tags, checked.checks);
  }
}
