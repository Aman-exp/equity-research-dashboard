# Design — corporate identity and corporate actions

Two problems discovered on 2026-08-15 while inspecting real NSE data. They look
unrelated but are the same thing: **a corporate event changes what previously
stored data means.** One mechanism handles both.

| Problem | Observed |
|---|---|
| ISINs are not immutable | HDFC Bank `INE040A01018` → `INE040A01034`; Sun Pharma `INE044A01028` → `INE044A01036`. The old ISINs are absent from today's bhavcopy. |
| Splits/bonuses change share counts with no transaction | Live for this watchlist — L&T and Infosys both have historical bonus issues. |

---

## 1. Identity: rename in place, alias for inbound data

**Decision: keep ISIN as the primary key. Do not introduce a surrogate key.**

The tempting "textbook" fix is an internal `security_id` with ISIN as a mutable
attribute. Rejected: it adds a join to every query for an event that happens
perhaps once a decade per company, and it contradicts a hard rule in CLAUDE.md.
"Prefer small and boring" applies.

Instead:

- **Every FK to `companies(isin)` is `ON UPDATE CASCADE`.** Changing
  `companies.isin` rewrites all child rows atomically, in one statement.
- **All stored data therefore always uses the CURRENT ISIN.** No view anywhere
  needs an alias join — this is the property that keeps the design cheap.
- **`isin_aliases` records superseded ISINs**, and exists for one purpose:
  normalising *incoming* data. Feeds and broker CSVs may carry an old ISIN;
  `resolve_isin(text)` maps it forward before insert.

Verified: renaming a company with transactions, prices, conviction entries and a
watchlist row moved all four, with zero rows left behind.

### Detecting drift

Deterministic, no guessing: the bhavcopy contains both `TckrSymb` and `ISIN`.
The daily price job compares the bhavcopy ISIN for each watchlist symbol against
`companies.isin`. A mismatch means drift.

**The job must not auto-migrate.** A rename is a destructive, wide-cascading
operation; a false positive (symbol reuse, a genuinely different company) would
silently merge two securities. The job flags it; a human confirms; the rename is
then a two-statement migration:

```sql
UPDATE companies SET isin = '<new>' WHERE isin = '<old>';
INSERT INTO isin_aliases (old_isin, current_isin, changed_on, reason)
VALUES ('<old>', '<new>', current_date, 'observed in bhavcopy');
```

### Edge case: both ISINs already exist as separate rows

If `companies` somehow holds both the old and the new ISIN as distinct rows, the
`UPDATE` above fails on a primary-key conflict rather than merging. This is the
correct behaviour — a silent merge would be worse — but it means the recovery
path is a manual merge: repoint children from old to new, delete the stale
`companies` row, then insert the alias. Most likely cause is seeding a company
from bhavcopy (new ISIN) while historical data arrived under the old one.

---

## 2. Corporate actions: one factor, applied at query time

`transactions` and `price_history` remain immutable records of what actually
happened. Adjustment is computed on read, consistent with the project's
"computed values are views" principle.

### Per-action factor — `ca_factor(type, from, to)`

| Action | Convention | Factor | Why |
|---|---|---|---|
| `split` 1:5 | 1 share becomes 5 | `to/from` = 5 | share count scales |
| `bonus` 1:1 | 1 free share per 1 held | `1 + to/from` = 2 | holding becomes 2× |
| `rights` | — | **1 (no adjustment)** | see below |

**Rights deliberately do not adjust.** A rights issue is *subscribed at a price*
and is *optional* — it creates a real new lot at a real cost. Auto-scaling
quantities for a rights issue would invent shares that may never have been
bought. Record rights as an ordinary `buy` transaction; the `rights` action_type
exists only so the event can be noted.

### Cumulative factor — `adj_factor(isin, date)`

The product of `ca_factor` over all **confirmed** actions with `ex_date > date`.

Implemented as a plpgsql loop doing exact `numeric` multiplication, **not** the
`exp(sum(ln(...)))` idiom from an earlier draft of the spec. That idiom routes
through `double precision`, smuggling floating-point error into share counts and
prices — precisely what the numeric-never-float rule exists to prevent. Verified:
ten 1:1 bonuses return exactly `1024`, typed `numeric`.

*(Caveat: ratios that are not exact decimals — a 3:1 reverse split — leave a tiny
residue in `numeric` division too, e.g. 300 → 99.999999999999999999. Round for
display. Round-trips remain exact. Indian splits are almost always 1:2/1:5/1:10,
which are exact.)*

### Applying it

```
historical price    ÷ adj_factor   → comparable to today
historical quantity × adj_factor   → expressed in today's shares
```

The two cancel, so **value is invariant** across a split or bonus — the property
to check when in doubt. Verified: 100 shares × ₹1000 raw ≡ 200 × ₹500 adjusted.

Applied in `v_price_adjusted`, `v_holdings`, and `v_benchmark_comparison`.

> **Correction to an earlier note in `002_phase0_views.sql`:** it claimed raw
> prices were safe in `v_benchmark_comparison` because pre-split quantities pair
> with pre-split prices. True only *before* the split — after it, running
> quantities are still in pre-split units while prices are post-split,
> understating the portfolio from that day on. It now carries quantities in
> current-equivalent units against adjusted prices.

### Unconfirmed actions are NOT applied

The corporate-actions feed can propose actions by parsing subject text
("Bonus 1:1", "Face Value Split From Rs 10 to Rs 1"). Text parsing is
deterministic but fallible, and a mis-parsed action would corrupt every quantity
and price in the app.

So `adj_factor()` applies **only `status='confirmed'`** rows. Auto-ingested
actions land as `unverified` and surface through `v_pending_corporate_actions`.

This trade is deliberate and asymmetric-by-choice: an unconfirmed-but-real bonus
leaves holdings *understated* until confirmed. That is acceptable **only because
the dashboard surfaces the pending action as a blocking banner** — showing a
number that is probably wrong, with no indication, would not be. If the banner is
not built, this design is worse than the bug it fixes.

Verified: an unconfirmed 1:10 split leaves quantity at 250; confirming it moves
quantity to 2500 and average cost from ₹540 to ₹54.

---

## 3. What this does NOT solve — Phase 3 FIFO

`v_holdings` gives correct **totals** but not a correct **lot structure**, and it
must not be used as a tax basis. Under Indian tax law:

- **Split** — rescales the original lot; acquisition date preserved.
- **Bonus** — creates a *separate* lot with **zero cost of acquisition**, holding
  period running from allotment, not from the original purchase.

The factor approach spreads the bonus proportionally across existing lots, which
gives the same totals but the wrong per-lot cost basis and the wrong holding-period
start. Phase 3's FIFO work needs true lot-level modelling — with the
31-Jan-2018 grandfathering FMV — built directly from `transactions` +
`corporate_actions`, not from this view.
