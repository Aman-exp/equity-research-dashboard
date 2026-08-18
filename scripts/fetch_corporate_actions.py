#!/usr/bin/env python3
"""
Corporate action ingestion — splits and bonuses for watchlist companies.

These are load-bearing for correctness: without them, a split or bonus silently
breaks share counts and makes historical prices incomparable. See
docs/design-corporate-identity.md.

WHY EVERYTHING LANDS AS 'unverified'
------------------------------------
This script parses free text ("Bonus 1:2", "Face Value Split ... From Rs 2 ... To
Rs 1"). Text parsing is deterministic but fallible, and a mis-parsed action would
corrupt every quantity and price in the app. adj_factor() therefore ignores
unverified rows; they surface via v_pending_corporate_actions for confirmation.

RATIO CONVENTIONS — read carefully, they are easy to invert
-----------------------------------------------------------
ca_factor() defines: split -> ratio_to/ratio_from ; bonus -> 1 + ratio_to/ratio_from

* "Bonus 1:2" in Indian usage = 1 NEW share for every 2 HELD -> holding x1.5.
  So ratio_to = 1 (new), ratio_from = 2 (held). Note this is inverted from
  reading the string left-to-right as from:to. Verified against real events:
  ITC 1:2 (2016), L&T 1:2 (2017), Infosys 1:1 (2018), HDFC Bank 1:1 (2025).

* Face value split "From Rs 10 To Rs 2" means 1 share becomes 5. Normalised to
  ratio_from = 1, ratio_to = old_fv/new_fv, matching the spec's "1 share becomes
  N" convention.

Usage:
    python fetch_corporate_actions.py
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime
from decimal import Decimal

import psycopg2

API = ("https://www.nseindia.com/api/corporates-corporateActions"
       "?index=equities&symbol={symbol}")

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
    "Referer": "https://www.nseindia.com/",
}

JOB_NAME = "corporate_actions_fetch"

# "Bonus 1:2" -> new=1, held=2
RE_BONUS = re.compile(r"\bbonus\b\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)", re.I)
# Handles both observed forms:
#   "Face Value Split (Sub-Division) - From Rs 2 Per Share To Rs 1 Per Share"
#   "Face Value Split From Rs.10/- To Rs.2/-"
RE_FV_SPLIT = re.compile(
    r"from\s*rs\.?\s*(\d+(?:\.\d+)?)\D*?to\s*rs\.?\s*(\d+(?:\.\d+)?)", re.I)
# Anything mentioning these but not parsed above needs human eyes.
RE_INTERESTING = re.compile(r"bonus|split|sub-division|consolidat|rights", re.I)


def fetch(url, retries=4):
    delay = 2
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8", errors="replace"))
        except Exception as e:                      # noqa: BLE001 - retry transient
            last = e
        if attempt < retries - 1:
            time.sleep(delay)
            delay *= 2
    raise RuntimeError(f"failed after {retries} attempts: {url} ({last})")


def parse_action(subject):
    """
    Return (action_type, ratio_from, ratio_to) or None.

    Returning None for something that LOOKS like an action is deliberate: it is
    reported for manual entry rather than guessed at.
    """
    subject = (subject or "").strip()

    m = RE_BONUS.search(subject)
    if m:
        new, held = Decimal(m.group(1)), Decimal(m.group(2))
        if held > 0:
            return ("bonus", held, new)          # ratio_from=held, ratio_to=new

    m = RE_FV_SPLIT.search(subject)
    if m:
        old_fv, new_fv = Decimal(m.group(1)), Decimal(m.group(2))
        # A face value going UP is a reverse split/consolidation; the same
        # arithmetic holds (ratio_to < 1), but flag it since it is rare enough
        # to be worth a human look.
        if new_fv > 0 and old_fv > 0:
            return ("split", 1, old_fv / new_fv)

    return None


def main():
    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        sys.exit("SUPABASE_DB_URL is not set")

    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT c.isin, c.symbol_nse
                FROM companies c JOIN watchlist w ON w.isin = c.isin
                WHERE w.active AND c.symbol_nse IS NOT NULL
                ORDER BY c.symbol_nse
            """)
            targets = cur.fetchall()

        inserted = unparsed = 0
        for isin, symbol in targets:
            rows = fetch(API.format(symbol=symbol))
            found = []
            for r in rows:
                subject = (r.get("subject") or "").strip()
                ex_raw = (r.get("exDate") or "").strip()
                if not ex_raw or ex_raw == "-":
                    continue
                parsed = parse_action(subject)
                if parsed is None:
                    if RE_INTERESTING.search(subject):
                        print(f"  ! {symbol}: could not parse, enter manually -> "
                              f"{ex_raw} | {subject}")
                        unparsed += 1
                    continue
                action_type, rf, rt = parsed
                ex_date = datetime.strptime(ex_raw, "%d-%b-%Y").date()
                found.append((isin, action_type, rf, rt, ex_date, subject))

            with conn.cursor() as cur:
                for isin_, atype, rf, rt, ex_date, subject in found:
                    # DO NOTHING, never DO UPDATE: re-running must not overwrite a
                    # row a human has already reviewed and corrected.
                    cur.execute("""
                        INSERT INTO corporate_actions
                          (isin, action_type, ratio_from, ratio_to, ex_date,
                           notes, entry_mode, status)
                        VALUES (%s,%s,%s,%s,%s,%s,'auto','unverified')
                        ON CONFLICT (isin, action_type, ex_date) DO NOTHING
                    """, (isin_, atype, rf, rt, ex_date, f"auto-parsed: {subject}"))
                    if cur.rowcount:
                        inserted += 1
                        print(f"  + {symbol}: {atype} {rf}:{rt} ex {ex_date}  ({subject})")
            conn.commit()
            time.sleep(1)          # be polite

        print(f"\ndone: {inserted} new action(s) staged as unverified, "
              f"{unparsed} needing manual entry")
        if inserted:
            print("Review them before they take effect:")
            print("  SELECT * FROM v_pending_corporate_actions;")

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
