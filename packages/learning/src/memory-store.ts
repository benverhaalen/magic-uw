// N11: the in-memory LearningStore, with the SQL tables' immutability and
// uniqueness rules (spec §7.2). Used by tests and the evaluation harness.
import {
  canonical,
  type CardFilter,
  type Concept,
  type ConceptAlias,
  type ConceptEdit,
  type ConceptStateRow,
  type CourseRef,
  type CoverageRow,
  type CoverageStatus,
  type Dispute,
  type DisputeStatus,
  type Evidence,
  type ItemCheck,
  type ItemFilter,
  type ItemSource,
  type ItemStatus,
  type ItemTag,
  type LearningArtifact,
  type LearningAttempt,
  type LearningCard,
  type LearningCourse,
  type LearningItem,
  type LearningReview,
  type LearningSession,
  type LearningStore,
  type SelfRating,
  type StaleReport,
  type StoredItem,
} from "./store";

const clone = <T>(v: T): T => structuredClone(v);
const itemKey = (id: string, version: number) => `${id}@${version}`;

function insertImmutable<T extends { id: string }>(map: Map<string, T>, row: T, what: string): void {
  const existing = map.get(row.id);
  if (existing) {
    if (canonical(existing) !== canonical(row)) throw new Error(`${what} ${row.id} already exists with different content`);
    return;
  }
  map.set(row.id, clone(row));
}

export function createMemoryLearningStore(now: () => string = () => new Date().toISOString()): LearningStore {
  let courses = new Map<CourseRef, LearningCourse>();
  let concepts = new Map<string, Concept>();
  let aliases: ConceptAlias[] = [];
  let items = new Map<string, StoredItem>();
  let cards = new Map<string, LearningCard>();
  let reviews = new Map<string, LearningReview>();
  let attempts = new Map<string, LearningAttempt>();
  let selfRatings = new Map<string, SelfRating>();
  let disputes = new Map<string, Dispute>();
  let artifacts = new Map<string, LearningArtifact>();
  let coverage = new Map<string, CoverageRow>();
  let sessions = new Map<string, LearningSession>();
  let states = new Map<string, ConceptStateRow>();

  const requireCourse = (ref: CourseRef) => {
    if (!courses.has(ref)) throw new Error(`unknown course ${ref}`);
  };
  const requireConcept = (id: string) => {
    const c = concepts.get(id);
    if (!c) throw new Error(`unknown concept ${id}`);
    return c;
  };
  const conceptCourse = (id: string) => concepts.get(id)?.courseRef;
  const cardCourse = (cardId: string) => cards.get(cardId)?.courseRef;

  const store: LearningStore = {
    course(accountScope, courseId, label = courseId, term = null) {
      const id = `${accountScope}:${courseId}`;
      let row = courses.get(id);
      if (!row) {
        row = { id, accountScope, courseId, label, term, createdAt: now() };
        courses.set(id, row);
      }
      return clone(row);
    },

    concepts(courseRef) {
      return [...concepts.values()].filter((c) => c.courseRef === courseRef).map(clone);
    },

    putConceptMap(courseRef, map, mapVersion) {
      requireCourse(courseRef);
      for (const incoming of map) {
        if (incoming.courseRef !== courseRef) throw new Error(`concept ${incoming.id} belongs to another course`);
        const existing = concepts.get(incoming.id);
        if (existing && existing.courseRef !== courseRef) throw new Error(`concept ${incoming.id} belongs to another course`);
        const row: Concept = { ...clone(incoming), mapVersion };
        // A rebuild never overwrites a student's edit (KM-1).
        if (existing && incoming.origin !== "student") {
          row.studentLabel = existing.studentLabel;
          row.status = existing.status;
          row.mergedInto = existing.mergedInto;
        }
        concepts.set(row.id, row);
      }
    },

    editConcept(id, edit: ConceptEdit) {
      const c = requireConcept(id);
      switch (edit.kind) {
        case "rename":
          c.studentLabel = edit.label;
          break;
        case "merge": {
          const into = requireConcept(edit.intoId);
          if (into.courseRef !== c.courseRef) throw new Error("cannot merge across courses");
          if (into.id === c.id) throw new Error("cannot merge a concept into itself");
          c.status = "merged";
          c.mergedInto = into.id;
          break;
        }
        case "hide":
          c.status = "hidden";
          break;
        case "restore":
          c.status = "active";
          c.mergedInto = null;
          break;
      }
      return clone(c);
    },

    aliases(conceptId) {
      return aliases.filter((a) => a.conceptId === conceptId).map(clone);
    },

    addAlias(alias) {
      requireConcept(alias.conceptId);
      const norm = alias.alias.trim().toLowerCase();
      if (!norm) throw new Error("empty alias");
      if (aliases.some((a) => a.conceptId === alias.conceptId && a.alias.trim().toLowerCase() === norm)) return;
      aliases.push(clone(alias));
    },

    putItem(item: LearningItem, sources: ItemSource[], tags: ItemTag[], checks: ItemCheck[]) {
      requireCourse(item.courseRef);
      for (const t of tags) {
        if (conceptCourse(t.conceptId) !== item.courseRef) throw new Error(`tag ${t.conceptId} is not a concept of ${item.courseRef}`);
      }
      const key = itemKey(item.id, item.version);
      const row: StoredItem = clone({ item, sources, tags, checks });
      const existing = items.get(key);
      if (existing) {
        const strip = (s: StoredItem) => canonical({ ...s, item: { ...s.item, status: null, statusReason: null } });
        if (strip(existing) !== strip(row)) throw new Error(`item ${key} already exists with different content`);
        return;
      }
      items.set(key, row);
    },

    items(filter: ItemFilter = {}) {
      return [...items.values()]
        .filter(
          (s) =>
            (!filter.courseRef || s.item.courseRef === filter.courseRef) &&
            (!filter.familyId || s.item.familyId === filter.familyId) &&
            (!filter.status || s.item.status === filter.status) &&
            (!filter.ids || filter.ids.includes(s.item.id)) &&
            (!filter.conceptId || s.tags.some((t) => t.conceptId === filter.conceptId)),
        )
        .map(clone);
    },

    setItemStatus(id, version, status: ItemStatus, reason) {
      const row = items.get(itemKey(id, version));
      if (!row) throw new Error(`unknown item ${itemKey(id, version)}`);
      row.item.status = status;
      row.item.statusReason = reason;
    },

    cards(filter: CardFilter = {}) {
      return [...cards.values()]
        .filter(
          (c) =>
            (!filter.courseRef || c.courseRef === filter.courseRef) &&
            (!filter.conceptId || c.conceptId === filter.conceptId) &&
            (!filter.itemId || c.itemId === filter.itemId) &&
            (!filter.dueBefore || c.fsrs.due <= filter.dueBefore),
        )
        .map(clone);
    },

    putCard(card) {
      requireCourse(card.courseRef);
      if (!card.isConceptTrack && ![...items.values()].some((s) => s.item.id === card.itemId)) {
        throw new Error(`card ${card.id} references unknown item ${card.itemId}`);
      }
      cards.set(card.id, clone(card));
    },

    addReview(review) {
      if (!cards.has(review.cardId)) throw new Error(`review ${review.id} references unknown card ${review.cardId}`);
      insertImmutable(reviews, review, "review");
    },

    addAttempt(attempt) {
      requireCourse(attempt.courseRef);
      for (const field of ["id", "itemId", "primaryConceptId", "sessionId", "localDay", "createdAt", "format", "mode"] as const) {
        if (attempt[field] === undefined || attempt[field] === null || attempt[field] === "") {
          throw new Error(`attempt is missing ${field}`);
        }
      }
      if (attempt.score < 0 || attempt.score > 1) throw new Error("attempt score must be within 0..1");
      insertImmutable(attempts, attempt, "attempt");
    },

    addSelfRating(rating) {
      requireConcept(rating.conceptId);
      insertImmutable(selfRatings, rating, "self-rating");
    },

    evidence(courseRef, since) {
      const after = (t: string) => !since || t >= since;
      const out: Evidence = {
        attempts: [...attempts.values()].filter((a) => a.courseRef === courseRef && after(a.createdAt)),
        reviews: [...reviews.values()].filter((r) => cardCourse(r.cardId) === courseRef && after(r.createdAt)),
        selfRatings: [...selfRatings.values()].filter((r) => conceptCourse(r.conceptId) === courseRef && after(r.createdAt)),
        disputes: [...disputes.values()].filter((d) => d.courseRef === courseRef),
      };
      const byTime = <T extends { createdAt: string; id: string }>(a: T, b: T) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;
      out.attempts.sort(byTime);
      out.reviews.sort(byTime);
      out.selfRatings.sort(byTime);
      out.disputes.sort(byTime);
      return clone(out);
    },

    addDispute(dispute) {
      requireCourse(dispute.courseRef);
      if (dispute.note && dispute.note.length > 500) throw new Error("dispute note exceeds 500 characters");
      insertImmutable(disputes, dispute, "dispute");
    },

    setDisputeStatus(id, status: DisputeStatus, at) {
      const d = disputes.get(id);
      if (!d) throw new Error(`unknown dispute ${id}`);
      d.status = status;
      d.resolvedAt = status === "open" ? null : at;
    },

    artifact(cacheKey) {
      const a = [...artifacts.values()].find((x) => x.cacheKey === cacheKey);
      return a ? clone(a) : null;
    },

    putArtifact(artifact) {
      requireCourse(artifact.courseRef);
      const clash = [...artifacts.values()].find((x) => x.cacheKey === artifact.cacheKey && x.id !== artifact.id);
      if (clash) throw new Error(`cache key ${artifact.cacheKey} already belongs to ${clash.id}`);
      artifacts.set(artifact.id, clone(artifact));
    },

    markStale(resourceId, newHash, stillValid) {
      const report: StaleReport = { artifacts: [], items: [], quarantined: [], cards: [] };
      for (const a of artifacts.values()) {
        if (a.sources.some((s) => s.resourceId === resourceId && s.contentHash !== newHash)) {
          a.status = "stale";
          report.artifacts.push(a.id);
        }
      }
      const touchedItems = new Set<string>();
      for (const s of items.values()) {
        const cited = s.sources.filter((src) => src.resourceId === resourceId && src.contentHash !== newHash);
        if (!cited.length) continue;
        touchedItems.add(s.item.id);
        const valid = stillValid ? cited.every((src) => stillValid(src.quote)) : true;
        if (!valid) {
          s.item.status = "quarantined";
          s.item.statusReason = "source changed";
          for (const src of cited) src.quoteValid = false;
          report.quarantined.push({ id: s.item.id, version: s.item.version });
        } else if (s.item.status === "active") {
          s.item.status = "stale";
          s.item.statusReason = "source updated";
          report.items.push({ id: s.item.id, version: s.item.version });
        }
      }
      for (const c of cards.values()) if (touchedItems.has(c.itemId)) report.cards.push(c.id);
      return report;
    },

    coverage(assessmentId) {
      return [...coverage.values()].filter((r) => r.assessmentId === assessmentId).map(clone);
    },

    putCoverage(rows: CoverageRow[]) {
      for (const row of rows) {
        requireConcept(row.conceptId);
        const key = `${row.assessmentId}|${row.conceptId}`;
        const existing = coverage.get(key);
        if (existing?.decidedByStudent) continue; // a student decision is never overwritten
        coverage.set(key, clone({ ...row, decidedByStudent: false }));
      }
    },

    decideCoverage(key, status: CoverageStatus) {
      const row = coverage.get(`${key.assessmentId}|${key.conceptId}`);
      if (!row) throw new Error(`unknown coverage row ${key.assessmentId}/${key.conceptId}`);
      row.status = status;
      row.decidedByStudent = true;
    },

    putSession(session) {
      if (session.courseRef !== null) requireCourse(session.courseRef);
      sessions.set(session.id, clone(session));
    },

    sessions(courseRef) {
      return [...sessions.values()].filter((s) => s.courseRef === courseRef).map(clone);
    },

    conceptState(courseRef) {
      return [...states.values()].filter((s) => conceptCourse(s.conceptId) === courseRef).map(clone);
    },

    putConceptState(rows) {
      const versions = new Set(rows.map((r) => r.configVersion));
      if (versions.size > 1) throw new Error("two configuration versions in one state write (KM-12)");
      for (const r of rows) {
        requireConcept(r.conceptId);
        states.set(r.conceptId, clone(r));
      }
    },

    reset() {
      courses = new Map();
      concepts = new Map();
      aliases = [];
      items = new Map();
      cards = new Map();
      reviews = new Map();
      attempts = new Map();
      selfRatings = new Map();
      disputes = new Map();
      artifacts = new Map();
      coverage = new Map();
      sessions = new Map();
      states = new Map();
    },
  };
  return store;
}
