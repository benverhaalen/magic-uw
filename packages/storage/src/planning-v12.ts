import { PLANNING_CAPTURES_KEPT } from "./planning";

/**
 * v12 (planning-perf): additive and idempotent, so a renumbered or repeated run is harmless.
 * An index for the per-source record scan on complete reads, and the raw capture log pruned to
 * the latest few per source (records and their versions are untouched).
 */
export const PLANNING_V12 = `
  CREATE INDEX IF NOT EXISTS planning_records_source ON planning_records(source_id, deleted);
  DELETE FROM planning_captures WHERE rowid IN (
    SELECT rowid FROM (
      SELECT rowid, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY observed_at DESC) AS position
      FROM planning_captures
    ) WHERE position > ${PLANNING_CAPTURES_KEPT}
  );
`;
