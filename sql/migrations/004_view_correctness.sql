-- ============================================================================
-- Forward-only migration: three verified correctness defects in Phase 0 views.
--
-- 001/002 are already applied to the live database, so this ALTERs forward
-- rather than editing them. Every fix below was reproduced empirically on the
-- local erd_scratch database before being written, and re-verified after.
--
--   1. v_ttm_eps silently reported a 15-MONTH sum as "TTM" whenever a quarter's
--      EPS was missing.
--   2. v_benchmark_comparison collapsed to -100% forever after a full exit and
--      re-entry.
--   3. v_benchmark_comparison silently discarded any cashflow dated on a
--      non-trading day, crediting the whole contribution as performance — the
--      exact bug TWR was introduced to fix.
--
-- Defects 2 and 3 are LATENT today (`transactions` is empty). They go live the
-- moment a tradebook is imported, and #3 is near-certain then: price_history
-- starts 2026-07-28, so every trade older than that is "off-grid".
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. v_ttm_eps — require the four quarters to be CONSECUTIVE.
--
-- `WHERE f.eps IS NOT NULL` is applied BEFORE row_number(), so a quarter with an
-- untagged EPS did not merely drop out — rn<=4 reached one quarter further back
-- and closed the gap invisibly. count(*)=4 still passed, so the view returned a
-- 15-month sum labelled TTM, with no flag, and v_pe_current divided price by it.
--
-- Reproduced on erd_scratch: quarters Mar-25..Jun-26 with Dec-25 EPS null
-- returned eps_ttm = 140 (= Jun-25 + Sep-25 + Mar-26 + Jun-26), as_of Jun-2026.
--
-- The guard: four quarter-ends spanning at most twelve months. A contiguous set
-- (Sep-25..Jun-26) has min > max - 12mo; the gapped set above has
-- min = 2025-06-30 = max - 12mo exactly, and is rejected. Returning NO ROW is
-- the right failure: the UI already renders a missing TTM as "needs 4 confirmed
-- quarters" rather than inventing a number.
--
-- Column list is unchanged, so CREATE OR REPLACE is safe (no DROP needed).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_ttm_eps WITH (security_invoker = true) AS
SELECT
  isin,
  filing_type,
  max(period_end)                                          AS as_of,
  sum(eps / adj_factor(isin, period_end))                  AS eps_ttm,
  bool_or(status = 'unverified')                           AS has_unverified
FROM (
  SELECT
    f.*,
    row_number() OVER (PARTITION BY f.isin, f.filing_type ORDER BY f.period_end DESC) AS rn
  FROM fundamentals_quarterly f
  WHERE f.eps IS NOT NULL
) q
WHERE rn <= 4
GROUP BY isin, filing_type
HAVING count(*) = 4
   -- The four rows must also be contiguous, not merely four of them.
   AND min(period_end) > max(period_end) - interval '12 months';


-- ----------------------------------------------------------------------------
-- 2 + 3. v_benchmark_comparison — rebuilt.
--
-- Dropped rather than REPLACEd: the CTE structure changes substantially, and
-- CREATE OR REPLACE VIEW cannot reorder or retype columns. The output column
-- list is deliberately IDENTICAL to before, so no consumer needs changing.
--
-- WHAT WAS WRONG
--
-- (a) Chain collapse. `pf` filtered `WHERE quantity > 0` and grouped by date, so
--     a date on which everything was sold produced no group at all and vanished
--     from the series — taking the sale-day return AND its cashflow with it. The
--     next surviving day then chain-linked against the PRE-liquidation value:
--     (V_reentry - CF_reentry) / V_pre = (1030 - 1030) / 1000 = 0. Once the
--     running product hits zero it stays zero, so the chart reads -100% forever.
--     Reproduced: a true +1.98% rendered as 0.0000. (The old comment claiming
--     NULLIF would yield NULL here was wrong — zero-value dates never reached
--     that expression.)
--
-- (b) Lost cashflows. `daily` was built from an INNER JOIN to the index and an
--     INNER JOIN to prices, then cashflow was matched on EXACT date equality. A
--     trade dated on a weekend, a holiday, or any day missing from
--     price_history/index_history matched nothing — its contribution was never
--     subtracted, so the whole deposit was credited as return. Reproduced: a
--     true +2% rendered as +104%.
--
-- HOW IT IS FIXED
--
-- * The valuation grid is now the INDEX's trading sessions. Every transaction is
--   allocated to the first session ON OR AFTER its date, for BOTH quantity and
--   cashflow, so an off-grid trade lands on the first day it can actually affect
--   valuation instead of being dropped. Quantity and cashflow move together, so
--   they can never disagree.
-- * Zero-value sessions are RETAINED (aggregate FILTER instead of a WHERE that
--   eliminates the group), so a full liquidation stays in the series.
-- * The chain RE-BASES across a break: if the previous session held nothing,
--   the level is carried forward rather than multiplied by ~0. There is no
--   return to compound on an empty portfolio, and inventing one is what produced
--   the permanent -100%.
--
-- Trades dated after the last available session contribute nothing yet — neither
-- quantity nor cashflow — which is consistent rather than a fake return.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_benchmark_comparison;

CREATE VIEW v_benchmark_comparison WITH (security_invoker = true) AS
WITH RECURSIVE
sessions AS (
  SELECT date, close AS index_close
  FROM index_history
  WHERE index_name = 'NIFTY 50'
),
-- Allocate every transaction to the first session on or after its date.
-- NULL session_date = traded after the last session we can value; excluded
-- everywhere below, so quantity and cashflow stay consistent.
txn_session AS (
  SELECT
    t.*,
    (SELECT s.date FROM sessions s WHERE s.date >= t.txn_date ORDER BY s.date LIMIT 1)
      AS session_date
  FROM transactions t
),
daily_net AS (
  SELECT
    session_date AS date,
    isin,
    -- current-equivalent units, so a later split does not misstate history
    sum(CASE WHEN txn_type = 'buy' THEN quantity ELSE -quantity END
        * adj_factor(isin, txn_date)) AS net_qty
  FROM txn_session
  WHERE session_date IS NOT NULL
  GROUP BY session_date, isin
),
-- Net money PUT IN, allocated to the same session as the quantity it bought.
cashflow AS (
  SELECT
    session_date AS date,
    sum(CASE WHEN txn_type = 'buy' THEN  quantity * price + charges
             ELSE                       -(quantity * price - charges) END) AS net_cashflow
  FROM txn_session
  WHERE session_date IS NOT NULL
  GROUP BY session_date
),
grid AS (
  SELECT s.date, i.isin
  FROM sessions s
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
-- FILTER, not WHERE: rows with quantity 0 still form the group, so a session on
-- which nothing is held yields portfolio_value 0 and STAYS IN THE SERIES.
-- Current-equivalent quantity x adjusted price; the two adjustment factors
-- cancel, so each session is valued correctly in the units prevailing then.
pf AS (
  SELECT
    q.date,
    COALESCE(sum(q.quantity * pa.close_adjusted) FILTER (WHERE q.quantity > 0), 0)
      AS portfolio_value
  FROM qty_as_of q
  LEFT JOIN v_price_adjusted pa ON pa.isin = q.isin AND pa.date = q.date
  GROUP BY q.date
),
daily AS (
  SELECT
    pf.date,
    pf.portfolio_value,
    COALESCE(cf.net_cashflow, 0) AS net_cashflow,
    s.index_close,
    row_number() OVER (ORDER BY pf.date) AS rn
  FROM pf
  JOIN sessions s ON s.date = pf.date
  LEFT JOIN cashflow cf ON cf.date = pf.date
  -- Start at the first session that actually holds something; before that there
  -- is no portfolio to measure.
  WHERE pf.date >= (SELECT min(date) FROM daily_net)
),
-- TIME-WEIGHTED RETURN, chain-linked, exact numeric arithmetic throughout
-- (recursive rather than exp(sum(ln(...))), which would route through double
-- precision and violate the numeric-never-float rule).
--
-- Each session's factor is (V_t - CF_t) / V_(t-1): the contribution is valued at
-- cost, so only genuine price movement is credited. Without this, depositing
-- cash reads as performance.
twr AS (
  SELECT rn, date, portfolio_value, net_cashflow, index_close,
         100::numeric AS portfolio_rebased
  FROM daily WHERE rn = 1
  UNION ALL
  SELECT d.rn, d.date, d.portfolio_value, d.net_cashflow, d.index_close,
         CASE
           -- Chain break: nothing was held at the previous session, so there is
           -- no base to compound against. Carry the level forward. Multiplying
           -- by (V - CF)/0 -- or by a ~0 numerator against a stale pre-exit
           -- base -- is what pinned the old view at -100% forever.
           WHEN t.portfolio_value IS NULL OR t.portfolio_value = 0
             THEN t.portfolio_rebased
           ELSE t.portfolio_rebased
                * ((d.portfolio_value - d.net_cashflow) / t.portfolio_value)
         END
  FROM twr t
  JOIN daily d ON d.rn = t.rn + 1
)
SELECT
  t.date,
  t.portfolio_value,
  t.net_cashflow,
  t.index_close,
  t.portfolio_rebased,
  100 * t.index_close / first_value(t.index_close) OVER (ORDER BY t.date)
    AS index_rebased
FROM twr t
ORDER BY t.date;

-- DROP removed the view's grants along with it; re-assert. `anon` deliberately
-- gets nothing (see 001's GRANT block), and security_invoker=true above means
-- the underlying tables' RLS still applies to whoever queries this.
GRANT SELECT ON v_benchmark_comparison TO authenticated;
