# Phase 0 — setup runbook

Order matters. Each step assumes the previous one succeeded.

> **Migrations are validated.** PostgreSQL 17 is installed locally and the full Phase 0
> schema + views + seed were run end-to-end against a scratch database (`erd_scratch`)
> with Supabase-like `anon` / `authenticated` roles. Holdings, portfolio value,
> benchmark rebasing, TTM EPS/PE, the audit trigger, RLS and view security were all
> asserted against expected values before this was handed over. To re-validate after
> editing a migration:
>
> ```powershell
> $env:Path += ";C:\Program Files\PostgreSQL\17\bin"; $env:PGPASSWORD="postgres"
> psql -U postgres -h localhost -d erd_scratch -v ON_ERROR_STOP=1 -f sql\migrations\001_phase0_schema.sql
> ```

## 1. Create the Supabase project

- Free tier. **Do not add a payment method** (see CLAUDE.md rule 5 — with no card on
  file the project is architecturally incapable of costing money).
- Region: closest to you (Singapore/Mumbai).
- Save the direct Postgres connection string (port `5432`, *not* the pooled one) —
  the backup job needs a direct session connection.

## 2. Run the migrations

In the Supabase SQL editor, in this order:

1. `sql/migrations/001_phase0_schema.sql` — tables, constraints, triggers, RLS
2. `sql/migrations/002_phase0_views.sql` — computed views
3. `sql/seed/phase0_companies.sql` — the 5 MVP companies + watchlist

Then verify RLS actually took (CLAUDE.md verification checklist):

```sql
-- Expect rowsecurity = true for every row. Any false is a publicly readable table.
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- Expect security_invoker = true on every view. Without it, a view over an
-- RLS-protected table is readable through the anon key.
SELECT c.relname, c.reloptions
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'v';
```

## 3. Set up the backup job (Phase 0, not later)

Create a **second private repo** for backups, e.g. `equity-research-backups`.

Then add these repo secrets here (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `SUPABASE_DB_URL` | Direct Postgres connection string from step 1 |
| `BACKUP_REPO` | `owner/name` of the backup repo |
| `BACKUP_REPO_TOKEN` | PAT with `repo` scope on the backup repo |

Run `.github/workflows/backup.yml` manually once (`workflow_dispatch`) and confirm a
`dumps/db-YYYYMMDD.sql.gz` lands in the backup repo. Then verify it actually restores —
a backup you have never restored is not a backup:

```bash
gunzip -c db-YYYYMMDD.sql.gz | psql "postgres://...localhost.../scratch_db"
```

## 4. Load price history

Not yet automated in Phase 0 (the scheduled price job is Phase 1). Bootstrap by
downloading a few bhavcopy files and loading the 5 watchlist ISINs, or wait for the
Phase 1 job. `v_benchmark_comparison` also needs `index_history` rows with
`index_name = 'NIFTY 50'`.

## 5. Load transactions

Export the broker tradebook CSV and import it (importer is Phase 0 scope, still to be
built). Manual single-row entry is fine to start.

---

## Open items

- ~~Split/bonus quantity gap~~ — **resolved**, see [design-corporate-identity.md](design-corporate-identity.md).
  `corporate_actions` + `adj_factor()` adjust quantities and prices at query time.
- ~~ISIN drift~~ — **resolved**, same doc. FKs are `ON UPDATE CASCADE`; renaming
  `companies.isin` moves all child rows. `isin_aliases` + `resolve_isin()` normalise
  incoming feed data.
- **Load the real corporate actions for your 5 companies before entering history.**
  The mechanism exists but the table is empty. Any pre-bonus/pre-split transaction
  entered now will show the wrong quantity until the matching action row is added.
  L&T and Infosys both have historical bonus issues.
- **The dashboard must surface `v_pending_corporate_actions` as a blocking banner.**
  Unconfirmed actions are deliberately not applied, so without this banner an
  unconfirmed bonus silently understates holdings. This is load-bearing, not polish.
- **`sector_template` field sets** for `it_services` and `pharma` are not designed
  yet — needed before Phase 1 form-template work, not before Phase 0 data entry.

## Verification checklist status (CLAUDE.md)

- [ ] `v_price_adjusted` correct for a known split — *Phase 3, view not built yet*
- [ ] P/E matches Screener.in within rounding — *needs `v_pe_current` + 4 quarters of EPS*
- [x] RLS enabled and policied on every table — *verify with the query in step 2*
- [ ] Re-running each scheduled job twice produces no duplicate rows — *Phase 1*
- [ ] Simulated job failure surfaces the dashboard banner — *Phase 1 (`job_failures`)*
- [x] No `service_role` key in frontend or committed files — *only in GitHub Secrets*
- [ ] Backup job produces a restorable gzipped dump — *step 3, restore test required*
