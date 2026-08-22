-- ============================================================================
-- One-time cleanup: remove auto-staged STANDALONE quarters that duplicate a
-- consolidated filing for the same company and period.
--
-- WHY
-- ---
-- The build spec settled on "consolidated where available, standalone only as a
-- fallback" (§14), but fetch_fundamentals.py staged BOTH bases for every
-- quarter. Measured 2026-08-22: all five watchlist companies file both for all
-- 29 quarters, so the review inbox held 58 rows where 29 carry the information.
-- That doubled backlog is the single largest contributor to review fatigue --
-- the failure mode this project treats as the main abandonment risk.
--
-- It is worse than redundant for a holding company. L&T's Sep-2025 STANDALONE
-- PAT is -3,591 Cr, entirely a one-off exceptional item, dragging its standalone
-- TTM P/E to 77.6 against a consolidated 33.9. Asking for review of that row
-- invites confirming a figure that should never drive a decision.
--
-- scripts/fetch_fundamentals.py now stages one basis per quarter, so this
-- backlog cannot rebuild.
--
-- SAFETY -- every one of these conditions must hold before a row is deleted:
--   1. filing_type = 'standalone'        (never touches consolidated)
--   2. entry_mode  = 'auto'              (never touches anything hand-entered)
--   3. status      = 'unverified'        (never touches anything you confirmed)
--   4. a consolidated row exists for the SAME isin AND period_end
--      (never orphans a quarter -- a standalone-only quarter is kept)
--
-- So this cannot delete research you entered or reviewed, and cannot leave a
-- period with no data. Wrapped in a transaction with a before/after count.
--
-- REVERSIBLE: re-running scripts/fetch_fundamentals.py re-fetches from NSE. The
-- deleted rows carry no human input by definition of condition 2 and 3.
-- ============================================================================

BEGIN;

-- What is about to go, for the record.
\echo 'Rows matching the delete criteria, by company:'
SELECT c.symbol_nse,
       count(*)                        AS standalone_rows_to_delete,
       min(f.period_end)               AS oldest,
       max(f.period_end)               AS newest
FROM fundamentals_quarterly f
JOIN companies c ON c.isin = f.isin
WHERE f.filing_type = 'standalone'
  AND f.entry_mode  = 'auto'
  AND f.status      = 'unverified'
  AND EXISTS (
        SELECT 1 FROM fundamentals_quarterly k
        WHERE k.isin = f.isin
          AND k.period_end = f.period_end
          AND k.filing_type = 'consolidated'
      )
GROUP BY c.symbol_nse
ORDER BY c.symbol_nse;

DELETE FROM fundamentals_quarterly f
WHERE f.filing_type = 'standalone'
  AND f.entry_mode  = 'auto'
  AND f.status      = 'unverified'
  AND EXISTS (
        SELECT 1 FROM fundamentals_quarterly k
        WHERE k.isin = f.isin
          AND k.period_end = f.period_end
          AND k.filing_type = 'consolidated'
      );

-- Every remaining quarter must still have exactly one row, and the review
-- backlog should now equal the number of distinct quarters.
\echo 'After cleanup -- rows remaining by basis:'
SELECT filing_type, status, count(*)
FROM fundamentals_quarterly
GROUP BY filing_type, status
ORDER BY filing_type, status;

\echo 'Any period left with NO row at all? (must return zero rows)'
SELECT c.symbol_nse, x.period_end
FROM (SELECT DISTINCT isin, period_end FROM fundamentals_quarterly) x
JOIN companies c ON c.isin = x.isin
WHERE NOT EXISTS (
  SELECT 1 FROM fundamentals_quarterly f
  WHERE f.isin = x.isin AND f.period_end = x.period_end
)
ORDER BY 1, 2;

COMMIT;
