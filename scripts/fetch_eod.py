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


def fetch(url, retries=4):
    """GET with exponential backoff. Raises NotPublished on 404."""
    delay = 2
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise NotPublished(url)
            last = e
        except Exception as e:                      # noqa: BLE001 - retry anything transient
            last = e
        if attempt < retries - 1:
            time.sleep(delay)
            delay *= 2
    raise RuntimeError(f"failed after {retries} attempts: {url} ({last})")


def parse_bhavcopy(blob, wanted_isins):
    """Extract watchlist rows from the zipped UDiFF bhavcopy."""
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        name = z.namelist()[0]
        text = z.read(name).decode("utf-8", errors="replace")

    out, symbols = {}, {}
    for row in csv.DictReader(io.StringIO(text)):
        isin = (row.get("ISIN") or "").strip()
        if not isin:
            continue
        series = (row.get("SctySrs") or "").strip()
        symbols[isin] = (row.get("TckrSymb") or "").strip()
        if isin not in wanted_isins:
            continue
        # A stock can appear in more than one series; prefer EQ.
        if isin in out and series != "EQ":
            continue

        def num(key):
            v = (row.get(key) or "").strip()
            return float(v) if v else None

        out[isin] = (
            isin,
            datetime.strptime(row["TradDt"].strip(), "%Y-%m-%d").date(),
            num("OpnPric"), num("HghPric"), num("LwPric"), num("ClsPric"),
            int(float(row["TtlTradgVol"])) if (row.get("TtlTradgVol") or "").strip() else None,
        )
    return list(out.values()), symbols


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
        rows.append((name, on_date, float(close)))
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

        day, total_prices, total_idx, skipped = start, 0, 0, []
        while day <= end:
            stamp_p = day.strftime("%Y%m%d")
            stamp_i = day.strftime("%d%m%Y")
            try:
                prices, symbols = parse_bhavcopy(
                    fetch(BHAVCOPY_URL.format(yyyymmdd=stamp_p)), wanted)
            except NotPublished:
                # Holiday / weekend / not yet published. Normal, not an error.
                skipped.append(day.isoformat())
                day += timedelta(days=1)
                continue

            try:
                indices = parse_indices(fetch(INDEX_URL.format(ddmmyyyy=stamp_i)), day)
            except NotPublished:
                indices = []
                print(f"  {day}: bhavcopy present but index file missing")

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
            total_prices += len(prices)
            total_idx += len(indices)
            print(f"  {day}: {len(prices)} prices, {len(indices)} indices")
            day += timedelta(days=1)
            if day <= end:
                time.sleep(1)          # be polite on backfill runs

        print(f"done: {total_prices} price rows, {total_idx} index rows")
        if skipped:
            print(f"no data (holiday/weekend/unpublished): {', '.join(skipped)}")

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
