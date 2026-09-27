/**
 * Schema v7: learning and practice tables (T10L; plan D17; learning spec §7.2 as amended, and the
 * practice addendum §6). `learning_courses` is the anchor (id = `accountScope:courseId`); every
 * other table cascades from it, a concept, an item, a card, an assessment or a resource.
 * Replaced, so never created: learning_passages and learning_passage_search (by passages and
 * passage_fts), learning_jobs (by the extended jobs). Dropped features, never created:
 * learning_notifications, learning_digests.
 * IF NOT EXISTS keeps the step idempotent for a file that already holds the tables.
 */
export const LEARNING_TABLES = [
  "learning_courses",
  "learning_concepts",
  "learning_concept_aliases",
  "learning_concept_sources",
  "learning_items",
  "learning_item_sources",
  "learning_item_concepts",
  "learning_item_checks",
  "learning_cards",
  "learning_reviews",
  "learning_attempts",
  "learning_self_ratings",
  "learning_disputes",
  "learning_artifacts",
  "learning_artifact_sources",
  "learning_coverage",
  "learning_sessions",
  "learning_concept_state",
  "learning_prefs",
  "learning_stars",
  "learning_option_tags",
  "learning_views",
] as const;

export const LEARNING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS learning_courses (
    id TEXT PRIMARY KEY, account_scope TEXT NOT NULL, course_id TEXT NOT NULL,
    label TEXT NOT NULL, term TEXT, created_at TEXT NOT NULL,
    UNIQUE (account_scope, course_id)
  );
  CREATE TABLE IF NOT EXISTS learning_concepts (
    id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES learning_courses(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES learning_concepts(id) ON DELETE SET NULL,
    label TEXT NOT NULL, kind TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    merged_into TEXT REFERENCES learning_concepts(id) ON DELETE SET NULL,
    student_label TEXT, map_version TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS learning_concepts_course ON learning_concepts(course_id);
  CREATE INDEX IF NOT EXISTS learning_concepts_parent ON learning_concepts(parent_id);
  CREATE INDEX IF NOT EXISTS learning_concepts_merged ON learning_concepts(merged_into);
  CREATE TABLE IF NOT EXISTS learning_concept_aliases (
    concept_id TEXT NOT NULL REFERENCES learning_concepts(id) ON DELETE CASCADE,
    alias TEXT NOT NULL, origin TEXT NOT NULL,
    PRIMARY KEY (concept_id, alias)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS learning_concept_aliases_alias ON learning_concept_aliases(alias);
  CREATE TABLE IF NOT EXISTS learning_concept_sources (
    concept_id TEXT NOT NULL REFERENCES learning_concepts(id) ON DELETE CASCADE,
    resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    start INTEGER NOT NULL, "end" INTEGER NOT NULL, content_hash TEXT NOT NULL,
    quote TEXT NOT NULL, quote_valid INTEGER NOT NULL,
    PRIMARY KEY (concept_id, resource_id, start)
  );
  CREATE INDEX IF NOT EXISTS learning_concept_sources_resource ON learning_concept_sources(resource_id);
  CREATE TABLE IF NOT EXISTS learning_items (
    id TEXT NOT NULL, version INTEGER NOT NULL,
    course_id TEXT NOT NULL REFERENCES learning_courses(id) ON DELETE CASCADE,
    family_id TEXT, kind TEXT NOT NULL, stem TEXT NOT NULL, options_json TEXT, key_json TEXT NOT NULL,
    key_ideas_json TEXT, explanation TEXT, tempting_json TEXT, bloom TEXT, b_prior REAL,
    tier TEXT NOT NULL, source_term TEXT, origin TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    status_reason TEXT, generator_json TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY (id, version)
  );
  CREATE INDEX IF NOT EXISTS learning_items_course ON learning_items(course_id, status);
  CREATE INDEX IF NOT EXISTS learning_items_family ON learning_items(family_id);
  CREATE TABLE IF NOT EXISTS learning_item_sources (
    item_id TEXT NOT NULL, item_version INTEGER NOT NULL,
    resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    start INTEGER NOT NULL, "end" INTEGER NOT NULL, content_hash TEXT NOT NULL, text_hash TEXT NOT NULL,
    quote TEXT NOT NULL, quote_valid INTEGER NOT NULL,
    PRIMARY KEY (item_id, item_version, resource_id, start),
    FOREIGN KEY (item_id, item_version) REFERENCES learning_items(id, version) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS learning_item_sources_resource ON learning_item_sources(resource_id);
  CREATE TABLE IF NOT EXISTS learning_item_concepts (
    item_id TEXT NOT NULL, item_version INTEGER NOT NULL,
    concept_id TEXT NOT NULL REFERENCES learning_concepts(id) ON DELETE CASCADE,
    weight REAL NOT NULL, "primary" INTEGER NOT NULL,
    PRIMARY KEY (item_id, item_version, concept_id),
    FOREIGN KEY (item_id, item_version) REFERENCES learning_items(id, version) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS learning_item_concepts_concept ON learning_item_concepts(concept_id);
  CREATE TABLE IF NOT EXISTS learning_item_checks (
    item_id TEXT NOT NULL, item_version INTEGER NOT NULL, "check" TEXT NOT NULL,
    method TEXT NOT NULL, outcome TEXT NOT NULL, detail_json TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY (item_id, item_version, "check"),
    FOREIGN KEY (item_id, item_version) REFERENCES learning_items(id, version) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS learning_cards (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL, item_version INTEGER NOT NULL,
    due TEXT NOT NULL, stability REAL NOT NULL, difficulty REAL NOT NULL,
    elapsed_days INTEGER NOT NULL, scheduled_days INTEGER NOT NULL, learning_steps INTEGER NOT NULL DEFAULT 0,
    reps INTEGER NOT NULL, lapses INTEGER NOT NULL, state INTEGER NOT NULL, last_review TEXT,
    fsrs_version TEXT NOT NULL, params_hash TEXT NOT NULL, is_concept_track INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (item_id, item_version) REFERENCES learning_items(id, version) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS learning_cards_item ON learning_cards(item_id, item_version);
  CREATE INDEX IF NOT EXISTS learning_cards_due ON learning_cards(due);
  CREATE TABLE IF NOT EXISTS learning_reviews (
    id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES learning_cards(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL, state_before_json TEXT NOT NULL, state_after_json TEXT NOT NULL,
    review_ms INTEGER, local_day TEXT NOT NULL, undoes_review_id TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS learning_reviews_card ON learning_reviews(card_id, created_at);
  CREATE TABLE IF NOT EXISTS learning_attempts (
    id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES learning_courses(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL, item_version INTEGER NOT NULL,
    source_resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
    primary_concept_id TEXT, correct INTEGER NOT NULL, assistance TEXT NOT NULL, seen_before INTEGER NOT NULL,
    confidence REAL, created_at TEXT NOT NULL, format TEXT NOT NULL, mode TEXT NOT NULL, response_json TEXT,
    score REAL, grading_method TEXT, response_ms INTEGER, concept_tags_json TEXT, session_id TEXT, local_day TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS learning_attempts_course ON learning_attempts(course_id, created_at);
  CREATE INDEX IF NOT EXISTS learning_attempts_item ON learning_attempts(item_id, item_version);
  CREATE INDEX IF NOT EXISTS learning_attempts_resource ON learning_attempts(source_resource_id);
  CREATE TABLE IF NOT EXISTS learning_self_ratings (
    id TEXT PRIMARY KEY, concept_id TEXT NOT NULL REFERENCES learning_concepts(id) ON DELETE CASCADE,
    rating TEXT NOT NULL, delayed INTEGER NOT NULL, local_day TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS learning_self_ratings_concept ON learning_self_ratings(concept_id);
  CREATE TABLE IF NOT EXISTS learning_disputes (
    id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES learning_courses(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, note TEXT,
    status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS learning_disputes_course ON learning_disputes(course_id);
  CREATE INDEX IF NOT EXISTS learning_disputes_target ON learning_disputes(target_kind, target_id);
  CREATE TABLE IF NOT EXISTS learning_artifacts (
    id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES learning_courses(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, pack TEXT NOT NULL, pack_version TEXT NOT NULL, scope_json TEXT NOT NULL,
    cache_key TEXT NOT NULL UNIQUE, body_json TEXT NOT NULL, removed_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, generator_json TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS learning_artifacts_course ON learning_artifacts(course_id, kind);
  CREATE TABLE IF NOT EXISTS learning_artifact_sources (
    artifact_id TEXT NOT NULL REFERENCES learning_artifacts(id) ON DELETE CASCADE,
    resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (artifact_id, resource_id)
  );
  CREATE INDEX IF NOT EXISTS learning_artifact_sources_resource ON learning_artifact_sources(resource_id);
  CREATE TABLE IF NOT EXISTS learning_coverage (
    assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    concept_id TEXT NOT NULL REFERENCES learning_concepts(id) ON DELETE CASCADE,
    basis TEXT NOT NULL, tier TEXT NOT NULL,
    evidence_resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
    start INTEGER, "end" INTEGER, quote TEXT, status TEXT NOT NULL,
    PRIMARY KEY (assessment_id, concept_id)
  );
  CREATE INDEX IF NOT EXISTS learning_coverage_concept ON learning_coverage(concept_id);
  CREATE INDEX IF NOT EXISTS learning_coverage_resource ON learning_coverage(evidence_resource_id);
  CREATE TABLE IF NOT EXISTS learning_sessions (
    id TEXT PRIMARY KEY, course_id TEXT REFERENCES learning_courses(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, plan_json TEXT NOT NULL, minutes INTEGER, difficulty TEXT,
    started_at TEXT NOT NULL, ended_at TEXT
  );
  CREATE INDEX IF NOT EXISTS learning_sessions_course ON learning_sessions(course_id, started_at);
  CREATE TABLE IF NOT EXISTS learning_concept_state (
    concept_id TEXT PRIMARY KEY REFERENCES learning_concepts(id) ON DELETE CASCADE,
    theta REAL NOT NULL, n REAL NOT NULL, s REAL, p_hat REAL, r REAL, band TEXT NOT NULL,
    reasons_json TEXT, counts_json TEXT, config_version TEXT NOT NULL, computed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS learning_prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS learning_stars (
    course_id TEXT NOT NULL REFERENCES learning_courses(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL, target_id TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (target_kind, target_id)
  );
  CREATE INDEX IF NOT EXISTS learning_stars_course ON learning_stars(course_id);
  CREATE TABLE IF NOT EXISTS learning_option_tags (
    item_id TEXT NOT NULL, item_version INTEGER NOT NULL, option_id TEXT NOT NULL,
    concept_id TEXT NOT NULL REFERENCES learning_concepts(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, item_version, option_id),
    FOREIGN KEY (item_id, item_version) REFERENCES learning_items(id, version) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS learning_option_tags_concept ON learning_option_tags(concept_id);
  CREATE TABLE IF NOT EXISTS learning_views (
    id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    version INTEGER NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL,
    active_seconds INTEGER NOT NULL, local_day TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS learning_views_resource ON learning_views(resource_id, local_day);
`;
