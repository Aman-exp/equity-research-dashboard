# Personal Equity Research Dashboard — Requirements

**Status:** Planning stage
**Owner:** Personal use only

---

## 1. Purpose

A personal research and portfolio-tracking dashboard for Indian equities (NSE/BSE listed stocks). The tool exists to support daily research discipline and long-term decision tracking — it is **not** a trading system and does not place real orders.

---

## 2. Scope Boundaries

- **Equity/stocks only.** No derivatives, no F&O.
- **No live order execution.** The platform never connects to a broker API to place, modify, or cancel a real order.
- **No algorithmic trading against a live account.**
- **Simulation and backtesting ARE in scope** — paper positions, what-if backtests, scenario stress-tests — since these operate only on historical/stored price data and never touch a live broker connection.
- Simulated/paper positions must be stored in a **separate table/section** from real holdings and must never be mixed into real portfolio totals or exposure calculations.

---

## 3. Regulatory Posture

- **Personal use only, forever.** No other person will ever access this tool.
- Because of the above:
  - No SEBI Research Analyst registration required (no recommendations are being issued to others).
  - No NSE/BSE market-data redistribution licensing required (no data is being redistributed to others).
- If this posture ever changes (i.e., sharing with anyone outside personal use), these constraints must be re-evaluated before proceeding.

---

## 4. AI Usage Boundary — Important

- **AI (Claude/Claude Code) may be used to build the tool** — writing code, schema design, pipeline scripts, frontend, etc.
- **The finished, day-to-day dashboard must be fully AI-independent.** No AI/LLM API calls occur at runtime in the dashboard itself.
- **No AI in the daily research workflow.** Extraction of data from filings, annual reports, concalls, etc. is done **manually** by the user into structured forms — not by an automated AI pipeline.
- Any future AI-assisted extraction (if added later) must be optional, clearly separated, and never required for the dashboard to function.

---

## 5. Data Integrity Principles

- Consistency comes from **fixed form schemas** (same fields, same units, every time) — not from AI verification or interpretation.
- **ISIN is the primary key** for companies/instruments — never the ticker symbol (symbols get renamed/reused across NSE and BSE).
- Corporate actions (splits, bonuses, rights issues) must be handled explicitly in the data model from day one.
- Consolidated vs. standalone financials: pick one convention and enforce it at the schema level.
- Every manually entered figure should store **source provenance** — filing URL/filename + page/paragraph reference.
- Historical values should be **appended, not overwritten** (timestamped history), so past reasoning and past data are never lost.

---

## 6. Daily Update Model

Two distinct update types:

1. **Automated, deterministic (no AI, no research judgment):**
   - EOD price refresh from free public sources (bhavcopy, broker free-tier feed).
   - Daily diff of NSE/BSE announcement feed against the personal watchlist (by ISIN) → populates a task queue (e.g., "Company X filed Q2 results — review and update").

2. **Manual, from actual research:**
   - User reviews a queued item, opens the source document, and fills a structured form.
   - This write should land in the database **immediately**, not batched.

The dashboard is therefore **read-mostly with a narrow, structured write path** (manual form entry + task-queue clearing) — not strictly read-only.

---

## 7. Platform & Device Requirements

- **Target platforms: Linux, Windows, Android only.** macOS and iOS are explicitly out of scope — no design or engineering effort should be spent accommodating Safari/iOS limitations.
- Single codebase: a **Progressive Web App (PWA)**, not separate native apps.
- Should install on Android as a home-screen app and run as a normal browser tab/bookmark on Linux/Windows.
- Because iOS is excluded, the build can target **Chrome/Chromium capabilities directly** (Web Share Target API, Background Sync API, Push API, Badging API) without cross-browser compromise.

---

## 8. Phone ↔ PC Consistency

- **No local device-to-device sync logic.** Phone and PC are both clients of a single hosted database (e.g., Postgres) — there is one copy of the data, not two copies that must be reconciled.
- Dashboard must **re-query fresh data on load and on tab/app focus** — no long-lived client-side caching of analysis results across sessions.
- **Offline capture on mobile**, using Background Sync: entries made with no signal are queued locally on-device and pushed to the server once connectivity returns.
- Each record should carry an `updated_at` timestamp; if the same record is edited from two devices near-simultaneously, the system should warn rather than silently overwrite (low-probability edge case for a single user, but cheap to guard against).
- Single shared login/passcode across devices, since the backend is internet-reachable.

---

## 9. Mobile Usability — Critical Requirement

Mobile friction is the primary risk to long-term adoption of this tool. Design principle: **separate "capture" from "process."**

- **Capture (must be under ~15 seconds):**
  - Share a URL directly into the app via Android's native share sheet (Web Share Target API).
  - Snap a photo of a physical/on-screen document as an attachment.
  - Tap a company from a shortlist; optional one-line voice-to-text note.
  - Saves into a "Pending" queue — no full form required at this step.

- **Process (can happen later, on phone or PC):**
  - One task at a time, full-screen, swipe/step through pending items.
  - Different form template per document type (quarterly result / annual report / rating action / etc.).
  - Previous period's values pre-filled as placeholders to minimize retyping.
  - Prefer steppers/segmented controls/dropdowns over free text wherever the value set is small.

- **Habit support (lightweight, non-AI):**
  - Badge/counter for pending items.
  - Push notifications only for hard triggers (e.g., filing due for a held company).
  - Simple "processed this week" indicator — subtle, not naggy.

---

## 10. Additional Features Worth Including

- **Conviction log per holding:** why it's owned, what would change that view — timestamped over time.
- **Review-cadence reminders** (pure calendar logic, e.g. "90 days since last thesis review") — no AI needed.
- **Watchlist vs. portfolio** kept as related but distinct concepts in the same interface.
- **Daily log field:** a short end-of-day note — what was reviewed, what was decided, why.
- **Automated daily backups** of the database to cloud storage — non-negotiable given this becomes years of irreplaceable research.
- **Full data export** (CSV/JSON) always available, to avoid lock-in to any particular frontend.

---

## 11. Explicit Non-Goals

- Not a trading system; never places real orders.
- Not a multi-user product; never distributed or sold.
- Not dependent on AI at runtime for the dashboard to function.
- Not targeting iOS/macOS.
- Not attempting to replicate or compete with commercial screeners on pure ratio/technical screening — differentiation is in structured personal research (filings, provenance, conviction tracking), not in the same widely-available metrics.

---

## 12. Open Decisions (to confirm before/at build time)

- Exact hosting choice for backend + Postgres (e.g., Supabase/Neon/Railway/self-hosted VPS).
- Exact set of free data sources to integrate first (NSE/BSE bhavcopy, XBRL filings, announcement feed, broker free-tier API).
- Initial watchlist size for MVP (recommended: 5 companies to validate the workflow before scaling).
- Whether desktop is "PC = process/batch cleanup" and phone is "capture-first," or some other split, based on actual daily routine once tested.
