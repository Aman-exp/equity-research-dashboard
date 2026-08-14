-- Phase 0 seed data: the 5-company MVP watchlist.
-- ISINs verified live against NSE's corporates-financial-results API on 2026-08-15
-- (not from memory — see project memory `nse-endpoints-verified` / build spec 8a).
-- One correction caught by this verification: HDFC Bank's ISIN is INE040A01018,
-- not INE040A01034 as an initial web search suggested — the live NSE filing data
-- (103 consistent rows, all "HDFC Bank Limited") is the source of truth here.
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
  ('INE040A01018', 'HDFCBANK',  NULL, 'HDFC Bank Limited',                 'Financial Services', 'bank',          3),
  ('INE154A01025', 'ITC',       NULL, 'ITC Limited',                       'FMCG',                'fmcg',          3),
  ('INE018A01030', 'LT',        NULL, 'Larsen & Toubro Limited',           'Capital Goods',       'capital_goods', 3),
  ('INE009A01021', 'INFY',      NULL, 'Infosys Limited',                   'IT Services',         'it_services',   3),
  ('INE044A01028', 'SUNPHARMA', NULL, 'Sun Pharmaceutical Industries Ltd', 'Pharmaceuticals',     'pharma',        3)
ON CONFLICT (isin) DO UPDATE SET
  symbol_nse      = EXCLUDED.symbol_nse,
  company_name    = EXCLUDED.company_name,
  sector          = EXCLUDED.sector,
  sector_template = EXCLUDED.sector_template;

INSERT INTO watchlist (isin, active, notes)
VALUES
  ('INE040A01018', true, 'Phase 0 MVP watchlist — bank'),
  ('INE154A01025', true, 'Phase 0 MVP watchlist — FMCG'),
  ('INE018A01030', true, 'Phase 0 MVP watchlist — capital goods'),
  ('INE009A01021', true, 'Phase 0 MVP watchlist — IT services'),
  ('INE044A01028', true, 'Phase 0 MVP watchlist — pharma')
ON CONFLICT (isin) DO UPDATE SET active = EXCLUDED.active;
