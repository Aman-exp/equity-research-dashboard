-- ============================================================================
-- Phase 0 schema — tables, constraints, triggers, RLS.
-- Run this first, then 002_phase0_views.sql, then sql/seed/phase0_companies.sql.
--
-- Conventions enforced here (see CLAUDE.md):
--   * Money and quantities are `numeric`, never float/real.
--   * ISIN is the company key. Never key on ticker symbol.
--   * All timestamps are timestamptz (display in Asia/Kolkata at the UI layer).
--   * `holdings` is a VIEW derived from lot-level transactions — never a table,
--     and never stores an average cost basis (see 002_phase0_views.sql).
--   * RLS is enabled + policied on EVERY table. An un-policied table in Supabase
--     is publicly readable through the auto-generated API.
--   * Single user: no user_id columns anywhere, by design.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Reference data
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS companies (
  isin                  text PRIMARY KEY,
  symbol_nse            text,
  symbol_bse            text,
  company_name          text NOT NULL,
  sector                text,
  industry              text,
  listing_date          date,
  fiscal_year_end_month smallint DEFAULT 3 CHECK (fiscal_year_end_month BETWEEN 1 AND 12),
  sector_template       text,
  entered_at            timestamptz DEFAULT now()
);

COMMENT ON COLUMN companies.sector_template IS
  'Drives which form fields show. Phase 0 uses: bank, fmcg, capital_goods, it_services, pharma. '
  'Field sets for it_services and pharma still need designing before Phase 1 form work.';

CREATE TABLE IF NOT EXISTS watchlist (
  isin       text PRIMARY KEY REFERENCES companies(isin),
  added_date date DEFAULT current_date,
  active     boolean DEFAULT true,
  notes      text
);

-- ----------------------------------------------------------------------------
-- Market data
-- ----------------------------------------------------------------------------

-- Raw EOD prices exactly as reported. NEVER mutated — split/bonus adjustment
-- happens at query time (v_price_adjusted, Phase 3) against corporate_actions.
CREATE TABLE IF NOT EXISTS price_history (
  isin   text REFERENCES companies(isin),
  date   date,
  open   numeric,
  high   numeric,
  low    numeric,
  close  numeric,
  volume bigint,
  PRIMARY KEY (isin, date)
);

-- Benchmark index EOD values. Populated by the same bhavcopy job as price_history.
-- Without this, absolute portfolio returns are uninterpretable.
CREATE TABLE IF NOT EXISTS index_history (
  index_name text,
  date       date,
  close      numeric,
  PRIMARY KEY (index_name, date)
);

-- ----------------------------------------------------------------------------
-- Portfolio (real money only — paper trading is Phase 3, in separate tables)
-- ----------------------------------------------------------------------------

-- Lot-level transactions. This is the BASE table; positions are derived from it.
-- Never add an avg_buy_price here or anywhere: Indian LTCG/STCG applies the
-- >12-month test per lot, and grandfathering (31 Jan 2018 FMV) needs the original
-- lot date. An averaged cost basis makes FIFO tax computation impossible to
-- retrofit.
CREATE TABLE IF NOT EXISTS transactions (
  id         bigserial PRIMARY KEY,
  isin       text NOT NULL REFERENCES companies(isin),
  txn_type   text NOT NULL CHECK (txn_type IN ('buy','sell')),
  txn_date   date NOT NULL,
  quantity   numeric NOT NULL CHECK (quantity > 0),
  price      numeric NOT NULL CHECK (price >= 0),
  charges    numeric DEFAULT 0 CHECK (charges >= 0),  -- brokerage + STT + stamp duty + GST
  notes      text,
  entered_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_isin_date ON transactions (isin, txn_date);

-- KNOWN GAP (Phase 0 accepts this; decide before entering pre-2019 history):
-- quantity is derived purely from transactions, so a SPLIT or BONUS silently
-- breaks v_holdings — the user's share count changes with no transaction row.
-- This is live for the Phase 0 watchlist (e.g. L&T 1:2 bonus 2017, Infosys 1:1
-- bonus 2018). Two different mechanisms are needed and they are NOT the same:
--   * Bonus  -> arguably a zero-price 'buy' lot: tax-correct, since bonus shares
--               have zero cost of acquisition and their own holding period.
--   * Split  -> must rescale EXISTING lots (quantity up, per-share cost down);
--               it does not create a new lot.
-- Do not paper over this with a single 'adjustment' txn_type. Resolve it with
-- corporate_actions in Phase 1 before loading long transaction history.

CREATE TABLE IF NOT EXISTS cash_ledger (
  id         bigserial PRIMARY KEY,
  entry_date date NOT NULL,
  amount     numeric NOT NULL,   -- positive = inflow, negative = deployed/withdrawn
  entry_type text CHECK (entry_type IN ('deposit','withdrawal','dividend','buy','sell')),
  notes      text,
  entered_at timestamptz DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- Research tables
--
-- entry_mode / status implement the staged-ingestion contract: deterministic
-- feed jobs (XBRL, shareholding pattern) insert 'auto'/'unverified' rows, and
-- the review inbox flips them to 'confirmed' in one tap instead of the user
-- transcribing figures by hand. Manual entry stays fully functional as the
-- fallback path — feeds break.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fundamentals_quarterly (
  id               bigserial PRIMARY KEY,
  isin             text NOT NULL REFERENCES companies(isin),
  period_end       date NOT NULL,
  filing_type      text NOT NULL CHECK (filing_type IN ('standalone','consolidated')),
  revenue          numeric,
  ebitda           numeric,
  pat              numeric,
  cfo              numeric,   -- cash flow from operations: highest-signal field.
                              -- Not tagged in every quarterly XBRL (half-yearly/annual
                              -- only) — expect null on auto rows, fill on confirm.
  capex            numeric,   -- same caveat as cfo
  receivable_days  numeric,
  inventory_days   numeric,
  payable_days     numeric,
  debt_total       numeric,
  equity_total     numeric,
  interest_expense numeric,
  ebit             numeric,
  eps              numeric,
  source_url       text,
  source_page      text,
  entry_mode       text NOT NULL DEFAULT 'manual' CHECK (entry_mode IN ('auto','manual')),
  status           text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('unverified','confirmed')),
  entered_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  CONSTRAINT uq_fundamentals UNIQUE (isin, period_end, filing_type)
);

CREATE TABLE IF NOT EXISTS governance_tracking (
  id                     bigserial PRIMARY KEY,
  isin                   text NOT NULL REFERENCES companies(isin),
  as_of_date             date NOT NULL,
  promoter_holding_pct   numeric,
  promoter_pledge_pct    numeric,   -- key distress signal
  fii_holding_pct        numeric,
  dii_holding_pct        numeric,
  rpt_value              numeric,
  rpt_notes              text,
  contingent_liabilities numeric,
  auditor_name           text,
  auditor_changed_flag   boolean DEFAULT false,
  auditor_opinion        text CHECK (auditor_opinion IN ('unqualified','qualified','adverse','disclaimer')),
  cfo_cs_change_flag     boolean DEFAULT false,
  cfo_cs_change_notes    text,
  filing_delay_flag      boolean DEFAULT false,
  exchange_notice_flag   boolean DEFAULT false,
  exchange_notice_notes  text,
  source_url             text,
  entry_mode             text NOT NULL DEFAULT 'manual' CHECK (entry_mode IN ('auto','manual')),
  status                 text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('unverified','confirmed')),
  entered_at             timestamptz DEFAULT now(),
  updated_at             timestamptz DEFAULT now(),
  CONSTRAINT uq_governance UNIQUE (isin, as_of_date)
);

-- Append-only by convention: the UI must not offer edit/delete on past entries.
-- Corrections go in as a new dated entry, so past reasoning is never rewritten.
CREATE TABLE IF NOT EXISTS conviction_log (
  id                    bigserial PRIMARY KEY,
  isin                  text NOT NULL REFERENCES companies(isin),
  entry_date            date DEFAULT current_date,
  thesis_text           text,
  falsifier_text        text,
  conviction_level      text CHECK (conviction_level IN ('low','medium','high')),
  linked_price_at_entry numeric,
  entered_at            timestamptz DEFAULT now()
);

-- Audit trail satisfying the requirements doc's append-only mandate: live tables
-- stay current and easy to query, full correction history is preserved here.
CREATE TABLE IF NOT EXISTS research_edit_history (
  id          bigserial PRIMARY KEY,
  table_name  text NOT NULL,
  row_id      bigint NOT NULL,
  old_values  jsonb NOT NULL,
  changed_at  timestamptz DEFAULT now(),
  change_note text
);

-- ----------------------------------------------------------------------------
-- Triggers
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_transactions_updated ON transactions;
CREATE TRIGGER trg_transactions_updated BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_fundamentals_updated ON fundamentals_quarterly;
CREATE TRIGGER trg_fundamentals_updated BEFORE UPDATE ON fundamentals_quarterly
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_governance_updated ON governance_tracking;
CREATE TRIGGER trg_governance_updated BEFORE UPDATE ON governance_tracking
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Snapshot the old row before any update to a research table.
CREATE OR REPLACE FUNCTION log_research_edit() RETURNS trigger AS $$
BEGIN
  INSERT INTO research_edit_history (table_name, row_id, old_values)
  VALUES (TG_TABLE_NAME, OLD.id, to_jsonb(OLD));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fundamentals_history ON fundamentals_quarterly;
CREATE TRIGGER trg_fundamentals_history BEFORE UPDATE ON fundamentals_quarterly
  FOR EACH ROW EXECUTE FUNCTION log_research_edit();

DROP TRIGGER IF EXISTS trg_governance_history ON governance_tracking;
CREATE TRIGGER trg_governance_history BEFORE UPDATE ON governance_tracking
  FOR EACH ROW EXECUTE FUNCTION log_research_edit();

-- ----------------------------------------------------------------------------
-- Row-Level Security — every table, no exceptions.
-- Single user, so a blanket authenticated-only policy is correct; per-row
-- ownership scoping would be unnecessary complexity.
-- ----------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'companies','watchlist','price_history','index_history','transactions',
    'cash_ledger','fundamentals_quarterly','governance_tracking','conviction_log',
    'research_edit_history'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS auth_only ON %I', t);
    EXECUTE format(
      'CREATE POLICY auth_only ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
