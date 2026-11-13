-- Snapshot-only migration: refreshes Drizzle's meta snapshot to the v0.3
-- schema. Earlier migrations 0004-0013 are hand-written; this file must still
-- contain a statement because the SQLite migrator rejects an empty migration.
SELECT 1;
