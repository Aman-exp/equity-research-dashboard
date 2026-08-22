-- ============================================================================
-- NSE security catalogue — the lookup behind "add a company to my watchlist".
--
-- WHY THIS TABLE EXISTS
-- ---------------------
-- Adding a company needs its ISIN, and ISIN is the primary key of the entire
-- data model. The project's hardest-won rule is that ISINs come from the UDiFF
-- BHAVCOPY and never from the filings APIs, which report the ISIN as of filing
-- time and go stale (HDFC Bank INE040A01018 -> INE040A01034, Sun Pharma
-- INE044A01028 -> INE044A01036, both still misreported by NSE today).
--
-- The browser cannot apply that rule itself: the bhavcopy is a zipped 200KB CSV
-- on a host that does not send CORS headers. Asking the user to type an ISIN by
-- hand would make the single most consequential field in the schema a manual
-- one -- exactly backwards from "manual entry is the fallback, not the default".
--
-- So the EOD job, which already downloads and parses the whole bhavcopy every
-- trading day, now also upserts the equity catalogue here. The frontend searches
-- this table, and the ISIN it inserts is therefore authoritative by construction
-- with no NSE call from the browser at all.
--
-- SCOPE: series 'EQ' and ISINs beginning 'INE' only -- actual equity shares.
-- Measured 2026-08-21: 2,285 equities, plus 347 'INF' rows that are ETF and
-- mutual-fund units and would only clutter an equity research tool. ~104 KB of
-- text, negligible against the 500 MB free tier.
-- ============================================================================

CREATE TABLE IF NOT EXISTS nse_securities (
  isin       text PRIMARY KEY,
  symbol     text NOT NULL,
  name       text,
  -- Last bhavcopy this security appeared in. A symbol that stops appearing has
  -- been delisted or renamed; keeping the row plus its date is more useful than
  -- deleting it, and makes staleness visible rather than silent.
  last_seen  date NOT NULL,
  updated_at timestamptz DEFAULT now()
);

-- Autocomplete searches by symbol first, then name.
CREATE INDEX IF NOT EXISTS idx_nse_securities_symbol ON nse_securities (symbol);
CREATE INDEX IF NOT EXISTS idx_nse_securities_name   ON nse_securities (name);

COMMENT ON TABLE nse_securities IS
  'Equity catalogue refreshed daily from the UDiFF bhavcopy by scripts/fetch_eod.py. '
  'Authoritative source of current ISINs — never populate this from a filings API.';

-- ----------------------------------------------------------------------------
-- RLS — every table, no exceptions (CLAUDE.md rule 7).
--
-- This is public exchange reference data rather than personal research, but the
-- rule is deliberately unconditional: reasoning case-by-case about which tables
-- "matter" is how an un-policied table eventually ships. `anon` still gets
-- nothing.
-- ----------------------------------------------------------------------------
ALTER TABLE nse_securities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_only ON nse_securities;
CREATE POLICY auth_only ON nse_securities
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON nse_securities TO authenticated;

-- ----------------------------------------------------------------------------
-- v_watchlist_detail — what the manage-watchlist UI reads.
--
-- Surfaces, per watched company, whether data has actually arrived yet. Adding a
-- company does NOT retroactively create price history (fetch_eod stores only
-- watchlist ISINs, so history begins at the next run unless backfilled), and a
-- row showing "no prices yet" is the honest way to say so rather than rendering
-- an empty chart.
--
-- security_invoker=true, or this view over RLS-protected tables would be
-- readable through the public anon key (CLAUDE.md rule 8).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_watchlist_detail WITH (security_invoker = true) AS
SELECT
  w.isin,
  w.active,
  w.added_date,
  w.notes,
  c.symbol_nse,
  c.company_name,
  c.sector,
  c.sector_template,
  (SELECT count(*)      FROM price_history p WHERE p.isin = w.isin) AS price_days,
  (SELECT max(p.date)   FROM price_history p WHERE p.isin = w.isin) AS latest_price_date,
  (SELECT min(p.date)   FROM price_history p WHERE p.isin = w.isin) AS earliest_price_date,
  (SELECT count(*)      FROM fundamentals_quarterly f WHERE f.isin = w.isin) AS fundamentals_rows,
  (SELECT count(*)      FROM conviction_log l WHERE l.isin = w.isin) AS conviction_entries
FROM watchlist w
JOIN companies c ON c.isin = w.isin;

GRANT SELECT ON v_watchlist_detail TO authenticated;
