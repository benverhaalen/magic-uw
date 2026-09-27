/** N24: LearningStore on the storage owner's connection. No connection or migration
 * is created here. JSON columns hold only their named structured field; evidence
 * stays in learning_attempts, never the legacy attempts table. */
import type { StatementSync, SQLInputValue } from "node:sqlite";
import {
  canonical,
  type LearningStore,
  type LearningCourse,
  type Concept,
  type LearningItem,
  type StoredItem,
  type LearningCard,
  type LearningReview,
  type LearningAttempt,
  type SelfRating,
  type Dispute,
  type LearningArtifact,
  type CoverageRow,
  type LearningSession,
  type ConceptStateRow,
  type StaleReport,
} from "./store";

type Row = Record<string, unknown>;
type Fields = Record<string, string>;
const base = { id: "id", createdAt: "created_at" };
const courseFields = {
  ...base,
  accountScope: "account_scope",
  courseId: "course_id",
  label: "label",
  term: "term",
};
const conceptFields = {
  id: "id",
  courseRef: "course_id",
  parentId: "parent_id",
  label: "label",
  kind: "kind",
  position: "position",
  origin: "origin",
  status: "status",
  mergedInto: "merged_into",
  studentLabel: "student_label",
  mapVersion: "map_version",
};
const sourceFields = {
  resourceId: "resource_id",
  contentHash: "content_hash",
  start: "start",
  end: "end",
  quote: "quote",
  quoteValid: "quote_valid",
};
const itemFields = {
  ...base,
  version: "version",
  courseRef: "course_id",
  familyId: "family_id",
  kind: "kind",
  stem: "stem",
  options: "options_json",
  key: "key_json",
  keyIdeas: "key_ideas_json",
  explanation: "explanation",
  tempting: "tempting_json",
  bloom: "bloom",
  bPrior: "b_prior",
  tier: "tier",
  sourceTerm: "source_term",
  origin: "origin",
  status: "status",
  statusReason: "status_reason",
  generator: "generator_json",
  unit: "unit",
};
const tagFields = {
  conceptId: "concept_id",
  weight: "weight",
  primary: "primary",
};
const checkFields = {
  check: "check",
  method: "method",
  outcome: "outcome",
  detail: "detail_json",
  createdAt: "created_at",
};
const fsrsFields = {
  due: "due",
  stability: "stability",
  difficulty: "difficulty",
  elapsed_days: "elapsed_days",
  scheduled_days: "scheduled_days",
  learning_steps: "learning_steps",
  reps: "reps",
  lapses: "lapses",
  state: "state",
  last_review: "last_review",
};
const reviewFields = {
  ...base,
  cardId: "card_id",
  rating: "rating",
  stateBefore: "state_before_json",
  stateAfter: "state_after_json",
  reviewMs: "review_ms",
  localDay: "local_day",
  undoesReviewId: "undoes_review_id",
};
const attemptFields = {
  ...base,
  courseRef: "course_id",
  itemId: "item_id",
  itemVersion: "item_version",
  sourceResourceId: "source_resource_id",
  primaryConceptId: "primary_concept_id",
  correct: "correct",
  assistance: "assistance",
  seenBefore: "seen_before",
  confidence: "confidence",
  format: "format",
  mode: "mode",
  response: "response_json",
  score: "score",
  gradingMethod: "grading_method",
  responseMs: "response_ms",
  conceptTags: "concept_tags_json",
  sessionId: "session_id",
  localDay: "local_day",
  optionId: "option_id",
};
const ratingFields = {
  ...base,
  conceptId: "concept_id",
  rating: "rating",
  delayed: "delayed",
  localDay: "local_day",
};
const disputeFields = {
  ...base,
  courseRef: "course_id",
  targetKind: "target_kind",
  targetId: "target_id",
  reason: "reason",
  note: "note",
  status: "status",
  resolvedAt: "resolved_at",
};
const artifactFields = {
  ...base,
  courseRef: "course_id",
  kind: "kind",
  scope: "scope_json",
  cacheKey: "cache_key",
  body: "body_json",
  removedCount: "removed_count",
  status: "status",
  generator: "generator_json",
  pack: "pack",
  packVersion: "pack_version",
};
const coverageFields = {
  assessmentId: "assessment_id",
  conceptId: "concept_id",
  basis: "basis",
  tier: "tier",
  evidenceResourceId: "evidence_resource_id",
  start: "start",
  end: "end",
  quote: "quote",
  status: "status",
  decidedByStudent: "decided_by_student",
};
const sessionFields = {
  id: "id",
  courseRef: "course_id",
  kind: "kind",
  plan: "plan_json",
  minutes: "minutes",
  difficulty: "difficulty",
  startedAt: "started_at",
  endedAt: "ended_at",
};
const stateFields = {
  conceptId: "concept_id",
  theta: "theta",
  n: "n",
  s: "s",
  pHat: "p_hat",
  r: "r",
  band: "band",
  reasons: "reasons_json",
  counts: "counts_json",
  configVersion: "config_version",
  computedAt: "computed_at",
};
const bools = new Set([
  "quoteValid",
  "primary",
  "correct",
  "seenBefore",
  "delayed",
  "decidedByStudent",
]);
const optional = new Set(["unit", "optionId", "detail", "pack", "packVersion"]);
const quote = (s: string) => `"${s}"`;
function decode<T>(row: Row, fields: Fields): T {
  const out: Row = {};
  for (const [key, column] of Object.entries(fields)) {
    const value = row[column];
    if (
      optional.has(key) &&
      (value == null ||
        ((key === "pack" || key === "packVersion") && value === ""))
    )
      continue;
    out[key] = column.endsWith("_json")
      ? value == null
        ? null
        : JSON.parse(String(value))
      : bools.has(key)
        ? !!value
        : value;
  }
  return out as T;
}
function encode(value: unknown, fields: Fields): Row {
  const row = value as Row,
    out: Row = {};
  for (const [key, column] of Object.entries(fields))
    out[column] = column.endsWith("_json")
      ? canonical(row[key] ?? null)
      : bools.has(key)
        ? Number(!!row[key])
        : (row[key] ?? null);
  return out;
}
export interface SqlLearningStore extends LearningStore {
  /** Runs a synchronous multi-write operation atomically on the same connection. */
  transaction<T>(work: () => T): T;
}
export function createSqlLearningStore(
  prepare: (sql: string) => StatementSync,
  ownerTransaction: <T>(work: () => T) => T,
  now = () => new Date().toISOString(),
): SqlLearningStore {
  let depth = 0;
  const transaction = <T>(work: () => T): T => {
    if (depth) {
      const name = `learning_${depth++}`;
      prepare(`SAVEPOINT ${name}`).run();
      try {
        const value = work();
        prepare(`RELEASE ${name}`).run();
        return value;
      } catch (error) {
        prepare(`ROLLBACK TO ${name}`).run();
        prepare(`RELEASE ${name}`).run();
        throw error;
      } finally {
        depth--;
      }
    }
    return ownerTransaction(() => {
      depth++;
      try {
        return work();
      } finally {
        depth--;
      }
    });
  };
  const all = (sql: string, ...args: SQLInputValue[]) =>
    prepare(sql).all(...args) as Row[];
  const one = (sql: string, ...args: SQLInputValue[]) =>
    prepare(sql).get(...args) as Row | undefined;
  const run = (sql: string, ...args: SQLInputValue[]) =>
    prepare(sql).run(...args);
  const write = (table: string, row: Row, keys: string[], replace = true) => {
    const cols = Object.keys(row),
      changed = cols.filter((c) => !keys.includes(c));
    run(
      `INSERT INTO ${table} (${cols.map(quote)}) VALUES (${cols.map(() => "?")})${replace ? ` ON CONFLICT (${keys.map(quote)}) DO UPDATE SET ${changed.map((c) => `${quote(c)}=excluded.${quote(c)}`)}` : ""}`,
      ...cols.map((c) => row[c] as SQLInputValue),
    );
  };
  const requireCourse = (id: string) => {
    if (!one("SELECT id FROM learning_courses WHERE id=?", id))
      throw Error("Unknown learning course");
  };
  const concept = (id: string) => {
    const row = one("SELECT * FROM learning_concepts WHERE id=?", id);
    if (!row) throw Error("Unknown concept");
    return row;
  };
  const sameCourse = (id: string, ref: string) => {
    if (concept(id).course_id !== ref)
      throw Error("Concept belongs to another course");
  };
  const sourceCourse = (id: string, ref: string) => {
    const row = one(
      "SELECT s.account_scope,s.course_id FROM resources r JOIN sources s ON s.id=r.source_id WHERE r.id=?",
      id,
    );
    const c = one("SELECT * FROM learning_courses WHERE id=?", ref);
    if (
      !row ||
      !c ||
      row.account_scope !== c.account_scope ||
      row.course_id !== c.course_id
    )
      throw Error("Source belongs to another course or is missing");
  };
  const immutable = (table: string, row: Row) => {
    const prev = one(`SELECT * FROM ${table} WHERE id=?`, row.id as string);
    if (prev) {
      for (const [k, v] of Object.entries(row))
        if (canonical(prev[k]) !== canonical(v))
          throw Error(
            "Immutable evidence already exists with different content",
          );
      return;
    }
    write(table, row, ["id"], false);
  };
  const children = (table: string, id: string, version: number) =>
    all(
      `SELECT * FROM ${table} WHERE item_id=? AND item_version=? ORDER BY rowid`,
      id,
      version,
    );
  const stored = (r: Row): StoredItem => ({
    item: decode<LearningItem>(r, itemFields),
    sources: children(
      "learning_item_sources",
      String(r.id),
      Number(r.version),
    ).map((x) => decode(x, { ...sourceFields, textHash: "text_hash" })),
    tags: children(
      "learning_item_concepts",
      String(r.id),
      Number(r.version),
    ).map((x) => decode(x, tagFields)),
    checks: children(
      "learning_item_checks",
      String(r.id),
      Number(r.version),
    ).map((x) => decode(x, checkFields)),
  });
  const store: SqlLearningStore = {
    transaction,
    course(accountScope, courseId, label = courseId, term = null) {
      const id = `${accountScope}:${courseId}`;
      return transaction(() => {
        let row = one("SELECT * FROM learning_courses WHERE id=?", id);
        if (
          row &&
          (row.account_scope !== accountScope || row.course_id !== courseId)
        )
          throw Error("Ambiguous course identity");
        if (!row) {
          row = encode(
            { id, accountScope, courseId, label, term, createdAt: now() },
            courseFields,
          );
          write("learning_courses", row, ["id"], false);
        }
        return decode<LearningCourse>(row, courseFields);
      });
    },
    concepts(ref) {
      return all(
        "SELECT * FROM learning_concepts WHERE course_id=? ORDER BY rowid",
        ref,
      ).map((row) => ({
        ...decode<Concept>(row, conceptFields),
        sources: all(
          "SELECT * FROM learning_concept_sources WHERE concept_id=? ORDER BY rowid",
          String(row.id),
        ).map((s) => decode<Concept["sources"][number]>(s, sourceFields)),
      }));
    },
    putConceptMap(ref, map, version) {
      transaction(() => {
        requireCourse(ref);
        const ids = new Set(map.map((c) => c.id));
        const previous = new Map(store.concepts(ref).map((c) => [c.id, c]));
        for (const c of map) {
          if (c.courseRef !== ref)
            throw Error("Concept belongs to another course");
          const old = one("SELECT * FROM learning_concepts WHERE id=?", c.id);
          if (old && old.course_id !== ref)
            throw Error("Concept belongs to another course");
          for (const target of [c.parentId, c.mergedInto])
            if (target && !ids.has(target)) sameCourse(target, ref);
          for (const s of c.sources) sourceCourse(s.resourceId, ref);
        }
        // Two passes allow children before parents without deferring every foreign key.
        for (const c of map) {
          const old = one("SELECT * FROM learning_concepts WHERE id=?", c.id);
          const row = {
            ...c,
            mapVersion: version,
            parentId: null,
            mergedInto: null,
          };
          if (old && c.origin !== "student") {
            row.studentLabel = old.student_label as string | null;
            row.status = old.status as Concept["status"];
          }
          write("learning_concepts", encode(row, conceptFields), ["id"]);
        }
        for (const c of map) {
          const old = store.concepts(ref).find((x) => x.id === c.id)!;
          run(
            "UPDATE learning_concepts SET parent_id=?,merged_into=? WHERE id=?",
            c.parentId,
            c.origin === "student"
              ? c.mergedInto
              : previous.has(c.id)
                ? previous.get(c.id)!.mergedInto
                : c.mergedInto,
            c.id,
          );
          run("DELETE FROM learning_concept_sources WHERE concept_id=?", c.id);
          for (const s of c.sources)
            write(
              "learning_concept_sources",
              { concept_id: c.id, ...encode(s, sourceFields) },
              ["concept_id", "resource_id", "start"],
              false,
            );
        }
      });
    },
    editConcept(id, edit) {
      return transaction(() => {
        const c = concept(id);
        if (edit.kind === "rename")
          run(
            "UPDATE learning_concepts SET student_label=? WHERE id=?",
            edit.label,
            id,
          );
        else if (edit.kind === "merge") {
          sameCourse(edit.intoId, String(c.course_id));
          if (edit.intoId === id) throw Error("Cannot merge into itself");
          run(
            "UPDATE learning_concepts SET status='merged',merged_into=? WHERE id=?",
            edit.intoId,
            id,
          );
        } else
          run(
            "UPDATE learning_concepts SET status=?,merged_into=? WHERE id=?",
            edit.kind === "hide" ? "hidden" : "active",
            edit.kind === "hide" ? (c.merged_into as string | null) : null,
            id,
          );
        return store.concepts(String(c.course_id)).find((x) => x.id === id)!;
      });
    },
    aliases(id) {
      return all(
        "SELECT * FROM learning_concept_aliases WHERE concept_id=?",
        id,
      ).map((r) => ({
        conceptId: String(r.concept_id),
        alias: String(r.alias),
        origin: r.origin as "code" | "jev" | "student",
      }));
    },
    addAlias(a) {
      transaction(() => {
        concept(a.conceptId);
        const norm = a.alias.trim().toLowerCase();
        if (!norm) throw Error("Empty alias");
        if (
          store
            .aliases(a.conceptId)
            .some((x) => x.alias.trim().toLowerCase() === norm)
        )
          return;
        write(
          "learning_concept_aliases",
          { concept_id: a.conceptId, alias: a.alias, origin: a.origin },
          ["concept_id", "alias"],
          false,
        );
      });
    },
    putItem(item, sources, tags, checks) {
      transaction(() => {
        requireCourse(item.courseRef);
        for (const t of tags) sameCourse(t.conceptId, item.courseRef);
        for (const s of sources) sourceCourse(s.resourceId, item.courseRef);
        const versions = all(
          "SELECT course_id FROM learning_items WHERE id=?",
          item.id,
        );
        if (versions.some((r) => r.course_id !== item.courseRef))
          throw Error("Item belongs to another course");
        const prior = one(
          "SELECT * FROM learning_items WHERE id=? AND version=?",
          item.id,
          item.version,
        );
        if (prior) {
          const strip = (x: StoredItem) =>
            canonical({
              ...x,
              item: { ...x.item, status: null, statusReason: null },
            });
          if (strip(stored(prior)) !== strip({ item, sources, tags, checks }))
            throw Error("Item already exists with different content");
          return;
        }
        write(
          "learning_items",
          encode(item, itemFields),
          ["id", "version"],
          false,
        );
        for (const [table, rows, fields] of [
          [
            "learning_item_sources",
            sources,
            { ...sourceFields, textHash: "text_hash" },
          ],
          ["learning_item_concepts", tags, tagFields],
          ["learning_item_checks", checks, checkFields],
        ] as const)
          for (const row of rows)
            write(
              table,
              {
                item_id: item.id,
                item_version: item.version,
                ...encode(row, fields),
              },
              [],
              false,
            );
      });
    },
    items(filter = {}) {
      return all("SELECT * FROM learning_items ORDER BY rowid")
        .map(stored)
        .filter(
          (s) =>
            (!filter.courseRef || s.item.courseRef === filter.courseRef) &&
            (!filter.familyId || s.item.familyId === filter.familyId) &&
            (!filter.status || s.item.status === filter.status) &&
            (!filter.ids || filter.ids.includes(s.item.id)) &&
            (!filter.conceptId ||
              s.tags.some((t) => t.conceptId === filter.conceptId)),
        );
    },
    setItemStatus(id, version, status, reason) {
      if (
        !run(
          "UPDATE learning_items SET status=?,status_reason=? WHERE id=? AND version=?",
          status,
          reason,
          id,
          version,
        ).changes
      )
        throw Error("Unknown item");
    },
    cards(filter = {}) {
      return all("SELECT * FROM learning_cards ORDER BY rowid")
        .map((r) => ({
          id: String(r.id),
          itemId: String(r.item_id ?? r.track_item_id ?? ""),
          ...(r.item_version == null
            ? {}
            : { itemVersion: Number(r.item_version) }),
          courseRef: String(r.course_id),
          conceptId: String(r.concept_id ?? ""),
          fsrs: decode<LearningCard["fsrs"]>(r, fsrsFields),
          fsrsVersion: String(r.fsrs_version),
          paramsHash: String(r.params_hash),
          isConceptTrack: !!r.is_concept_track,
        }))
        .filter(
          (c) =>
            (!filter.courseRef || c.courseRef === filter.courseRef) &&
            (!filter.conceptId || c.conceptId === filter.conceptId) &&
            (!filter.itemId || c.itemId === filter.itemId) &&
            (!filter.dueBefore || c.fsrs.due <= filter.dueBefore),
        );
    },
    putCard(c) {
      transaction(() => {
        requireCourse(c.courseRef);
        sameCourse(c.conceptId, c.courseRef);
        const existing = one("SELECT * FROM learning_cards WHERE id=?", c.id);
        if (existing && existing.course_id !== c.courseRef)
          throw Error("Card belongs to another course");
        // An update from an older caller without itemVersion keeps the pinned
        // version; a new card resolves the newest version once.
        const itemVersion =
          c.itemVersion ??
          (existing?.item_id === c.itemId && existing.item_version != null
            ? Number(existing.item_version)
            : undefined);
        const item = c.isConceptTrack
          ? undefined
          : one(
              `SELECT * FROM learning_items WHERE id=? ${itemVersion === undefined ? "ORDER BY version DESC LIMIT 1" : "AND version=?"}`,
              c.itemId,
              ...(itemVersion === undefined ? [] : [itemVersion]),
            );
        if (!c.isConceptTrack && (!item || item.course_id !== c.courseRef))
          throw Error("Unknown item in card course");
        write(
          "learning_cards",
          {
            id: c.id,
            item_id: item?.id ?? null,
            item_version: item?.version ?? null,
            course_id: c.courseRef,
            concept_id: c.conceptId,
            track_item_id: c.isConceptTrack ? c.itemId : null,
            ...encode(c.fsrs, fsrsFields),
            fsrs_version: c.fsrsVersion,
            params_hash: c.paramsHash,
            is_concept_track: Number(c.isConceptTrack),
          },
          ["id"],
        );
      });
    },
    addReview(r) {
      transaction(() => {
        if (!one("SELECT id FROM learning_cards WHERE id=?", r.cardId))
          throw Error("Unknown card");
        immutable("learning_reviews", encode(r, reviewFields));
      });
    },
    addAttempt(a) {
      transaction(() => {
        requireCourse(a.courseRef);
        for (const k of [
          "id",
          "itemId",
          "primaryConceptId",
          "sessionId",
          "localDay",
          "createdAt",
          "format",
          "mode",
        ] as const)
          if (!a[k]) throw Error(`Attempt missing ${k}`);
        if (!Number.isFinite(a.score) || a.score < 0 || a.score > 1)
          throw Error("Attempt score must be within 0..1");
        sameCourse(a.primaryConceptId, a.courseRef);
        for (const t of a.conceptTags) sameCourse(t.conceptId, a.courseRef);
        if (a.sourceResourceId) sourceCourse(a.sourceResourceId, a.courseRef);
        const item = one(
          "SELECT course_id FROM learning_items WHERE id=? AND version=?",
          a.itemId,
          a.itemVersion,
        );
        if (item && item.course_id !== a.courseRef)
          throw Error("Item belongs to another course");
        immutable("learning_attempts", encode(a, attemptFields));
      });
    },
    addSelfRating(r) {
      transaction(() => {
        concept(r.conceptId);
        immutable("learning_self_ratings", encode(r, ratingFields));
      });
    },
    evidence(ref, since) {
      const after = since ?? "";
      return {
        attempts: all(
          "SELECT * FROM learning_attempts WHERE course_id=? AND created_at>=? ORDER BY created_at,id",
          ref,
          after,
        ).map((r) => decode<LearningAttempt>(r, attemptFields)),
        reviews: all(
          "SELECT r.* FROM learning_reviews r JOIN learning_cards c ON c.id=r.card_id WHERE c.course_id=? AND r.created_at>=? ORDER BY r.created_at,r.id",
          ref,
          after,
        ).map((r) => decode<LearningReview>(r, reviewFields)),
        selfRatings: all(
          "SELECT r.* FROM learning_self_ratings r JOIN learning_concepts c ON c.id=r.concept_id WHERE c.course_id=? AND r.created_at>=? ORDER BY r.created_at,r.id",
          ref,
          after,
        ).map((r) => decode<SelfRating>(r, ratingFields)),
        disputes: all(
          "SELECT * FROM learning_disputes WHERE course_id=? ORDER BY created_at,id",
          ref,
        ).map((r) => decode<Dispute>(r, disputeFields)),
      };
    },
    addDispute(d) {
      transaction(() => {
        requireCourse(d.courseRef);
        if (d.note && d.note.length > 500)
          throw Error("Dispute note exceeds 500 characters");
        immutable("learning_disputes", encode(d, disputeFields));
      });
    },
    setDisputeStatus(id, status, at) {
      if (
        !run(
          "UPDATE learning_disputes SET status=?,resolved_at=? WHERE id=?",
          status,
          status === "open" ? null : at,
          id,
        ).changes
      )
        throw Error("Unknown dispute");
    },
    artifact(key) {
      const r = one("SELECT * FROM learning_artifacts WHERE cache_key=?", key);
      return r
        ? {
            ...decode<LearningArtifact>(r, artifactFields),
            sources: all(
              "SELECT resource_id,content_hash FROM learning_artifact_sources WHERE artifact_id=? ORDER BY rowid",
              String(r.id),
            ).map((s) => ({
              resourceId: String(s.resource_id),
              contentHash: String(s.content_hash),
            })),
          }
        : null;
    },
    putArtifact(a) {
      transaction(() => {
        requireCourse(a.courseRef);
        const old = one(
          "SELECT course_id FROM learning_artifacts WHERE id=?",
          a.id,
        );
        if (old && old.course_id !== a.courseRef)
          throw Error("Artifact belongs to another course");
        for (const s of a.sources) sourceCourse(s.resourceId, a.courseRef);
        write(
          "learning_artifacts",
          encode(
            { ...a, pack: a.pack ?? "", packVersion: a.packVersion ?? "" },
            artifactFields,
          ),
          ["id"],
        );
        run("DELETE FROM learning_artifact_sources WHERE artifact_id=?", a.id);
        for (const s of a.sources)
          write(
            "learning_artifact_sources",
            {
              artifact_id: a.id,
              resource_id: s.resourceId,
              content_hash: s.contentHash,
            },
            [],
            false,
          );
      });
    },
    markStale(resourceId, hash, valid) {
      return transaction(() => {
        const out: StaleReport = {
          artifacts: [],
          items: [],
          quarantined: [],
          cards: [],
        };
        for (const r of all(
          "SELECT a.id FROM learning_artifacts a JOIN learning_artifact_sources s ON s.artifact_id=a.id WHERE s.resource_id=? AND s.content_hash<>?",
          resourceId,
          hash,
        )) {
          run(
            "UPDATE learning_artifacts SET status='stale' WHERE id=?",
            String(r.id),
          );
          out.artifacts.push(String(r.id));
        }
        const touched = new Set<string>();
        for (const s of store.items()) {
          const cites = s.sources.filter(
            (x) => x.resourceId === resourceId && x.contentHash !== hash,
          );
          if (!cites.length) continue;
          touched.add(s.item.id);
          if (valid && !cites.every((x) => valid(x.quote))) {
            store.setItemStatus(
              s.item.id,
              s.item.version,
              "quarantined",
              "source changed",
            );
            run(
              "UPDATE learning_item_sources SET quote_valid=0 WHERE item_id=? AND item_version=? AND resource_id=? AND content_hash<>?",
              s.item.id,
              s.item.version,
              resourceId,
              hash,
            );
            out.quarantined.push({ id: s.item.id, version: s.item.version });
          } else if (s.item.status === "active") {
            store.setItemStatus(
              s.item.id,
              s.item.version,
              "stale",
              "source updated",
            );
            out.items.push({ id: s.item.id, version: s.item.version });
          }
        }
        out.cards = store
          .cards()
          .filter((c) => touched.has(c.itemId))
          .map((c) => c.id);
        return out;
      });
    },
    coverage(id) {
      return all(
        "SELECT * FROM learning_coverage WHERE assessment_id=? ORDER BY rowid",
        id,
      ).map((r) => decode<CoverageRow>(r, coverageFields));
    },
    putCoverage(rows) {
      transaction(() => {
        for (const r of rows) {
          const c = concept(r.conceptId);
          const a = one(
            "SELECT account_scope,course_id FROM assessments WHERE id=?",
            r.assessmentId,
          );
          const lc = one(
            "SELECT * FROM learning_courses WHERE id=?",
            String(c.course_id),
          );
          if (
            !a ||
            !lc ||
            a.account_scope !== lc.account_scope ||
            a.course_id !== lc.course_id
          )
            throw Error("Assessment belongs to another course");
          if (r.evidenceResourceId)
            sourceCourse(r.evidenceResourceId, String(c.course_id));
          const old = one(
            "SELECT decided_by_student FROM learning_coverage WHERE assessment_id=? AND concept_id=?",
            r.assessmentId,
            r.conceptId,
          );
          if (old?.decided_by_student) continue;
          write(
            "learning_coverage",
            encode({ ...r, decidedByStudent: false }, coverageFields),
            ["assessment_id", "concept_id"],
          );
        }
      });
    },
    decideCoverage(key, status) {
      if (
        !run(
          "UPDATE learning_coverage SET status=?,decided_by_student=1 WHERE assessment_id=? AND concept_id=?",
          status,
          key.assessmentId,
          key.conceptId,
        ).changes
      )
        throw Error("Unknown coverage row");
    },
    session(id) {
      const row = one("SELECT * FROM learning_sessions WHERE id=?", id);
      return row ? decode<LearningSession>(row, sessionFields) : null;
    },
    commitSession(s, expectedRevision, attempt) {
      return transaction(() => {
        const old = store.session(s.id);
        const revision = old
          ? (old.plan as { revision?: number }).revision
          : null;
        if (revision !== expectedRevision) return false;
        if (
          attempt &&
          (attempt.sessionId !== s.id || attempt.courseRef !== s.courseRef)
        )
          throw Error("Attempt does not belong to this session");
        store.putSession(s);
        if (attempt) store.addAttempt(attempt);
        return true;
      });
    },
    putSession(s) {
      transaction(() => {
        if (s.courseRef !== null) requireCourse(s.courseRef);
        const old = one(
          "SELECT course_id FROM learning_sessions WHERE id=?",
          s.id,
        );
        if (old && old.course_id !== s.courseRef)
          throw Error("Session belongs to another course");
        write("learning_sessions", encode(s, sessionFields), ["id"]);
      });
    },
    sessions(ref) {
      return all(
        "SELECT * FROM learning_sessions WHERE course_id IS ? ORDER BY rowid",
        ref,
      ).map((r) => decode<LearningSession>(r, sessionFields));
    },
    conceptState(ref) {
      return all(
        "SELECT s.* FROM learning_concept_state s JOIN learning_concepts c ON c.id=s.concept_id WHERE c.course_id=? ORDER BY s.rowid",
        ref,
      ).map((r) => decode<ConceptStateRow>(r, stateFields));
    },
    putConceptState(rows) {
      transaction(() => {
        if (new Set(rows.map((r) => r.configVersion)).size > 1)
          throw Error("Two configuration versions in one state write");
        for (const r of rows) {
          concept(r.conceptId);
          write("learning_concept_state", encode(r, stateFields), [
            "concept_id",
          ]);
        }
      });
    },
    reset() {
      transaction(() => {
        run("DELETE FROM learning_sessions");
        run("DELETE FROM learning_courses");
        run("DELETE FROM learning_prefs");
        run("DELETE FROM learning_views");
      });
    },
  };
  return store;
}
