import {
  useFreshness, useJobFailures, usePendingActions, useAcknowledgeFailures,
  useWatchlist, useLatestPrices, usePortfolio, useConvictions,
  useIndexLatest, usePE,
} from '../lib/queries.js'
import { inr, num, daysSince, tradingDaysSince } from '../lib/supabase.js'

export default function Dashboard({ onOpen, onReview }) {
  const freshness = useFreshness()
  const failures = useJobFailures()
  const ack = useAcknowledgeFailures()
  const pending = usePendingActions()
  const watchlist = useWatchlist()
  const prices = useLatestPrices()
  const portfolio = usePortfolio()
  const convictions = useConvictions()
  const nifty = useIndexLatest('NIFTY 50')
  const pe = usePE()

  const asOf = freshness.data?.[0]?.prices_as_of
  const stale = daysSince(asOf)
  // Weekend-aware, so a Friday close does not read as "stale" on Sunday.
  const staleTrading = tradingDaysSince(asOf)

  return (
    <div className="space-y-6">
      {/* Banners first: an unnoticed failure or unconfirmed action silently
          corrupts everything below, so they precede the numbers. */}
      {failures.data?.length > 0 && (
        <Banner tone="red" title={`${failures.data.length} job failure(s) in the last 7 days`}>
          <ul className="mt-1 space-y-2">
            {failures.data.slice(0, 6).map((f) => (
              <li key={f.id} className="flex items-start gap-2 text-xs">
                <span className="min-w-0 flex-1">
                  <span className="font-mono">{f.job_name}</span> — {f.error_text}
                </span>
                <button
                  onClick={() => ack.mutate([f.id])}
                  disabled={ack.isPending}
                  title="Keeps the record, stops the alert"
                  className="shrink-0 rounded border border-rose-300 px-2 py-0.5 text-[11px] hover:bg-rose-100 disabled:opacity-50 dark:border-rose-800 dark:hover:bg-rose-900/40"
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
          {failures.data.length > 1 && (
            <button
              onClick={() => ack.mutate(failures.data.map((f) => f.id))}
              disabled={ack.isPending}
              className="mt-2 rounded-lg bg-rose-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-rose-200 dark:text-rose-950"
            >
              {ack.isPending ? 'Dismissing…' : `Dismiss all ${failures.data.length}`}
            </button>
          )}
        </Banner>
      )}

      {pending.data?.length > 0 && (
        <Banner tone="amber" title={`${pending.data.length} unconfirmed corporate action(s)`}>
          <p className="mt-1 text-xs">
            These are <strong>not applied</strong> until confirmed, so quantities and adjusted
            prices for the affected companies are currently understated.
          </p>
          <ul className="mt-2 space-y-1">
            {pending.data.map((a, i) => (
              <li key={i} className="text-xs tnum">
                {a.company_name} — {a.action_type} {num(a.ratio_from, 0)}:{num(a.ratio_to, 0)} ex{' '}
                {a.ex_date} (would scale ×{num(a.would_apply_factor, 2)})
                {a.affects_a_position && (
                  <span className="ml-1 font-semibold">· affects a position</span>
                )}
              </li>
            ))}
          </ul>
          {onReview && (
            <button
              onClick={onReview}
              className="mt-2 rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-amber-200 dark:text-amber-950"
            >
              Review and confirm
            </button>
          )}
        </Banner>
      )}

      {/* Counted in trading days, not calendar days: NSE holiday clusters made
          the calendar-day version cry wolf every long weekend, and an alert that
          is usually wrong is worse than no alert. */}
      {asOf && staleTrading > 3 && (
        <Banner tone="amber" title={`Prices are ${staleTrading} trading days old`}>
          <p className="mt-1 text-xs">
            Last close {asOf}. Check the EOD workflow before acting on anything here.
          </p>
        </Banner>
      )}

      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        {/* Freshness is always visible, never buried. */}
        <p className="text-xs text-slate-500 dark:text-slate-400 tnum">
          prices as of {asOf ?? '—'}
        </p>
      </div>

      <MarketContext nifty={nifty} />

      <Portfolio query={portfolio} />

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
          Watchlist
        </h2>
        <QueryState query={watchlist} empty="No companies on the watchlist.">
          <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Company</th>
                  <th className="px-3 py-2 font-medium">Sector</th>
                  <th className="px-3 py-2 text-right font-medium">Close</th>
                  <th className="px-3 py-2 text-right font-medium">1d</th>
                  <th className="px-3 py-2 text-right font-medium">P/E</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {(watchlist.data ?? []).map((w) => {
                  const p = prices.data?.[w.isin]
                  const chg = p?.prev ? ((p.close - p.prev) / p.prev) * 100 : null
                  const v = pe.data?.[w.isin]
                  return (
                    <tr
                      key={w.isin}
                      onClick={() => onOpen(w.isin)}
                      // Keyboard-reachable: this is the only navigation into a
                      // company, and a bare <tr onClick> is mouse/touch-only.
                      tabIndex={0}
                      role="link"
                      aria-label={`Open ${w.companies?.company_name ?? w.isin}`}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onOpen(w.isin)
                        }
                      }}
                      className="cursor-pointer hover:bg-slate-50 focus:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 dark:hover:bg-slate-900/60 dark:focus:bg-slate-900/60"
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium">{w.companies?.company_name}</div>
                        <div className="text-xs text-slate-500">{w.companies?.symbol_nse}</div>
                      </td>
                      <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                        {w.companies?.sector ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right tnum">{p ? inr(p.close) : '—'}</td>
                      <td className={`px-3 py-2 text-right tnum ${
                        chg === null ? 'text-slate-400'
                        : chg >= 0 ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400'}`}>
                        {chg === null ? '—' : `${chg >= 0 ? '+' : ''}${num(chg, 2)}%`}
                      </td>
                      <td className="px-3 py-2 text-right tnum">
                        {v?.pe_current == null ? (
                          <span className="text-slate-400">—</span>
                        ) : (
                          <span
                            // An unverified quarter inside TTM EPS is surfaced,
                            // never silently folded into the headline number.
                            className={v.has_unverified ? 'text-amber-700 dark:text-amber-400' : ''}
                            title={
                              v.has_unverified
                                ? 'Includes unconfirmed quarters — confirm in Review'
                                : `${v.filing_type} · TTM EPS ${num(v.eps_ttm)}`
                            }
                          >
                            {num(v.pe_current, 1)}
                            {v.has_unverified && '*'}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {Object.values(pe.data ?? {}).some((v) => v?.has_unverified) && (
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              * P/E includes quarters that are still unconfirmed —{' '}
              <button onClick={onReview} className="underline hover:text-slate-700 dark:hover:text-slate-200">
                review them
              </button>
              .
            </p>
          )}
        </QueryState>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
          Recent conviction entries
        </h2>
        <QueryState
          query={convictions}
          empty="No thesis recorded yet. Open a company to write one."
        >
          <ul className="space-y-2">
            {(convictions.data ?? []).slice(0, 5).map((c) => (
              <li key={c.id} className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
                <div className="flex justify-between text-xs text-slate-500">
                  <span className="font-mono">{c.isin}</span>
                  <span className="tnum">{c.entry_date}</span>
                </div>
                <p className="mt-1">{c.thesis_text}</p>
              </li>
            ))}
          </ul>
        </QueryState>
      </section>
    </div>
  )
}

/**
 * NIFTY 50 close and 1d move.
 *
 * The EOD job has been storing this since day one and nothing ever showed it.
 * Without an index reference, "ITC fell 2%" is unreadable — the user cannot tell
 * a company-specific move from the whole market moving.
 */
function MarketContext({ nifty }) {
  const d = nifty.data
  if (!d) return null
  const chg = d.prev ? ((Number(d.close) - Number(d.prev)) / Number(d.prev)) * 100 : null

  return (
    <section className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 dark:border-slate-800">
      <span className="text-xs text-slate-500 dark:text-slate-400">{d.index_name}</span>
      <span className="text-sm font-semibold tnum">{num(d.close, 2)}</span>
      {chg !== null && (
        <span className={`text-xs font-medium tnum ${
          chg >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
          {chg >= 0 ? '+' : ''}{num(chg, 2)}%
        </span>
      )}
      <span className="ml-auto text-xs text-slate-400 tnum">{d.date}</span>
    </section>
  )
}

/** Portfolio degrades to an honest empty state rather than pretending — but an
 *  RLS/auth denial is NOT the same thing as "no transactions yet" and must not
 *  be silently presented as one. Conflating them would read as a real empty
 *  portfolio during, say, an expired session, when access was actually denied. */
function Portfolio({ query }) {
  const rows = query.data ?? []
  const total = rows.reduce((s, r) => s + Number(r.current_value ?? 0), 0)
  const pnl = rows.reduce((s, r) => s + Number(r.unrealized_pnl ?? 0), 0)

  if (query.isError) {
    return (
      <section className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
        Could not load portfolio: {query.error.message}
      </section>
    )
  }

  if (!query.isLoading && rows.length === 0) {
    return (
      <section className="rounded-xl border border-dashed border-slate-300 p-6 text-center dark:border-slate-700">
        <h2 className="text-sm font-semibold">No holdings yet</h2>
        <p className="mx-auto mt-1 max-w-md text-xs text-slate-500 dark:text-slate-400">
          Positions are derived from transactions, so this fills in automatically once trades are
          imported. Until then the research side — watchlist and conviction log — is the useful part.
        </p>
      </section>
    )
  }

  return (
    <section className="grid gap-3 sm:grid-cols-3">
      <Stat label="Portfolio value" value={inr(total)} />
      <Stat
        label="Unrealised P&L"
        value={inr(pnl)}
        tone={pnl >= 0 ? 'up' : 'down'}
      />
      <Stat label="Positions" value={rows.length} />
    </section>
  )
}

function Stat({ label, value, tone }) {
  return (
    <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-1 text-lg font-semibold tnum ${
        tone === 'up' ? 'text-emerald-600 dark:text-emerald-400'
        : tone === 'down' ? 'text-rose-600 dark:text-rose-400' : ''}`}>
        {value}
      </div>
    </div>
  )
}

function Banner({ tone, title, children }) {
  const tones = {
    red: 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200',
    amber: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
  }
  return (
    <div className={`rounded-xl border p-3 ${tones[tone]}`}>
      <div className="text-sm font-semibold">{title}</div>
      {children}
    </div>
  )
}

export function QueryState({ query, empty, children }) {
  if (query.isLoading) return <Muted>Loading…</Muted>
  if (query.isError) return <Muted tone="error">{String(query.error.message)}</Muted>
  if (!query.data || query.data.length === 0) return <Muted>{empty}</Muted>
  return children
}

function Muted({ children, tone }) {
  return (
    <p className={`rounded-lg border border-slate-200 p-4 text-sm dark:border-slate-800 ${
      tone === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'}`}>
      {children}
    </p>
  )
}
