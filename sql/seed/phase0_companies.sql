-- Phase 0 seed data: the 5-company MVP watchlist.
--
-- ISINs verified 2026-08-15 against the LIVE UDiFF BHAVCOPY (the daily official
-- trade file), which is authoritative for what actually trades today and is what
-- the depository/broker uses for your holdings.
--
-- IMPORTANT — do NOT source ISINs from NSE's corporates-financial-results or
-- corporates-corporateActions APIs. Both return the ISIN as recorded at filing
-- time, which goes stale when a company's ISIN changes. That mistake was made
-- and corrected here:
--   HDFC Bank  filings API said INE040A01018  -> actually trades as INE040A01034
--   Sun Pharma filings API said INE044A01028  -> actually trades as INE044A01036
-- The old ISINs do not appear in today's bhavcopy at all. ISINs are NOT immutable
-- (face-value changes, restructurings) — see docs/phase0-setup.md.
--
-- sector / sector_template values are best-effort classification, not verified
-- against an authoritative sector taxonomy — confirm against NSE's sector
-- classification (or adjust sector_template naming) before it drives form-field
-- logic in the UI.
--
-- BSE symbols intentionally left NULL: not independently verified in this pass.
-- Fill in when convenient; nothing in the schema requires them.

INSERT INTO companies (isin, symbol_nse, symbol_bse, company_name, sector, sector_template, fiscal_year_end_month)
VALUES
  ('INE040A01034', 'HDFCBANK',  NULL, 'HDFC Bank Limited',                 'Financial Services', 'bank',          3),
  ('INE154A01025', 'ITC',       NULL, 'ITC Limited',                       'FMCG',                'fmcg',          3),
  ('INE018A01030', 'LT',        NULL, 'Larsen & Toubro Limited',           'Capital Goods',       'capital_goods', 3),
  ('INE009A01021', 'INFY',      NULL, 'Infosys Limited',                   'IT Services',         'it_services',   3),
  ('INE044A01036', 'SUNPHARMA', NULL, 'Sun Pharmaceutical Industries Ltd', 'Pharmaceuticals',     'pharma',        3)
ON CONFLICT (isin) DO UPDATE SET
  symbol_nse      = EXCLUDED.symbol_nse,
  company_name    = EXCLUDED.company_name,
  sector          = EXCLUDED.sector,
  sector_template = EXCLUDED.sector_template;

INSERT INTO watchlist (isin, active, notes)
VALUES
  ('INE040A01034', true, 'Phase 0 MVP watchlist — bank'),
  ('INE154A01025', true, 'Phase 0 MVP watchlist — FMCG'),
  ('INE018A01030', true, 'Phase 0 MVP watchlist — capital goods'),
  ('INE009A01021', true, 'Phase 0 MVP watchlist — IT services'),
  ('INE044A01036', true, 'Phase 0 MVP watchlist — pharma')
ON CONFLICT (isin) DO UPDATE SET active = EXCLUDED.active;
