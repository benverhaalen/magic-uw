/** N24 alignment: explicit fields missing from v7's engine/storage mapping.
 * Existing item-backed cards retain their version; course/concept come from that
 * exact item and its primary tag. Legacy untagged cards retain a null concept.
 * Concept tracks may now name a concept without inventing a learning item.
 * Historical v6/v7 migrations remain unchanged.
 */
export const LEARNING_V8 = `
ALTER TABLE learning_items ADD COLUMN unit TEXT;
ALTER TABLE learning_attempts ADD COLUMN option_id TEXT;
ALTER TABLE learning_coverage ADD COLUMN decided_by_student INTEGER NOT NULL DEFAULT 0;
-- v7 did not record decision authorship. Preserve every non-proposed status
-- conservatively rather than allowing a rebuild to erase a possible student decision.
UPDATE learning_coverage SET decided_by_student=1 WHERE status <> 'proposed';
CREATE TABLE learning_cards_v8 (
 id TEXT PRIMARY KEY,
 item_id TEXT, item_version INTEGER,
 course_id TEXT NOT NULL REFERENCES learning_courses(id) ON DELETE CASCADE,
 concept_id TEXT REFERENCES learning_concepts(id) ON DELETE CASCADE,
 track_item_id TEXT,
 due TEXT NOT NULL, stability REAL NOT NULL, difficulty REAL NOT NULL,
 elapsed_days INTEGER NOT NULL, scheduled_days INTEGER NOT NULL, learning_steps INTEGER NOT NULL DEFAULT 0,
 reps INTEGER NOT NULL, lapses INTEGER NOT NULL, state INTEGER NOT NULL, last_review TEXT,
 fsrs_version TEXT NOT NULL, params_hash TEXT NOT NULL, is_concept_track INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(item_id,item_version) REFERENCES learning_items(id,version) ON DELETE CASCADE,
 CHECK ((item_id IS NOT NULL AND item_version IS NOT NULL) OR (is_concept_track = 1 AND concept_id IS NOT NULL))
);
INSERT INTO learning_cards_v8
 SELECT c.id,c.item_id,c.item_version,i.course_id,
 (SELECT concept_id FROM learning_item_concepts t WHERE t.item_id=c.item_id AND t.item_version=c.item_version ORDER BY t."primary" DESC,t.concept_id LIMIT 1),
 NULL,c.due,c.stability,c.difficulty,c.elapsed_days,c.scheduled_days,c.learning_steps,c.reps,c.lapses,c.state,c.last_review,c.fsrs_version,c.params_hash,c.is_concept_track
 FROM learning_cards c LEFT JOIN learning_items i ON i.id=c.item_id AND i.version=c.item_version;
CREATE TABLE learning_reviews_v8 (
 id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES learning_cards_v8(id) ON DELETE CASCADE,
 rating INTEGER NOT NULL, state_before_json TEXT NOT NULL,state_after_json TEXT NOT NULL,
 review_ms INTEGER,local_day TEXT NOT NULL,undoes_review_id TEXT,created_at TEXT NOT NULL
);
INSERT INTO learning_reviews_v8 SELECT * FROM learning_reviews;
DROP TABLE learning_reviews;
DROP TABLE learning_cards;
ALTER TABLE learning_cards_v8 RENAME TO learning_cards;
ALTER TABLE learning_reviews_v8 RENAME TO learning_reviews;
CREATE INDEX learning_cards_item ON learning_cards(item_id,item_version);
CREATE INDEX learning_cards_due ON learning_cards(due);
CREATE INDEX learning_reviews_card ON learning_reviews(card_id,created_at);
`;
