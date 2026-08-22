-- ============================================================================
-- Make job failures acknowledgeable.
--
-- WHY: job_failures drives the ONLY alerting mechanism in this project (GitHub
-- does not notify on failed scheduled workflows). That makes the banner's
-- credibility load-bearing: an alert you cannot clear — for something you cannot
-- fix, like NSE's own archive 404ing on an L&T filing — trains you to ignore the
-- banner entirely, which silently destroys the alerting. Same reasoning as
-- "trading holidays are normal, not errors" in CLAUDE.md.
--
-- Acknowledging is NOT deleting: the row stays for the record, it just stops
-- shouting. First forward-only migration — 001/002 are already applied to the
-- live database, so changes from here are additive ALTERs, not edits to those.
-- ============================================================================

ALTER TABLE job_failures
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;

COMMENT ON COLUMN job_failures.acknowledged_at IS
  'Set when the user has seen and accepted this failure. Non-null rows are '
  'hidden from the dashboard banner but retained as history.';

-- Grants are re-asserted because this project sets Supabase''s "do not expose
-- new tables by default" posture explicitly rather than relying on platform
-- defaults; a new column needs no new grant, but re-running is harmless and
-- keeps the intent visible.
GRANT SELECT, INSERT, UPDATE, DELETE ON job_failures TO authenticated;
