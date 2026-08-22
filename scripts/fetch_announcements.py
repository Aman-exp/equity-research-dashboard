#!/usr/bin/env python3
"""
Announcement-feed diff -> filings_queue.

This is the daily loop: the build spec (Section 8, job 2) calls it "the entire
tell-me-what-to-do-today feature". It polls NSE's corporate-announcements feed
for each active watchlist company, keeps only what is worth a human look, and
inserts pending tasks. Routing is deterministic keyword matching on NSE's own
category string — no inference, no model, nothing with a recurring cost.

SOURCE (verified live 2026-08-22 from a residential IP):
  /api/corporate-announcements?index=equities&symbol=X
    &from_date=DD-MM-YYYY&to_date=DD-MM-YYYY
  Returns a bare JSON LIST (not the {data: [...]} envelope the XBRL endpoint
  uses). Newest row was 19-Aug-2026, i.e. genuinely current — checked inside the
  payload, not just the status code, per the frozen-endpoint lesson that burned
  /api/corporates-financial-results.

THE TRAP THIS SCRIPT IS BUILT AROUND
------------------------------------
The feed's `sm_isin` is the ISIN AS OF FILING TIME and goes stale. Measured
2026-08-22 against the current watchlist:

    HDFCBANK   feed INE040A01018   actual INE040A01034   STALE
    SUNPHARMA  feed INE044A01028   actual INE044A01036   STALE
    ITC / LT / INFY                                      match

So 2 of 5 companies would silently never match if this keyed on the feed's ISIN
-- their announcements would vanish with no error. Everything here is therefore
keyed on the SYMBOL we asked for, whose ISIN we already know from `companies`.
`sm_isin` is read only to raise a drift alert, never to resolve a company.

FILTERING
---------
NSE reports 166 distinct category strings for one company, with near-duplicates
("General updates" vs "General Updates"), so matching is case-insensitive
substring, never equality. Measured over 90 days x 4 companies: 144 total
announcements, of which ~50% are administrative noise (newspaper copies, ESOP
allotments, trading-window notices, generic press releases). Keeping all of it
would clutter the queue enough to erode trust in it -- the same reasoning that
kept bulk/block deals out of the design.

Tuned to ~30 items/month across 5 companies, roughly one a day.

Everything is idempotent: NSE's `seq_id` becomes external_ref under a unique
index, so re-running any window inserts nothing new.

Usage:
    python fetch_announcements.py              # last 7 days (default)
    python fetch_announcements.py 30           # last 30 days, for a backfill
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone

import psycopg2
import psycopg2.extras

IST = timezone(timedelta(hours=5, minutes=30))

API = ("https://www.nseindia.com/api/corporate-announcements"
       "?index=equities&symbol={symbol}&from_date={frm}&to_date={to}")

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
    "Referer": "https://www.nseindia.com/companies-listing/corporate-filings-announcements",
}

JOB_NAME = "announcements_fetch"

# Ordered: first match wins, so specific patterns precede generic ones. Every
# key is lower-case and matching is SUBSTRING, not equality — NSE reports 166
# distinct category strings with near-duplicates ("General updates" vs "General
# Updates"), so exact matching would miss most of them.
#
# Tier 1 (quarterly_result, rating_action, corporate_action) changes a thesis.
# Tier 2 (material_event, governance, concall) is worth reading. Everything
# else is discarded via NOISE below.
ROUTE_TABLE = [
    ("quarterly_result", [
        "outcome of board meeting",
        "financial result",
        "result updates",
        "consolidated result",
        "standalone result",
        "annual report",
    ]),
    ("rating_action", [
        "credit rating",
        "rating- new",
        "rating action",
    ]),
    ("corporate_action", [
        "record date",
        "dividend",
        "bonus",
        "stock split",
        "sub-division",
        "buyback",
        "rights issue",
    ]),
    ("material_event", [
        "scheme of arrangement",
        "amalgamation",
        "merger",
        "demerger",
        "acquisition",
        "bagging",
        "orders/contracts",
        "order win",
    ]),
    ("governance", [
        "change in director",
        "change in management",
        "change in key managerial",
        "resignation",
        "cessation",
        # Appointments of an auditor, CFO or company secretary are exactly what
        # governance_tracking.auditor_changed_flag / cfo_cs_change_flag exist to
        # record. Found by reviewing what the filter DISCARDED against 90 days of
        # real data — it was being dropped.
        "appointment",
        "auditor",
        "shareholders meeting",
        "postal ballot",
    ]),
    ("concall", [
        "analysts",
        "institutional investor",
        "con. call",
        "concall",
        "conference call",
        "investor presentation",
        "earnings call",
    ]),
    ("shareholding_pattern", [
        "shareholding pattern",
    ]),
]

# Explicitly discarded. Kept as a named list rather than an implicit else, so the
# decision is reviewable and a category can be promoted later without archaeology.
NOISE = [
    "copy of newspaper publication",
    "newspaper publication",
    "trading window",
    "certificate under sebi",
    "news verification",
    "news clarification",
    "esop", "esos", "esps",
    "press release",
    "general update",
    "investor complaint",
    "reg. 74(5)",
    "compliance certificate",
]


class FeedError(Exception):
    """Feed returned something unusable — surfaced, never swallowed."""


def fetch(url, retries=4):
    """GET with exponential backoff. Polite to NSE: no tight loops."""
    delay = 2
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:                      # noqa: BLE001 - retry transient
            last = e
        if attempt < retries - 1:
            time.sleep(delay)
            delay *= 2
    raise FeedError(f"failed after {retries} attempts: {last}")


def parse_rows(blob):
    """
    The announcements endpoint returns a BARE LIST, unlike the integrated-filing
    endpoint's {data: [...]}. Both shapes are accepted so a future change to
    either does not silently yield zero rows.
    """
    try:
        payload = json.loads(blob.decode("utf-8", errors="replace"))
    except json.JSONDecodeError as e:
        # A WAF challenge page returns HTTP 200 with HTML. Without this the job
        # would look healthy while ingesting nothing.
        raise FeedError(f"response was not JSON (WAF challenge page?): {e}") from e
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        return payload.get("data") or []
    raise FeedError(f"unexpected payload type {type(payload).__name__}")


def classify(desc):
    """
    NSE category string -> document_type, or None to discard.

    Noise is checked FIRST: "Press Release" would otherwise match nothing and
    fall through to 'other', and a category like "Newspaper Publication of
    Financial Results" must be discarded rather than queued as a result.
    """
    d = (desc or "").strip().lower()
    if not d:
        return None
    if any(n in d for n in NOISE):
        return None
    for doc_type, keywords in ROUTE_TABLE:
        if any(k in d for k in keywords):
            return doc_type
    return None          # unmatched == not interesting enough to queue


def parse_dt(raw):
    """'19-Aug-2026 15:25:28' -> aware datetime in IST. NSE publishes IST."""
    if not raw:
        return None
    for fmt in ("%d-%b-%Y %H:%M:%S", "%d-%b-%Y %H:%M", "%d-%b-%Y"):
        try:
            return datetime.strptime(raw.strip(), fmt).replace(tzinfo=IST)
        except ValueError:
            continue
    return None


def main():
    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        sys.exit("SUPABASE_DB_URL is not set")

    lookback = int(sys.argv[1]) if len(sys.argv) > 1 else 7
    today = datetime.now(IST).date()
    frm = (today - timedelta(days=lookback)).strftime("%d-%m-%Y")
    to = today.strftime("%d-%m-%Y")

    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT c.symbol_nse, c.isin
                FROM companies c JOIN watchlist w ON w.isin = c.isin
                WHERE w.active AND c.symbol_nse IS NOT NULL
                ORDER BY c.symbol_nse
            """)
            targets = cur.fetchall()

        if not targets:
            print("watchlist is empty — nothing to poll")
            return

        queued = skipped = discarded = 0
        drift_alerts = []

        for symbol, isin in targets:
            rows = parse_rows(fetch(API.format(symbol=symbol, frm=frm, to=to)))
            print(f"  {symbol}: {len(rows)} announcement(s) in the window")

            batch = []
            for r in rows:
                doc_type = classify(r.get("desc"))
                if doc_type is None:
                    discarded += 1
                    continue

                # Read the feed's ISIN ONLY to detect drift. It is never used to
                # resolve the company — see the module docstring.
                feed_isin = (r.get("sm_isin") or "").strip()
                if feed_isin and feed_isin != isin:
                    drift_alerts.append((symbol, isin, feed_isin))

                seq = r.get("seq_id")
                batch.append((
                    isin,                                   # from `companies`, never the feed
                    doc_type,
                    (r.get("desc") or "").strip()[:300],
                    (r.get("attchmntText") or "").strip()[:2000] or None,
                    (r.get("attchmntFile") or "").strip() or None,
                    parse_dt(r.get("an_dt") or r.get("exchdisstime")),
                    str(seq) if seq is not None else None,
                ))

            if batch:
                refs = [b[6] for b in batch if b[6]]
                with conn.cursor() as cur:
                    # Count what already exists BEFORE inserting. execute_batch's
                    # rowcount does not reliably report per-statement conflicts,
                    # so the difference is measured rather than inferred.
                    already = 0
                    if refs:
                        cur.execute(
                            "SELECT count(*) FROM filings_queue WHERE external_ref = ANY(%s)",
                            (refs,))
                        already = cur.fetchone()[0]

                    # DO NOTHING, never DO UPDATE: once an item is in the queue
                    # the user may have already processed or dismissed it, and a
                    # re-poll must not resurrect it.
                    psycopg2.extras.execute_batch(cur, """
                        INSERT INTO filings_queue
                          (isin, document_type, title, note, source_url,
                           announced_at, external_ref)
                        VALUES (%s,%s,%s,%s,%s,%s,%s)
                        ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL
                        DO NOTHING
                    """, batch)

                    new = len(batch) - already
                    queued += new
                    skipped += already
                    if new:
                        print(f"    + {new} queued, {already} already present")
            conn.commit()
            time.sleep(1.5)          # be polite between symbols

        # Drift is an ALERT, never an auto-migration: renaming an ISIN cascades
        # across every table, and a false positive would merge two securities.
        # Deduped by message so a daily job cannot spam the banner into
        # irrelevance (the lesson fetch_fundamentals.py already learned).
        if drift_alerts:
            with conn.cursor() as cur:
                for symbol, stored, feed_isin in sorted(set(drift_alerts)):
                    msg = (f"{symbol}: announcements feed reports ISIN {feed_isin}, "
                           f"companies has {stored}. This is EXPECTED for HDFCBANK and "
                           f"SUNPHARMA (the feed is stale); investigate only if the "
                           f"symbol is new. Matching is by symbol, so ingestion is "
                           f"unaffected. See docs/design-corporate-identity.md")
                    cur.execute(
                        "SELECT 1 FROM job_failures WHERE job_name=%s AND error_text=%s",
                        (JOB_NAME, msg))
                    if not cur.fetchone():
                        cur.execute(
                            "INSERT INTO job_failures (job_name, error_text) VALUES (%s,%s)",
                            (JOB_NAME, msg))
            conn.commit()

        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM filings_queue WHERE status='pending'")
            pending = cur.fetchone()[0]

        print(f"\ndone: {queued} newly queued, {skipped} already present, "
              f"{discarded} discarded as noise")
        print(f"{pending} pending task(s) in the queue")

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
