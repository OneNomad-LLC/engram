-- 003_kg_confidence.sql — R-002 + R-004
--
-- R-002: Add confidence column to knowledge_triples.
--   Previously missing; the adapter hardcoded 0.5 on every read,
--   so "confidence grows with evidence" was a no-op on Postgres.
--
-- R-004: Add UNIQUE partial index on active triples.
--   Guards the check-then-insert race: two concurrent addTriple calls
--   for the same (tenant, subject, predicate, object) both pass the
--   app-level queryTriples check and reach INSERT. The index makes the
--   second INSERT a no-op (ON CONFLICT DO NOTHING) instead of a
--   duplicate active triple. invalidated_at IS NULL scopes the
--   constraint to active triples only so the same SPO can be
--   re-asserted after invalidation.

ALTER TABLE knowledge_triples
  ADD COLUMN IF NOT EXISTS confidence REAL NOT NULL DEFAULT 0.5;

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_triples_active_spo_idx
  ON knowledge_triples (tenant_id, subject, predicate, object)
  WHERE invalidated_at IS NULL;
