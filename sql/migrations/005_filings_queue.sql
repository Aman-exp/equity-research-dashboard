-- ============================================================================
-- Phase 1: the task queue.
--
-- This is the table behind "tell me what to do today" — the announcement-feed
-- diff the build spec calls the entire daily-loop feature (Section 8, job 2).
-- Deterministic routing only: NSE's own category string decides document_type.
-- No inference, no AI, nothing that costs money.
--
-- Forward-only. 001/002 are applied to live; 003/004 preceded this.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- filings_queue — one row per announcement worth a human look.
--
-- Shape follows the build spec, with three additions justified by real data
-- measured from NSE on 2026-08-22:
--
--   * external_ref + a unique index. NSE's `seq_id` makes re-ingestion
--     idempotent. Without it, a daily job polling a 7-day window would insert
--     every announcement seven times.
--   * announced_at, distinct from captured_at. The spec had only captured_at,
--     which records when WE saw it, not when the company filed it — the queue
--     must sort by the latter or a backfill scrambles the ordering.
--   * status 'dismissed', alongside the spec's pending/processed. An item you
--     cannot clear without pretending you actioned it is the same trap the
--     acknowledged-job-failures work (003) was built to escape: a counter you
--     can never zero teaches you to ignore the counter. Dismissing is explicit
--     and reversible; it is not the same claim as "processed".
--
-- document_type extends the spec's vocabulary with corporate_action, governance
-- and material_event, because those categories genuinely arrive in the feed
-- (verified: "Scheme of Arrangement", "Change in Director(s)", "Record Date")
-- and collapsing them into 'other' would make the queue unsortable.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS filings_queue (
  id            bigserial PRIMARY KEY,
  -- Nullable by design: the spec allows capture before tagging (mobile capture,
  -- Phase 2). The announcement job always sets it.
  isin          text REFERENCES companies(isin) ON UPDATE CASCADE,
  document_type text NOT NULL DEFAULT 'other' CHECK (document_type IN (
                  'quarterly_result','annual_report','rating_action',
                  'shareholding_pattern','concall','corporate_action',
                  'governance','material_event','other','review_due')),
  title         text,          -- NSE's category string, verbatim
  note          text,          -- the announcement's own summary text
  source_url    text,          -- PDF on nsearchives
  announced_at  timestamptz,   -- when the company filed it (IST, from the feed)
  external_ref  text,          -- NSE seq_id
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processed','dismissed')),
  captured_at   timestamptz DEFAULT now(),
  processed_at  timestamptz
);

-- Idempotency. Partial, so hand-captured rows (Phase 2 mobile capture) need no
-- external_ref while feed rows can never duplicate. Same pattern as
-- transactions.external_ref.
CREATE UNIQUE INDEX IF NOT EXISTS uq_filings_queue_external_ref
  ON filings_queue (external_ref) WHERE external_ref IS NOT NULL;

-- The queue's only hot query: pending items, newest first.
CREATE INDEX IF NOT EXISTS idx_filings_queue_status_date
  ON filings_queue (status, announced_at DESC);

-- Stamp processed_at in the database rather than trusting every caller to
-- remember. Clearing an item back to 'pending' clears the stamp too, so the
-- column never claims something that is not true.
CREATE OR REPLACE FUNCTION set_filings_queue_processed_at() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status IN ('processed','dismissed') THEN
      NEW.processed_at = now();
    ELSE
      NEW.processed_at = NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_filings_queue_processed ON filings_queue;
CREATE TRIGGER trg_filings_queue_processed BEFORE UPDATE ON filings_queue
  FOR EACH ROW EXECUTE FUNCTION set_filings_queue_processed_at();

-- ----------------------------------------------------------------------------
-- Known ISIN drift — populate the alias table.
--
-- isin_aliases was empty, which made resolve_isin() a silent no-op for the two
-- companies that have actually drifted. Verified live against the announcements
-- feed on 2026-08-22: it still reports HDFC Bank as INE040A01018 and Sun Pharma
-- as INE044A01028, both superseded. The announcement job deliberately matches on
-- SYMBOL rather than the feed's ISIN for exactly this reason, but any other
-- inbound path (broker CSV, an old filing) needs these aliases to resolve.
--
-- Direction matters: old_isin -> current_isin. See docs/design-corporate-identity.md.
-- ----------------------------------------------------------------------------
INSERT INTO isin_aliases (old_isin, current_isin, changed_on, reason) VALUES
  ('INE040A01018', 'INE040A01034', NULL,
   'HDFC Bank — superseded ISIN still reported by NSE filings/announcements APIs; '
   'current value confirmed from the UDiFF bhavcopy'),
  ('INE044A01028', 'INE044A01036', NULL,
   'Sun Pharma — superseded ISIN still reported by NSE filings/announcements APIs; '
   'current value confirmed from the UDiFF bhavcopy')
ON CONFLICT (old_isin) DO NOTHING;

-- ----------------------------------------------------------------------------
-- RLS — every table, no exceptions (CLAUDE.md rule 7). An un-policied table in
-- Supabase is publicly readable through the auto-generated REST API.
-- ----------------------------------------------------------------------------
ALTER TABLE filings_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_only ON filings_queue;
CREATE POLICY auth_only ON filings_queue
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON filings_queue TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE filings_queue_id_seq TO authenticated;

-- ----------------------------------------------------------------------------
-- v_task_queue — what the dashboard reads.
--
-- security_invoker=true, or this view over an RLS-protected table would be
-- readable through the public anon key (CLAUDE.md rule 8).
--
-- priority is a deterministic sort key, not a judgement: results and rating
-- actions outrank concalls and order wins, which outrank everything else. It
-- exists so the dashboard can surface the two things that change a thesis
-- without the user scanning a flat list.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_task_queue WITH (security_invoker = true) AS
SELECT
  q.id,
  q.isin,
  c.company_name,
  c.symbol_nse,
  q.document_type,
  q.title,
  q.note,
  q.source_url,
  q.announced_at,
  q.status,
  q.captured_at,
  CASE q.document_type
    WHEN 'quarterly_result'     THEN 1
    WHEN 'rating_action'        THEN 1
    WHEN 'review_due'           THEN 1
    WHEN 'corporate_action'     THEN 2
    WHEN 'material_event'       THEN 2
    WHEN 'governance'           THEN 2
    WHEN 'concall'              THEN 3
    ELSE 4
  END AS priority
FROM filings_queue q
LEFT JOIN companies c ON c.isin = q.isin
WHERE q.status = 'pending'
ORDER BY priority, q.announced_at DESC NULLS LAST;

GRANT SELECT ON v_task_queue TO authenticated;
