#!/usr/bin/env python3
"""
EOD price + index fetch for the watchlist.

Downloads two files from NSE's archive host and upserts them:
  * UDiFF bhavcopy    -> price_history   (per-stock OHLCV, keyed by ISIN)
  * ind_close_all     -> index_history   (index closes; NOT in the bhavcopy)

Design notes worth knowing before editing:

* The bhavcopy carries ISIN directly, so nothing here maps symbol -> ISIN.
* Only watchlist ISINs are stored. The full file is ~3,500 rows/day; keeping all
  of it would burn the free-tier 500MB budget for data we never look at. Adding a
  company later therefore needs a backfill run over past dates.
* Trading holidays are NORMAL. A missing file means "no trading that day" and the
  job exits 0 without writing to job_failures. NSE has many holidays; treating
  them as failures would train you to ignore the alert banner.
* Everything is idempotent (ON CONFLICT DO UPDATE), so re-running any date is safe.
* Index names are upper-cased on write ('Nifty 50' in the file -> 'NIFTY 50'),
  because v_benchmark_comparison filters on 'NIFTY 50'. Keep those consistent.
* stdlib only apart from psycopg2 — fewer moving parts in a job meant to run
  unattended for years.

Usage:
    python fetch_eod.py                # today (Asia/Kolkata)
    python fetch_eod.py 2026-08-13     # a specific date
    python fetch_eod.py 2026-08-01 2026-08-13   # inclusive range, for backfill
"""

import csv
import io
import os
import sys
import time
import zipfile
import urllib.request
import urllib.error
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import psycopg2
import psycopg2.extras

IST = timezone(timedelta(hours=5, minutes=30))

BHAVCOPY_URL = ("https://nsearchives.nseindia.com/content/cm/"
                "BhavCopy_NSE_CM_0_0_0_{yyyymmdd}_F_0000.csv.zip")
INDEX_URL = ("https://nsearchives.nseindia.com/content/indices/"
             "ind_close_all_{ddmmyyyy}.csv")

# Be polite to NSE: a real UA, a referer, retries with backoff, no tight loops.
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
    "Referer": "https://www.nseindia.com/",
}

# Indices to store. NIFTY 50 is required by v_benchmark_comparison.
TRACKED_INDICES = {"NIFTY 50", "NIFTY 500"}

JOB_NAME = "eod_price_fetch"


class NotPublished(Exception):
    """File absent — trading holiday, or not published yet. Not an error."""


class Throttled(Exception):
    """
    NSE answered, but with a web page instead of the file.

    Observed 2026-08-22 on a GitHub Actions runner: a backfill issuing ~12
    requests in 6 seconds got HTTP 200 with an HTML body where a zip was
    expected, and zipfile raised BadZipFile mid-run. This is NSE's WAF throttling
    a datacenter IP — the exact hazard the build spec flags as the most fragile
    part of the system.

    It is deliberately NOT folded into NotPublished. A holiday means "there is no
    data and never will be", and is skipped silently; being throttled means "the
    data exists and we failed to get it". Treating the second as the first would
    silently punch holes in the price history — the kind of quiet data loss that
    is far worse than a loud failure.
    """


def looks_like_html(blob):
    head = blob[:512].lstrip()[:64].lower()
    return head.startswith(b"<!doctype") or head.startswith(b"<html") or b"<head" in head


def fetch(url, retries=4, expect_zip=False):
    """
    GET with exponential backoff.

    Raises NotPublished on a real 404 (holiday / not yet published), and
    Throttled when the response is an HTML page rather than the expected file —
    after retrying, since throttling is usually transient.
    """
    delay = 2
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                blob = r.read()
            # A 200 is not proof of content. Validate what actually arrived:
            # magic bytes for a zip, absence of an HTML shell otherwise.
            if expect_zip and blob[:2] != b"PK":
                last = Throttled(f"expected a zip, got {blob[:16]!r}")
            elif looks_like_html(blob):
                last = Throttled("server returned an HTML page")
            else:
                return blob
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise NotPublished(url)
            last = e
        except Exception as e:                      # noqa: BLE001 - retry anything transient
            last = e
        if attempt < retries - 1:
            time.sleep(delay)
            delay *= 2                              # 2s, 4s, 8s — lets a WAF cool off
    if isinstance(last, Throttled):
        raise Throttled(f"{url}: {last}")
    raise RuntimeError(f"failed after {retries} attempts: {url} ({last})")


def parse_bhavcopy(blob, wanted_isins):
    """Extract watchlist rows from the zipped UDiFF bhavcopy."""
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        name = z.namelist()[0]
        text = z.read(name).decode("utf-8", errors="replace")

    out, symbols, catalogue = {}, {}, {}
    for row in csv.DictReader(io.StringIO(text)):
        isin = (row.get("ISIN") or "").strip()
        if not isin:
            continue
        series = (row.get("SctySrs") or "").strip()
        symbols[isin] = (row.get("TckrSymb") or "").strip()

        # Equity catalogue for the add-to-watchlist search (nse_securities).
        # Series EQ + an 'INE' ISIN is what makes something an actual equity
        # share: the same series also carries ~347 'INF' rows, which are ETF and
        # mutual-fund units and would only clutter an equity research tool.
        # The bhavcopy is the ONLY place a current ISIN may come from — see the
        # module docstring and docs/design-corporate-identity.md.
        if series == "EQ" and isin.startswith("INE"):
            catalogue[isin] = (
                isin,
                (row.get("TckrSymb") or "").strip(),
                (row.get("FinInstrmNm") or "").strip() or None,
            )

        if isin not in wanted_isins:
            continue
        # A stock can appear in more than one series; prefer EQ.
        if isin in out and series != "EQ":
            continue

        def num(key):
            # Decimal, not float — these land in `numeric` columns.
            v = (row.get(key) or "").strip()
            return Decimal(v) if v else None

        vol = (row.get("TtlTradgVol") or "").strip()
        out[isin] = (
            isin,
            datetime.strptime(row["TradDt"].strip(), "%Y-%m-%d").date(),
            num("OpnPric"), num("HghPric"), num("LwPric"), num("ClsPric"),
            int(Decimal(vol)) if vol else None,
        )
    return list(out.values()), symbols, list(catalogue.values())


def upsert_securities(conn, catalogue, on_date):
    """
    Refresh the equity catalogue used by the add-to-watchlist search.

    ISOLATED FROM PRICE INGESTION ON PURPOSE. Prices are load-bearing; this
    lookup table is a convenience. If it fails — most plausibly because migration
    007 has not been applied yet on a partial deploy — the price job must still
    succeed, so this swallows its own error, warns, and returns. It gets its own
    transaction for the same reason: a failure here must not roll back the day's
    prices.
    """
    if not catalogue:
        return 0
    try:
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(cur, """
                INSERT INTO nse_securities (isin, symbol, name, last_seen)
                VALUES %s
                ON CONFLICT (isin) DO UPDATE SET
                  symbol     = EXCLUDED.symbol,
                  name       = COALESCE(EXCLUDED.name, nse_securities.name),
                  last_seen  = GREATEST(nse_securities.last_seen, EXCLUDED.last_seen),
                  updated_at = now()
            """, [(i, s, n, on_date) for i, s, n in catalogue])
        conn.commit()
        return len(catalogue)
    except Exception as exc:                        # noqa: BLE001 - never break prices
        conn.rollback()
        print(f"  warning: could not refresh nse_securities ({type(exc).__name__}: {exc}). "
              f"Prices are unaffected; apply sql/migrations/007_nse_securities.sql.")
        return 0


def parse_indices(blob, on_date):
    rows = []
    text = blob.decode("utf-8", errors="replace")
    for row in csv.DictReader(io.StringIO(text)):
        name = (row.get("Index Name") or "").strip().upper()
        if name not in TRACKED_INDICES:
            continue
        close = (row.get("Closing Index Value") or "").strip()
        if not close:
            continue
        rows.append((name, on_date, Decimal(close)))
    return rows


def check_isin_drift(cur, bhavcopy_symbols):
    """
    Detect a company whose ISIN has changed under it.

    The bhavcopy is authoritative for what trades today. If a watchlist company's
    stored symbol now maps to a different ISIN, the stored ISIN is stale.

    This only ALERTS. Renaming is destructive and cascades across every table, and
    a false positive (symbol reuse, a genuinely different company) would silently
    merge two securities — so a human confirms and runs the documented migration
    in docs/design-corporate-identity.md.
    """
    cur.execute("""
        SELECT c.isin, c.symbol_nse, c.company_name
        FROM companies c JOIN watchlist w ON w.isin = c.isin
        WHERE w.active AND c.symbol_nse IS NOT NULL
    """)
    by_symbol = {}
    for isin, sym in ((i, s) for i, s, _ in cur.fetchall()):
        by_symbol.setdefault(sym, isin)

    live = {sym: isin for isin, sym in bhavcopy_symbols.items()}
    drift = []
    for sym, stored_isin in by_symbol.items():
        live_isin = live.get(sym)
        if live_isin and live_isin != stored_isin:
            drift.append((sym, stored_isin, live_isin))
    return drift


def main():
    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        sys.exit("SUPABASE_DB_URL is not set")

    args = sys.argv[1:]
    if not args:
        start = end = datetime.now(IST).date()
    elif len(args) == 1:
        start = end = date.fromisoformat(args[0])
    else:
        start, end = date.fromisoformat(args[0]), date.fromisoformat(args[1])

    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT isin FROM watchlist WHERE active")
            wanted = {r[0] for r in cur.fetchall()}
        if not wanted:
            print("watchlist is empty — nothing to fetch")
            return

        # RESUMABILITY. A multi-year backfill is ~640 requests; without this, any
        # interruption means starting over and re-hammering NSE for data already
        # stored. A date counts as done only when every active watchlist ISIN has
        # a row, so a partially-ingested day is still re-fetched.
        already_done = set()
        if start != end:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT date FROM price_history
                    WHERE isin = ANY(%s) AND date BETWEEN %s AND %s
                    GROUP BY date HAVING count(DISTINCT isin) = %s
                """, (list(wanted), start, end, len(wanted)))
                already_done = {r[0] for r in cur.fetchall()}
            if already_done:
                print(f"resuming: {len(already_done)} day(s) in this range already complete")

        day, total_prices, total_idx, skipped = start, 0, 0, []
        throttled_days, resumed = [], 0
        # Backfills need a gentler pace than the single-day nightly run: NSE
        # throttled a runner that issued ~12 requests in 6 seconds.
        pause = 1 if start == end else 2.5

        while day <= end:
            if day in already_done:
                resumed += 1
                day += timedelta(days=1)
                continue

            stamp_p = day.strftime("%Y%m%d")
            stamp_i = day.strftime("%d%m%Y")
            try:
                prices, symbols, catalogue = parse_bhavcopy(
                    fetch(BHAVCOPY_URL.format(yyyymmdd=stamp_p), expect_zip=True), wanted)
            except NotPublished:
                # Holiday / weekend / not yet published. Normal, not an error.
                skipped.append(day.isoformat())
                day += timedelta(days=1)
                continue
            except (Throttled, RuntimeError) as exc:
                # The data may exist and we could not get it. Record the date and
                # KEEP GOING — one unreachable day must not discard hundreds of
                # successfully backfilled ones. Reported and alerted at the end
                # so the gap is never silent, and re-running fills it because the
                # resume check above skips what already landed.
                #
                # RuntimeError is caught alongside Throttled deliberately: it is
                # what fetch() raises when the retries are exhausted for a
                # non-404 reason (read timeout, connection reset). Observed
                # 2026-08-22, when a 1h55m backfill died on its last leg because
                # one request timed out — on 2025-09-13, a SATURDAY, a day with
                # no data to lose. Both cases mean the same thing to this loop:
                # note the gap, move on.
                print(f"  {day}: unreachable — {exc}")
                throttled_days.append(day.isoformat())
                day += timedelta(days=1)
                time.sleep(pause * 3)               # back off harder before continuing
                continue

            try:
                indices = parse_indices(fetch(INDEX_URL.format(ddmmyyyy=stamp_i)), day)
            except NotPublished:
                indices = []
                print(f"  {day}: bhavcopy present but index file missing")
            except (Throttled, RuntimeError) as exc:
                # Prices for this day are in hand; losing the index alone is not
                # worth discarding them. Recorded so the gap is visible, and a
                # re-run refetches the day (it will not be "complete" without
                # its prices anyway — but the index upsert is idempotent).
                indices = []
                print(f"  {day}: index file unreachable — {exc}")
                throttled_days.append(f"{day.isoformat()} (index only)")

            with conn.cursor() as cur:
                psycopg2.extras.execute_batch(cur, """
                    INSERT INTO price_history (isin, date, open, high, low, close, volume)
                    VALUES (%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (isin, date) DO UPDATE SET
                      open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
                      close=EXCLUDED.close, volume=EXCLUDED.volume
                """, prices)

                psycopg2.extras.execute_batch(cur, """
                    INSERT INTO index_history (index_name, date, close)
                    VALUES (%s,%s,%s)
                    ON CONFLICT (index_name, date) DO UPDATE SET close=EXCLUDED.close
                """, indices)

                drift = check_isin_drift(cur, symbols)
                for sym, stored, livei in drift:
                    msg = (f"ISIN drift for {sym}: stored {stored}, bhavcopy says {livei}. "
                           f"Prices are NOT being recorded under the new ISIN. "
                           f"See docs/design-corporate-identity.md.")
                    print("  ALERT:", msg)
                    cur.execute(
                        "INSERT INTO job_failures (job_name, error_text) VALUES (%s,%s)",
                        ("isin_drift", msg))

            conn.commit()

            # After the prices are safely committed, never before: the catalogue
            # is a convenience and must not put the day's prices at risk.
            # Only on the most recent day of a backfill — the catalogue is a
            # current snapshot, not a time series, and rewriting it once per
            # backfilled day would be 2,285 pointless upserts each time.
            n_cat = 0
            if day == end:
                n_cat = upsert_securities(conn, catalogue, day)

            total_prices += len(prices)
            total_idx += len(indices)
            print(f"  {day}: {len(prices)} prices, {len(indices)} indices"
                  + (f", {n_cat} securities catalogued" if n_cat else ""))
            day += timedelta(days=1)
            if day <= end:
                time.sleep(pause)      # be polite; gentler still on backfills

        print(f"done: {total_prices} price rows, {total_idx} index rows")
        if resumed:
            print(f"skipped {resumed} day(s) already complete")
        if skipped:
            print(f"no data (holiday/weekend/unpublished): {len(skipped)} day(s)")

        # An unreachable day is a HOLE in the price history, not a holiday. Say so
        # loudly, and make the alert actionable: re-running the same range costs
        # almost nothing because completed days are skipped.
        if throttled_days:
            msg = (f"EOD backfill could not fetch {len(throttled_days)} day(s) — NSE "
                   f"returned a web page instead of the file (WAF throttling), or "
                   f"the request timed out. These "
                   f"dates are MISSING from price history: "
                   f"{', '.join(throttled_days[:20])}"
                   f"{' …' if len(throttled_days) > 20 else ''}. "
                   f"Re-run the same date range to fill them; days already stored are "
                   f"skipped automatically.")
            print(f"\nWARNING: {msg}")
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM job_failures WHERE job_name=%s AND error_text=%s",
                    (JOB_NAME, msg))
                if not cur.fetchone():
                    cur.execute(
                        "INSERT INTO job_failures (job_name, error_text) VALUES (%s,%s)",
                        (JOB_NAME, msg))
            conn.commit()

    except Exception as exc:                        # noqa: BLE001 - must always alert
        conn.rollback()
        with conn.cursor() as cur:
            cur.execute("INSERT INTO job_failures (job_name, error_text) VALUES (%s,%s)",
                        (JOB_NAME, f"{type(exc).__name__}: {exc}"))
        conn.commit()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
