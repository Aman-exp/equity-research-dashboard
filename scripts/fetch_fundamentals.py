#!/usr/bin/env python3
"""
Quarterly fundamentals ingestion from NSE integrated-filing XBRL.

This is the centerpiece of the reduce-manual-entry plan: instead of transcribing
15 numbers per company per quarter from a PDF, filings land here automatically as
`entry_mode='auto', status='unverified'` rows, and the user confirms them in the
review inbox. Nothing unverified feeds a dashboard number un-flagged.

SOURCE (verified live 2026-08-15 — see build spec 8a):
  /api/integrated-filing-results?index=equities&symbol=X
  The old /api/corporates-financial-results is FROZEN at Jan-2025; do not use it
  for current data. It remains valid only for pre-2025 backfill (different
  namespace: in-bse-fin).

PARSER FACTS THAT ARE EASY TO GET WRONG (each one verified against real filings):
  * Namespace is `in-capmkt` with a version-dated URI — match tags by LOCAL NAME
    only, or the parser breaks at the next SEBI taxonomy revision.
  * Two vocabularies, distinguished by the XBRL filename:
      INTEGRATED_FILING_INDAS_*   -> normal companies (RevenueFromOperations...)
      INTEGRATED_FILING_BANKING_* -> banks/NBFCs (Income, InterestEarned...);
    there is NO RevenueFromOperations in a banking filing. HDFC Bank is this case.
  * LevelOfRounding says 'Crores' but values are ABSOLUTE RUPEES. Never multiply.
  * contextRef: quarter figures live in a duration context with no dimensional
    members; contexts carrying explicitMember are segment breakdowns — ignore.
  * The XBRL carries the CURRENT ISIN (unlike the frozen legacy feed), but it is
    still passed through resolve_isin() in case of future drift.
  * CFO/capex are not tagged quarterly — left null, filled at confirm time.

EBIT/EBITDA are derived (EBIT = PBT + finance costs; EBITDA = EBIT + D&A) for
INDAS filers only — the identities are meaningless for banks, so bank rows leave
them null rather than storing a number that looks comparable but is not.

CONFIRMED ROWS ARE NEVER OVERWRITTEN. Re-ingesting updates only rows still
`unverified`. If a revised filing arrives for a quarter the user already
confirmed, the job writes a `job_failures` alert (restatements need human eyes,
not silent replacement) — the dashboard banner surfaces it.

Usage:
    python fetch_fundamentals.py            # all active watchlist companies
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from datetime import datetime, date
from decimal import Decimal, InvalidOperation

import psycopg2

API = ("https://www.nseindia.com/api/integrated-filing-results"
       "?index=equities&symbol={symbol}")

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
    "Referer": "https://www.nseindia.com/companies-listing/corporate-filings-financial-results",
}

JOB_NAME = "fundamentals_fetch"

# field -> ordered candidate local names (first match wins)
INDAS_MAP = {
    "revenue":  ["RevenueFromOperations"],
    "pat":      ["ProfitLossForPeriod",
                 "ProfitLossForPeriodFromContinuingOperations"],
    "pbt":      ["ProfitBeforeTax"],
    "interest": ["FinanceCosts"],
    "dep":      ["DepreciationDepletionAndAmortisationExpense"],
    "eps":      ["BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations",
                 "BasicEarningsLossPerShareFromContinuingOperations"],
}
BANKING_MAP = {
    "revenue":  ["Income"],
    "pat":      ["ProfitLossAfterTaxesMinorityInterestAndShareOfProfitLossOfAssociates",
                 "ProfitLossFromOrdinaryActivitiesAfterTax"],
    "pbt":      ["ProfitLossFromOrdinaryActivitiesBeforeTax"],
    "interest": ["InterestExpended"],
    "dep":      [],
    "eps":      ["BasicEarningsPerShareAfterExtraordinaryItems",
                 "BasicEarningsPerShareBeforeExtraordinaryItems"],
}


class Missing(Exception):
    """404 — the feed row exists but the archive file does not. Seen in the wild
    (Sun Pharma, Jul-2025 filing): alert and continue, never abort the job."""


class Throttled(Exception):
    """
    NSE answered with a web page instead of the file.

    Kept distinct from Missing on purpose. Missing means the filing genuinely is
    not on the archive and never will be — worth a one-off alert telling you to
    enter it by hand. Throttled means the filing EXISTS and we were rate-limited;
    the right response is to retry later, not to record it as permanently absent.
    Conflating them would either spam the banner with transient failures or
    quietly mark real filings as unavailable.
    """


def looks_like_html(blob):
    head = blob[:512].lstrip()[:64].lower()
    return head.startswith(b"<!doctype") or head.startswith(b"<html") or b"<head" in head


def fetch(url, retries=4):
    delay = 2
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                blob = r.read()
            # HTTP 200 is not proof of content. Observed 2026-08-22: while an EOD
            # backfill was running, NSE's WAF answered XBRL requests with an HTML
            # page and a 200, and ET.fromstring died on "mismatched tag" — an
            # error that says nothing about the real cause. Validate what arrived.
            if looks_like_html(blob):
                last = Throttled("server returned an HTML page instead of the file")
            else:
                return blob
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise Missing(url)
            last = e
        except Exception as e:                      # noqa: BLE001 - retry transient
            last = e
        if attempt < retries - 1:
            time.sleep(delay)
            delay *= 2                              # 2s, 4s, 8s — let the WAF cool off
    if isinstance(last, Throttled):
        raise Throttled(f"{url}: {last}")
    raise RuntimeError(f"failed after {retries} attempts: {url} ({last})")


def local(tag):
    """'{uri}Name' -> 'Name'. Version-dated namespaces make URI matching brittle."""
    return tag.rsplit("}", 1)[-1]


def parse_xbrl(blob, is_banking):
    """
    Return dict of extracted fields for the main (whole-entity, quarter) context.

    Context selection is semantic, not by id: the quarter context is the duration
    context with NO dimensional members whose end date equals the filing's
    DateOfEndOfReportingPeriod, taking the SHORTEST such duration (quarter beats
    YTD). Falls back to the conventional id 'OneD' if that fails.
    """
    root = ET.fromstring(blob)

    contexts = {}          # id -> (start, end, has_members)
    for ctx in root.iter():
        if local(ctx.tag) != "context":
            continue
        cid = ctx.get("id")
        start = end = None
        has_members = False
        for el in ctx.iter():
            name = local(el.tag)
            if name == "startDate":
                start = el.text.strip()
            elif name == "endDate":
                end = el.text.strip()
            elif name == "explicitMember":
                has_members = True
        if cid:
            contexts[cid] = (start, end, has_members)

    facts = {}             # local_name -> {context_id: text}
    for el in root.iter():
        name = local(el.tag)
        ctx = el.get("contextRef")
        if ctx is None or el.text is None:
            continue
        facts.setdefault(name, {})[ctx] = el.text.strip()

    def any_ctx(name):
        vals = facts.get(name) or {}
        return next(iter(vals.values()), None)

    period_end = any_ctx("DateOfEndOfReportingPeriod")
    isin = any_ctx("ISIN")

    main_ctx = None
    if period_end:
        candidates = [
            (cid, s, e) for cid, (s, e, mem) in contexts.items()
            if not mem and s and e and e == period_end
        ]
        if candidates:
            main_ctx = min(
                candidates,
                key=lambda c: (date.fromisoformat(c[2]) - date.fromisoformat(c[1])).days,
            )[0]
    if main_ctx is None and "OneD" in contexts:
        main_ctx = "OneD"
    if main_ctx is None:
        raise ValueError("could not identify the quarter context")

    mapping = BANKING_MAP if is_banking else INDAS_MAP

    def num(field):
        # Decimal, not float: values go into `numeric` columns, and the
        # numeric-never-float rule applies at the ingestion boundary too.
        for name in mapping[field]:
            v = (facts.get(name) or {}).get(main_ctx)
            if v not in (None, ""):
                try:
                    return Decimal(v)
                except InvalidOperation:
                    continue
        return None

    out = {f: num(f) for f in mapping}
    out["isin"] = isin
    out["period_end"] = period_end

    # Derived identities — INDAS only; meaningless for banks.
    out["ebit"] = out["ebitda"] = None
    if not is_banking:
        if out["pbt"] is not None and out["interest"] is not None:
            out["ebit"] = out["pbt"] + out["interest"]
            if out["dep"] is not None:
                out["ebitda"] = out["ebit"] + out["dep"]
    return out


def main():
    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        sys.exit("SUPABASE_DB_URL is not set")

    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT c.symbol_nse, c.isin FROM companies c
                JOIN watchlist w ON w.isin = c.isin
                WHERE w.active AND c.symbol_nse IS NOT NULL
                ORDER BY c.symbol_nse
            """)
            targets = cur.fetchall()

        staged = updated = skipped = alerts = 0
        # Filings we could not fetch because of rate limiting. Distinct from
        # `alerts`: these are transient and self-healing on the next run, so they
        # get one summary line rather than a durable per-filing banner row.
        deferred = []
        for symbol, company_isin in targets:
            # HEAD-OF-LINE BLOCKING FIX. This call used to sit outside any
            # handler, so a single symbol failing — a rename, a delisting, or
            # simply being throttled — aborted the entire run and the four
            # companies after it were never polled. Record and move on instead.
            try:
                payload = fetch(API.format(symbol=symbol))
                rows = json.loads(payload.decode("utf-8", "replace"))
            except (Throttled, Missing, RuntimeError, json.JSONDecodeError) as exc:
                print(f"  ! {symbol}: could not fetch the filing index — {exc}")
                deferred.append(f"{symbol} (filing index)")
                time.sleep(3)                       # back off before the next symbol
                continue

            rows = [r for r in (rows.get("data") or [])
                    if r.get("type") == "Integrated Filing- Financials"
                    and r.get("xbrl") and r.get("consolidated")]

            # Restatements arrive as extra rows; keep only the latest broadcast
            # per (quarter, consolidated/standalone).
            latest = {}
            for r in rows:
                key = (r.get("qe_Date"), r.get("consolidated"))
                prev = latest.get(key)
                if prev is None or (r.get("broadcast_Date") or "") > (prev.get("broadcast_Date") or ""):
                    latest[key] = r

            # ONE BASIS PER QUARTER: consolidated where available, standalone
            # only as a fallback. This is the convention the build spec settled
            # on (§14) and it was not being applied — every quarter was staged
            # twice.
            #
            # Measured 2026-08-22: all 5 watchlist companies file BOTH bases for
            # every quarter, so staging both exactly doubled the review queue
            # (58 rows where 29 were meaningful) with no added information. Worse
            # than redundant for a holding company: L&T's Sep-2025 STANDALONE PAT
            # is -3,591 Cr, entirely a one-off exceptional item, which drags its
            # standalone TTM P/E to 77.6 against a consolidated 33.9. Asking the
            # user to review that row invites confirming a number that should
            # never drive a decision.
            #
            # A company reporting no consolidated figures still gets its
            # standalone row, so nothing is lost; manual entry remains available
            # for the rare case where the other basis is genuinely wanted.
            by_quarter = {}
            for (qe_date, basis), r in latest.items():
                b = (basis or "").strip().lower()
                held = by_quarter.get(qe_date)
                if held is None or (held[0] != "consolidated" and b == "consolidated"):
                    by_quarter[qe_date] = (b, r)

            dropped = len(latest) - len(by_quarter)
            if dropped:
                print(f"  {symbol}: {dropped} redundant standalone filing(s) not staged "
                      f"(consolidated available)")

            for _basis, r in by_quarter.values():
                xbrl_url = r["xbrl"]
                filing_type = r["consolidated"].strip().lower()   # consolidated|standalone
                qe = datetime.strptime(r["qe_Date"].strip().title(), "%d-%b-%Y").date()

                with conn.cursor() as cur:
                    # Skip the download when this exact filing is already stored.
                    cur.execute("""
                        SELECT 1 FROM fundamentals_quarterly
                        WHERE isin=%s AND period_end=%s AND filing_type=%s AND source_url=%s
                    """, (company_isin, qe, filing_type, xbrl_url))
                    if cur.fetchone():
                        skipped += 1
                        continue

                is_banking = "BANKING" in xbrl_url.upper()
                try:
                    parsed = parse_xbrl(fetch(xbrl_url), is_banking)
                except Throttled as exc:
                    # Transient: the filing exists, we were rate-limited. Defer
                    # to the next run rather than recording it as missing —
                    # tomorrow's run picks it up because nothing was stored.
                    print(f"  ~ {symbol} {r['qe_Date']} {filing_type}: throttled, "
                          f"will retry next run")
                    deferred.append(f"{symbol} {r['qe_Date']} {filing_type}")
                    time.sleep(5)
                    continue
                except ET.ParseError as exc:
                    # Reached only when the payload is neither HTML nor valid XML
                    # — a genuinely malformed filing. Worth a durable alert,
                    # deduped, because re-parsing it tomorrow will fail the same
                    # way and only a human can resolve it.
                    msg = (f"{symbol} {r['qe_Date']} {filing_type}: XBRL is not "
                           f"parseable ({exc}). Enter manually if needed: {xbrl_url}")
                    with conn.cursor() as cur:
                        cur.execute(
                            "SELECT 1 FROM job_failures WHERE job_name=%s AND error_text=%s",
                            (JOB_NAME, msg))
                        if not cur.fetchone():
                            cur.execute(
                                "INSERT INTO job_failures (job_name, error_text) VALUES (%s,%s)",
                                (JOB_NAME, msg))
                            alerts += 1
                            print(f"  ! {symbol} {r['qe_Date']}: unparseable XBRL — alert raised")
                    continue
                except Missing:
                    msg = (f"{symbol} {r['qe_Date']} {filing_type}: XBRL file missing "
                           f"on archive host (404) — enter manually if needed: {xbrl_url}")
                    with conn.cursor() as cur:
                        # Dedupe: this job re-sees the same missing file every run;
                        # re-alerting daily would train the user to ignore the banner.
                        cur.execute(
                            "SELECT 1 FROM job_failures WHERE job_name=%s AND error_text=%s",
                            (JOB_NAME, msg))
                        if not cur.fetchone():
                            cur.execute(
                                "INSERT INTO job_failures (job_name, error_text) VALUES (%s,%s)",
                                (JOB_NAME, msg))
                            alerts += 1
                            print(f"  ! {symbol} {r['qe_Date']} {filing_type}: XBRL 404 — alert raised")
                    continue
                time.sleep(0.5)

                with conn.cursor() as cur:
                    cur.execute("SELECT resolve_isin(%s)", (parsed["isin"],))
                    isin = cur.fetchone()[0]
                    if isin != company_isin:
                        cur.execute(
                            "INSERT INTO job_failures (job_name, error_text) VALUES (%s,%s)",
                            (JOB_NAME,
                             f"{symbol}: XBRL ISIN {parsed['isin']} resolves to {isin}, "
                             f"but companies has {company_isin} — possible ISIN drift, "
                             f"filing NOT ingested. See docs/design-corporate-identity.md"))
                        alerts += 1
                        continue

                    period_end = parsed["period_end"] or qe.isoformat()
                    values = (parsed["revenue"], parsed["ebitda"], parsed["pat"],
                              parsed["interest"], parsed["ebit"], parsed["eps"])

                    cur.execute("""
                        SELECT status, revenue, pat, eps FROM fundamentals_quarterly
                        WHERE isin=%s AND period_end=%s AND filing_type=%s
                    """, (isin, period_end, filing_type))
                    existing = cur.fetchone()

                    if existing and existing[0] == "confirmed":
                        old_rev, old_pat, old_eps = existing[1], existing[2], existing[3]
                        def differs(a, b):
                            return (a is None) != (b is None) or (
                                a is not None and
                                abs(Decimal(a) - Decimal(b)) > Decimal("0.005"))
                        if differs(old_rev, parsed["revenue"]) or \
                           differs(old_pat, parsed["pat"]) or differs(old_eps, parsed["eps"]):
                            cur.execute(
                                "INSERT INTO job_failures (job_name, error_text) VALUES (%s,%s)",
                                (JOB_NAME,
                                 f"{symbol} {period_end} {filing_type}: a revised filing "
                                 f"differs from the CONFIRMED row (e.g. eps {old_eps} -> "
                                 f"{parsed['eps']}). Not overwritten — review {xbrl_url}"))
                            alerts += 1
                            print(f"  ! {symbol} {period_end}: restatement of a confirmed row — alert raised")
                        else:
                            skipped += 1
                        continue

                    cur.execute("""
                        INSERT INTO fundamentals_quarterly
                          (isin, period_end, filing_type, revenue, ebitda, pat,
                           interest_expense, ebit, eps, source_url, entry_mode, status)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'auto','unverified')
                        ON CONFLICT (isin, period_end, filing_type) DO UPDATE SET
                          revenue=EXCLUDED.revenue, ebitda=EXCLUDED.ebitda,
                          pat=EXCLUDED.pat, interest_expense=EXCLUDED.interest_expense,
                          ebit=EXCLUDED.ebit, eps=EXCLUDED.eps,
                          source_url=EXCLUDED.source_url
                        WHERE fundamentals_quarterly.status = 'unverified'
                    """, (isin, period_end, filing_type, *values, xbrl_url))
                    if existing:
                        updated += 1
                        print(f"  ~ {symbol} {period_end} {filing_type}: unverified row updated")
                    else:
                        staged += 1
                        eps_s = parsed["eps"] if parsed["eps"] is not None else "—"
                        print(f"  + {symbol} {period_end} {filing_type}: eps {eps_s} "
                              f"({'banking' if is_banking else 'indas'} schema)")
            conn.commit()
            time.sleep(1)          # be polite between symbols

        print(f"\ndone: {staged} staged, {updated} updated, {skipped} already present, "
              f"{alerts} alert(s)")
        if staged:
            print("New rows are UNVERIFIED and flagged on the dashboard until confirmed.")

        # Rate-limited filings are reported but NOT written to job_failures: the
        # next scheduled run retries them automatically (nothing was stored, so
        # the already-present check does not skip them), and a self-healing
        # condition does not deserve a banner the user has to dismiss. It only
        # becomes an alert if it persists — which shows up as a filing that never
        # arrives, visible in the review inbox staying empty after results day.
        if deferred:
            print(f"\n{len(deferred)} filing(s) deferred to the next run (rate limited): "
                  f"{', '.join(deferred[:10])}{' …' if len(deferred) > 10 else ''}")
            print("This is normal while an EOD backfill is running — both jobs share "
                  "NSE's rate limit. No action needed unless it repeats for days.")

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
