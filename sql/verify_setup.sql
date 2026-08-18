-- ============================================================================
-- Post-setup verification. Paste into the Supabase SQL editor AFTER running
-- 001_phase0_schema.sql, 002_phase0_views.sql and seed/phase0_companies.sql.
--
-- Every row must say PASS. This exists because the dangerous failures here are
-- SILENT: a view without security_invoker serves your whole portfolio to the
-- public anon key, and an un-policied table is readable through the auto-
-- generated REST API. Neither shows up as an error anywhere.
--
-- Safe to re-run; it only reads (plus a transient SET ROLE that is reset).
-- ============================================================================

WITH
expected_tables(name) AS (VALUES
  ('companies'),('watchlist'),('price_history'),('index_history'),('transactions'),
  ('cash_ledger'),('fundamentals_quarterly'),('governance_tracking'),
  ('conviction_log'),('research_edit_history'),('isin_aliases'),
  ('corporate_actions'),('job_failures')
),
expected_views(name) AS (VALUES
  ('v_holdings'),('v_portfolio_summary'),('v_concentration'),('v_cash_position'),
  ('v_ttm_eps'),('v_pe_current'),('v_benchmark_comparison'),('v_data_freshness'),
  ('v_price_adjusted'),('v_pending_corporate_actions')
),
expected_funcs(name) AS (VALUES
  ('set_updated_at'),('log_research_edit'),('resolve_isin'),('ca_factor'),('adj_factor')
),

missing_tables AS (
  SELECT string_agg(e.name, ', ') AS v FROM expected_tables e
  WHERE NOT EXISTS (SELECT 1 FROM pg_tables t
                    WHERE t.schemaname='public' AND t.tablename=e.name)
),
tables_without_rls AS (
  SELECT string_agg(t.tablename, ', ') AS v FROM pg_tables t
  WHERE t.schemaname='public' AND NOT t.rowsecurity
),
tables_without_policy AS (
  SELECT string_agg(t.tablename, ', ') AS v FROM pg_tables t
  WHERE t.schemaname='public'
    AND NOT EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname='public' AND p.tablename=t.tablename)
),
missing_views AS (
  SELECT string_agg(e.name, ', ') AS v FROM expected_views e
  WHERE NOT EXISTS (SELECT 1 FROM pg_views x
                    WHERE x.schemaname='public' AND x.viewname=e.name)
),
views_without_invoker AS (
  SELECT string_agg(c.relname, ', ') AS v
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='v'
    AND (c.reloptions IS NULL OR NOT ('security_invoker=true' = ANY(c.reloptions)))
),
missing_funcs AS (
  SELECT string_agg(e.name, ', ') AS v FROM expected_funcs e
  WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                    WHERE n.nspname='public' AND p.proname=e.name)
),
seed AS (SELECT count(*) AS companies FROM companies),
seed_wl AS (SELECT count(*) AS n FROM watchlist WHERE active),
factors AS (
  SELECT ca_factor('split',1,5) AS s, ca_factor('bonus',1,1) AS b,
         ca_factor('bonus',2,1) AS b2, ca_factor('rights',1,4) AS r
)

SELECT 'tables exist'          AS check_name,   -- `check` is reserved in Postgres
       CASE WHEN v IS NULL THEN 'PASS' ELSE 'FAIL' END AS status,
       COALESCE('missing: '||v, '13 expected tables present') AS detail
FROM missing_tables
UNION ALL SELECT 'RLS enabled on every table',
       CASE WHEN v IS NULL THEN 'PASS' ELSE 'FAIL' END,
       COALESCE('NO RLS: '||v, 'all tables have row security')
FROM tables_without_rls
UNION ALL SELECT 'policy on every table',
       CASE WHEN v IS NULL THEN 'PASS' ELSE 'FAIL' END,
       COALESCE('NO POLICY: '||v, 'all tables policied')
FROM tables_without_policy
UNION ALL SELECT 'views exist',
       CASE WHEN v IS NULL THEN 'PASS' ELSE 'FAIL' END,
       COALESCE('missing: '||v, '10 expected views present')
FROM missing_views
UNION ALL SELECT 'security_invoker on every view',
       CASE WHEN v IS NULL THEN 'PASS' ELSE 'FAIL' END,
       COALESCE('LEAKS TO ANON KEY: '||v, 'all views run as the querying user')
FROM views_without_invoker
UNION ALL SELECT 'functions exist',
       CASE WHEN v IS NULL THEN 'PASS' ELSE 'FAIL' END,
       COALESCE('missing: '||v, 'adjustment + trigger functions present')
FROM missing_funcs
UNION ALL SELECT 'seed data',
       CASE WHEN companies >= 5 THEN 'PASS' ELSE 'FAIL' END,
       companies||' companies seeded'
FROM seed
UNION ALL SELECT 'watchlist active',
       CASE WHEN n >= 5 THEN 'PASS' ELSE 'FAIL' END, n||' active entries'
FROM seed_wl
UNION ALL SELECT 'corporate-action factors',
       CASE WHEN s=5 AND b=2 AND b2=1.5 AND r=1 THEN 'PASS' ELSE 'FAIL' END,
       'split 1:5='||s||'  bonus 1:1='||b||'  bonus 1:2='||b2||'  rights='||r
FROM factors
ORDER BY status DESC, check_name;
