-- ============================================================================
-- Phase 0 computed views. Run after 001_phase0_schema.sql.
--
-- All computed values are views, never stored columns — P/E, portfolio value,
-- concentration and holdings are derived on read.
--
-- SECURITY NOTE: every view is created WITH (security_invoker = true).
-- By default a Postgres view runs with its OWNER's privileges, which in Supabase
-- means a view over an RLS-protected table BYPASSES that RLS and becomes readable
-- through the anon key. security_invoker makes the querying user's RLS apply, so
-- these views stay authenticated-only like the tables beneath them. Do not drop
-- this clause when adding views later.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Holdings — DERIVED, never a table.
-- avg_cost here is a display convenience computed on read (buy-side cost incl.
-- charges). It is NOT a stored cost basis and must never be persisted: FIFO tax
-- computation in Phase 3 consumes the underlying lots from `transactions`.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_holdings WITH (security_invoker = true) AS
SELECT
  t.isin,
  sum(CASE WHEN t.txn_type = 'buy' THEN t.quantity ELSE -t.quantity END) AS quantity,
  sum(CASE WHEN t.txn_type = 'buy' THEN t.quantity * t.price + t.charges ELSE 0 END)
    / NULLIF(sum(CASE WHEN t.txn_type = 'buy' THEN t.quantity ELSE 0 END), 0)  AS avg_cost
FROM transactions t
GROUP BY t.isin
HAVING sum(CASE WHEN t.txn_type = 'buy' THEN t.quantity ELSE -t.quantity END) > 0;

-- ----------------------------------------------------------------------------
-- Portfolio summary: current value and unrealised P&L per holding.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_portfolio_summary WITH (security_invoker = true) AS
SELECT
  h.isin,
  c.company_name,
  h.quantity,
  h.avg_cost,
  p.close                                   AS current_price,
  p.date                                    AS price_as_of,
  h.quantity * p.close                      AS current_value,
  h.quantity * (p.close - h.avg_cost)       AS unrealized_pnl,
  CASE WHEN h.avg_cost > 0
       THEN 100 * (p.close - h.avg_cost) / h.avg_cost
  END                                       AS unrealized_pnl_pct
FROM v_holdings h
JOIN companies c ON c.isin = h.isin
LEFT JOIN LATERAL (
  SELECT ph.close, ph.date
  FROM price_history ph
  WHERE ph.isin = h.isin
  ORDER BY ph.date DESC
  LIMIT 1
) p ON true;

-- ----------------------------------------------------------------------------
-- Concentration & sector exposure. Concentration risk is the most likely real
-- danger to a retail equity portfolio, and this needs no new data.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_concentration WITH (security_invoker = true) AS
SELECT
  c.sector,
  s.isin,
  s.company_name,
  s.current_value,
  100 * s.current_value / NULLIF(sum(s.current_value) OVER (), 0)          AS pct_of_portfolio,
  100 * sum(s.current_value) OVER (PARTITION BY c.sector)
      / NULLIF(sum(s.current_value) OVER (), 0)                            AS pct_of_sector
FROM v_portfolio_summary s
JOIN companies c ON c.isin = s.isin;

-- ----------------------------------------------------------------------------
-- Cash available for deployment.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_cash_position WITH (security_invoker = true) AS
SELECT COALESCE(sum(amount), 0) AS cash_available FROM cash_ledger;

-- ----------------------------------------------------------------------------
-- Trailing-twelve-month EPS: sum of the last 4 quarters.
-- P/E must use TTM EPS, never a single quarter's EPS.
--
-- has_unverified surfaces (rather than hides) staged auto-ingested rows, per the
-- staged-ingestion contract: the UI flags the number, the user decides — the
-- system never silently includes or excludes unconfirmed data.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_ttm_eps WITH (security_invoker = true) AS
SELECT
  isin,
  filing_type,
  max(period_end)                             AS as_of,
  sum(eps)                                    AS eps_ttm,
  bool_or(status = 'unverified')              AS has_unverified
FROM (
  SELECT
    f.*,
    row_number() OVER (PARTITION BY f.isin, f.filing_type ORDER BY f.period_end DESC) AS rn
  FROM fundamentals_quarterly f
  WHERE f.eps IS NOT NULL
) q
WHERE rn <= 4
GROUP BY isin, filing_type
HAVING count(*) = 4;   -- only meaningful with a full four quarters

-- ----------------------------------------------------------------------------
-- Current P/E against TTM EPS. (5-year P/E bands are Phase 3.)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_pe_current WITH (security_invoker = true) AS
SELECT
  c.isin,
  c.company_name,
  t.filing_type,
  p.close                              AS price_current,
  p.date                               AS price_as_of,
  t.eps_ttm,
  t.as_of                              AS eps_as_of,
  p.close / NULLIF(t.eps_ttm, 0)       AS pe_current,
  t.has_unverified
FROM companies c
JOIN v_ttm_eps t ON t.isin = c.isin
JOIN LATERAL (
  SELECT ph.close, ph.date
  FROM price_history ph
  WHERE ph.isin = c.isin
  ORDER BY ph.date DESC
  LIMIT 1
) p ON true;

-- ----------------------------------------------------------------------------
-- Benchmark comparison: portfolio value vs NIFTY 50, both rebased to 100.
--
-- Uses holdings AS OF EACH DATE, reconstructed from the running sum of
-- transactions — NOT current quantities applied across all history, which would
-- silently backtest today's portfolio instead of showing actual realised return.
--
-- Raw (unadjusted) prices are correct here: before a split, both the historical
-- quantity and the historical price are in pre-split terms, so value is
-- self-consistent at each date. This holds only while the split/bonus quantity
-- gap noted in 001_phase0_schema.sql remains unresolved in one direction — once
-- corporate_actions lands in Phase 1, revisit this view together with it.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_benchmark_comparison WITH (security_invoker = true) AS
WITH daily_net AS (
  SELECT
    isin,
    txn_date AS date,
    sum(CASE WHEN txn_type = 'buy' THEN quantity ELSE -quantity END) AS net_qty
  FROM transactions
  GROUP BY isin, txn_date
),
-- Union in transaction dates so a trade on a non-price date (data gap, or a
-- date missing from price_history) is never dropped from the running total.
all_dates AS (
  SELECT date FROM price_history
  UNION
  SELECT txn_date FROM transactions
),
grid AS (
  SELECT d.date, i.isin
  FROM all_dates d
  CROSS JOIN (SELECT DISTINCT isin FROM transactions) i
),
qty_as_of AS (
  SELECT
    g.date,
    g.isin,
    sum(COALESCE(dn.net_qty, 0)) OVER (
      PARTITION BY g.isin ORDER BY g.date
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS quantity
  FROM grid g
  LEFT JOIN daily_net dn ON dn.isin = g.isin AND dn.date = g.date
),
pf AS (
  SELECT q.date, sum(q.quantity * ph.close) AS portfolio_value
  FROM qty_as_of q
  JOIN price_history ph ON ph.isin = q.isin AND ph.date = q.date
  WHERE q.quantity > 0
  GROUP BY q.date
),
idx AS (
  SELECT date, close FROM index_history WHERE index_name = 'NIFTY 50'
)
SELECT
  pf.date,
  pf.portfolio_value,
  idx.close AS index_close,
  100 * pf.portfolio_value / first_value(pf.portfolio_value) OVER (ORDER BY pf.date)
    AS portfolio_rebased,
  100 * idx.close / first_value(idx.close) OVER (ORDER BY pf.date)
    AS index_rebased
FROM pf
JOIN idx ON idx.date = pf.date
ORDER BY pf.date;

-- ----------------------------------------------------------------------------
-- Data freshness — the dashboard must always show "prices as of {date}".
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_data_freshness WITH (security_invoker = true) AS
SELECT
  (SELECT max(date) FROM price_history) AS prices_as_of,
  (SELECT max(date) FROM index_history) AS index_as_of,
  (SELECT count(*) FROM fundamentals_quarterly WHERE status = 'unverified')
    + (SELECT count(*) FROM governance_tracking WHERE status = 'unverified')
    AS unverified_rows;
