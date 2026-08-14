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
  isin       text PRIMARY KEY REFERENCES companies(isin) ON UPDATE CASCADE,
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
  isin   text REFERENCES companies(isin) ON UPDATE CASCADE,
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
  isin       text NOT NULL REFERENCES companies(isin) ON UPDATE CASCADE,
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

-- Quantity is derived purely from transactions, so a SPLIT or BONUS would break
-- v_holdings — the share count changes with no transaction row. This is RESOLVED
-- at query time via corporate_actions + adj_factor() below; transactions stay an
-- immutable record of what you actually did. See docs/design-corporate-identity.md.

CREATE TABLE IF NOT EXISTS cash_ledger (
  id         bigserial PRIMARY KEY,
  entry_date date NOT NULL,
  amount     numeric NOT NULL,   -- positive = inflow, negative = deployed/withdrawn
  entry_type text CHECK (entry_type IN ('deposit','withdrawal','dividend','buy','sell')),
  notes      text,
  entered_at timestamptz DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- Corporate identity & actions
--
-- Two problems, one mechanism (see docs/design-corporate-identity.md):
--   1. ISINs are NOT immutable. HDFC Bank INE040A01018 -> INE040A01034 and
--      Sun Pharma INE044A01028 -> INE044A01036, both observed 2026-08-15.
--   2. Splits and bonuses change share counts with no transaction row.
--
-- Identity is handled by UPDATE-in-place: every FK to companies(isin) is
-- ON UPDATE CASCADE, so changing companies.isin rewrites all child rows
-- atomically. All stored data therefore always uses the CURRENT ISIN, which
-- keeps every view free of alias joins. isin_aliases only records history and
-- normalises INCOMING feed data (which may carry a superseded ISIN).
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS isin_aliases (
  old_isin     text PRIMARY KEY,
  current_isin text NOT NULL REFERENCES companies(isin) ON UPDATE CASCADE,
  changed_on   date,
  reason       text,
  entered_at   timestamptz DEFAULT now(),
  CONSTRAINT isin_alias_not_self CHECK (old_isin <> current_isin)
);

-- Normalise an incoming ISIN (from a feed, a broker CSV, an old filing) to the
-- current one. Returns the input unchanged when there is no alias.
CREATE OR REPLACE FUNCTION resolve_isin(p_isin text) RETURNS text AS $$
  SELECT COALESCE((SELECT current_isin FROM isin_aliases WHERE old_isin = p_isin), p_isin);
$$ LANGUAGE sql STABLE;

-- Corporate actions — used for QUERY-TIME adjustment only. price_history and
-- transactions are never rewritten.
--
-- entry_mode/status follow the staged-ingestion contract: the corporate-actions
-- feed can propose actions by parsing subject text ("Bonus 1:1", "Face Value
-- Split..."), but a mis-parsed action would silently corrupt every quantity and
-- price in the app. So ONLY status='confirmed' rows are applied by adj_factor();
-- unconfirmed ones surface through v_pending_corporate_actions instead.
CREATE TABLE IF NOT EXISTS corporate_actions (
  id          bigserial PRIMARY KEY,
  isin        text NOT NULL REFERENCES companies(isin) ON UPDATE CASCADE,
  action_type text NOT NULL CHECK (action_type IN ('split','bonus','rights')),
  ratio_from  numeric NOT NULL CHECK (ratio_from > 0),
  ratio_to    numeric NOT NULL CHECK (ratio_to   > 0),
  ex_date     date NOT NULL,
  notes       text,
  source_url  text,
  entry_mode  text NOT NULL DEFAULT 'manual' CHECK (entry_mode IN ('auto','manual')),
  status      text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('unverified','confirmed')),
  entered_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  CONSTRAINT uq_corporate_actions UNIQUE (isin, action_type, ex_date)
);

-- The adjustment factor for ONE action.
--   split 1:5  (ratio_from 1, ratio_to 5) -> 1 share becomes 5      -> factor 5
--   bonus 1:1  (ratio_from 1, ratio_to 1) -> 1 free share per 1 held -> factor 2
--   rights                                -> factor 1, see below
--
-- RIGHTS DELIBERATELY DO NOT ADJUST. A rights issue is subscribed at a price and
-- is optional — it creates a real new lot at a real cost, so it must be entered
-- as an ordinary 'buy' transaction. Auto-scaling quantities for rights would
-- invent shares you may never have bought. The action_type is retained only so a
-- rights event can be recorded for reference.
CREATE OR REPLACE FUNCTION ca_factor(p_type text, p_from numeric, p_to numeric)
RETURNS numeric AS $$
  SELECT CASE p_type
           WHEN 'split' THEN p_to / p_from
           WHEN 'bonus' THEN 1 + p_to / p_from
           ELSE 1
         END;
$$ LANGUAGE sql IMMUTABLE;

-- Cumulative factor for everything that happened AFTER p_date.
--
-- Deliberately a plpgsql loop doing exact `numeric` multiplication, NOT the
-- exp(sum(ln(...))) idiom used in an earlier draft of the spec: exp/ln return
-- double precision, which would smuggle floating-point error into share counts
-- and prices. That violates the numeric-never-float rule for exactly the reason
-- the rule exists.
CREATE OR REPLACE FUNCTION adj_factor(p_isin text, p_date date)
RETURNS numeric AS $$
DECLARE f numeric := 1; r record;
BEGIN
  FOR r IN
    SELECT action_type, ratio_from, ratio_to
    FROM corporate_actions
    WHERE isin = p_isin AND ex_date > p_date AND status = 'confirmed'
  LOOP
    f := f * ca_factor(r.action_type, r.ratio_from, r.ratio_to);
  END LOOP;
  RETURN f;
END;
$$ LANGUAGE plpgsql STABLE;

-- Symmetry worth remembering: a historical PRICE is divided by the factor and a
-- historical QUANTITY is multiplied by it, so value (price x quantity) is
-- invariant across a split or bonus — which is exactly what should happen.

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
  isin             text NOT NULL REFERENCES companies(isin) ON UPDATE CASCADE,
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
  isin                   text NOT NULL REFERENCES companies(isin) ON UPDATE CASCADE,
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
  isin                  text NOT NULL REFERENCES companies(isin) ON UPDATE CASCADE,
  entry_date            date DEFAULT current_date,
  thesis_text           text,
  falsifier_text        text,
  conviction_level      text CHECK (conviction_level IN ('low','medium','high')),
  linked_price_at_entry numeric,
  entered_at            timestamptz DEFAULT now()
);

-- Job failure log. GitHub does NOT notify you when a scheduled workflow fails,
-- so a dashboard banner driven by this table is the ONLY alerting mechanism.
-- Every scheduled job must write here on exception. Also used for non-exception
-- alerts that need human attention, e.g. detected ISIN drift.
CREATE TABLE IF NOT EXISTS job_failures (
  id         bigserial PRIMARY KEY,
  job_name   text NOT NULL,
  error_text text,
  failed_at  timestamptz DEFAULT now()
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

DROP TRIGGER IF EXISTS trg_corporate_actions_updated ON corporate_actions;
CREATE TRIGGER trg_corporate_actions_updated BEFORE UPDATE ON corporate_actions
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
    'research_edit_history','isin_aliases','corporate_actions','job_failures'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS auth_only ON %I', t);
    EXECUTE format(
      'CREATE POLICY auth_only ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
