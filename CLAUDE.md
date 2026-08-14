# CLAUDE.md

Place this at the repo root. Claude Code reads it automatically each session.

This is a **single-user personal equity research dashboard** for Indian stocks. Full spec: `equity-research-dashboard-build-spec.md`. Scope and constraints: `equity-research-dashboard-requirements.md`. Read both before making structural changes.

---

## Hard rules — do not violate without asking

### 1. No AI at runtime. Ever.
The finished app makes **zero LLM/API calls**. Do not add summarisation, auto-categorisation, sentiment scoring, "smart" suggestions, or any feature that calls an AI service — not even as an optional toggle, not even if it would obviously improve the product. You are building the tool; you are not part of the running system.

**Why this rule exists: zero recurring cost, forever.** It is a cost guarantee, not an ideology. Consequences:
- **Deterministic ingestion is in scope and preferred** — XBRL parsing, CSV import, feed routing are not "AI" and should be used aggressively to eliminate manual transcription.
- If some future feature genuinely needs ML, a model running locally on the user's own machine would satisfy the rule; a paid API never does.

### 2. No live order placement.
Never integrate a broker API for buying, selling, or modifying orders. Read-only market data only. Simulation and paper trading operate purely on stored historical prices.

### 3. `holdings` is a VIEW, never a table.
Do not create a `holdings` table with `avg_buy_price`. Positions are derived from lot-level `transactions` via `v_holdings`. Storing an average cost basis makes FIFO tax computation (Phase 3) impossible and cannot be retrofitted.

### 4. Real and paper data never mix.
`transactions` / `paper_transactions` are separate tables with separate views. Never join them, never union them into a shared "positions" view, never let paper P&L reach a real portfolio total.

### 5. Never add a payment method to any service.
Supabase, Vercel, GitHub — all must stay on free tiers with no card on file. Do not suggest paid tiers as a solution to a limit. If a free-tier limit is hit, the fix is reducing usage, not upgrading.

### 6. `service_role` key never touches frontend code.
- Frontend → Supabase **anon/publishable** key only (protected by RLS)
- Scheduled jobs → `service_role` key, stored in **GitHub Secrets**, never committed

### 7. Enable RLS on every new table.
An un-policied table in Supabase is **publicly readable** through the auto-generated API. Every `CREATE TABLE` must be followed by:
```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_only ON <t> FOR ALL TO authenticated USING (true) WITH CHECK (true);
```
Single user — no `user_id` columns anywhere.

### 8. Every view must be `security_invoker`.
RLS on tables is **not enough** — this project is deliberately view-heavy ("computed values are views, not stored columns"), and a Postgres view runs with its *owner's* privileges by default. A view owned by `postgres` over an RLS-protected table **bypasses that RLS** and is readable through the anon key — the key that ships publicly in the frontend bundle. Locked-down tables plus a default view = the whole portfolio served to anyone who reads your JS. Every `CREATE VIEW` must be:
```sql
CREATE OR REPLACE VIEW <v> WITH (security_invoker = true) AS ...;
```
Verify after any migration — expect `security_invoker=true` in `reloptions` for every row:
```sql
SELECT c.relname, c.reloptions FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'v';
```

---

## Data handling

- **Money and quantities use `numeric`, never `float`/`real`.** Floating-point rounding on financial data is a silent correctness bug.
- **ISIN is the primary key** for companies. Never key on ticker symbol — symbols get renamed and reused, and differ between NSE and BSE.
- **`price_history` is never mutated.** Split/bonus adjustment happens at query time via `v_price_adjusted`.
- **Computed values are views, not stored columns.** P/E, portfolio value, concentration, tax lots — all derived on read.
- **P/E uses TTM EPS** (sum of last four quarters), never a single quarter's EPS.
- **All timestamps are `timestamptz`.** Display in `Asia/Kolkata`.
- **Manual entry is the fallback, not the default.** Before adding a form field, check whether a deterministic feed (XBRL, shareholding pattern, corp actions, tradebook CSV) can stage it instead. Auto-ingested rows carry `entry_mode` ('auto'/'manual') and `status` ('unverified'/'confirmed'); nothing auto-ingested feeds dashboard views un-flagged until the user confirms it in the review inbox. The manual form must keep working as a fallback even where a feed exists — feeds break.

---

## Scheduled jobs

- **Idempotent always.** Use `INSERT ... ON CONFLICT DO UPDATE`. Jobs must be safe to re-run without duplicating rows.
- **Verify NSE URL patterns against the live site at build time.** Do not rely on remembered endpoint formats. NSE has moved to the UDiFF bhavcopy format; confirm the current pattern before writing the fetcher.
  - Endpoints verified 2026-08-15 from a residential IP (bhavcopy, financial-results XBRL index, XBRL files, shareholding pattern, corporate actions, event calendar, announcements — all 200 OK) — see memory `nse-endpoints-verified`.
  - **Verified from a GitHub Actions runner on 2026-08-15 too** (`.github/workflows/nse-endpoint-spike.yml`): bhavcopy and all `www.nseindia.com/api/*` endpoints returned 200 from CI. Only the bare homepage 403'd, which nothing depends on. **All scheduled jobs (price, index, announcements, XBRL fundamentals, shareholding pattern) can run in GitHub Actions — no home-PC fallback needed.** Re-run the spike workflow if NSE starts blocking CI later (their WAF policy can change without notice); don't assume this result is permanent.
- **Trading holidays are normal, not errors.** NSE has many. A missing bhavcopy for a non-trading day should log and exit cleanly, never write to `job_failures` or alert.
- **Every job writes to `job_failures` on exception.** GitHub does not notify you about failed scheduled workflows — the dashboard banner is the only alerting mechanism.
- **Cron must be timezone-pinned** with `timezone: 'Asia/Kolkata'`, and every workflow includes `workflow_dispatch` for manual testing.
- **Be polite to NSE**: retry with exponential backoff, sane `User-Agent`, no tight loops.

---

## Frontend

- **Target Chrome/Chromium only** (Android + Linux + Windows). Do not write Safari or iOS compatibility shims — those platforms are explicitly out of scope.
- **Never cache analysis results client-side across sessions.** Use TanStack Query with refetch on mount and window focus. Staleness is a correctness bug here, not a UX nitpick.
- **Mobile capture must be fast.** The capture screen is the highest-priority UI in the app — target under 15 seconds from intent to saved. Processing screens can be slower.
- **Compress images client-side before upload.** Attachments are the only thing that meaningfully threatens the 1GB storage cap.
- **Always show data freshness**: "prices as of {date}" must be visible on the dashboard.

---

## Working style

- **Build in phases.** Phase 0 only, until it's actually working. Do not scaffold Phases 1–3 ahead of time.
- **Ask before schema migrations.** Do not silently alter or drop tables containing research data — it is irreplaceable and manually entered.
- **Prefer small and boring.** No state management library until React state genuinely fails. No component library beyond Tailwind. This is a single-user tool, not a product.
- **Seed with realistic Indian data** when testing — real ISINs, ₹ values, March fiscal year ends.

---

## Verification checklist before calling anything "done"

- [ ] `v_price_adjusted` produces correct history for a company with a known split
- [ ] P/E matches a public source (e.g. Screener.in) for one company, within rounding
- [ ] RLS enabled and policied on every table, and `security_invoker=true` on every view
- [ ] Re-running each scheduled job twice produces no duplicate rows
- [ ] A simulated job failure surfaces the dashboard banner
- [ ] No `service_role` key anywhere in frontend bundle or committed files
- [ ] Backup job produces a restorable gzipped dump
