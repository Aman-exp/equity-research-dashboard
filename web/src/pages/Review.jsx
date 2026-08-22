import { useMemo, useState } from 'react'
import {
  usePendingActions, useAllFundamentals,
  useConfirmFundamentals, useConfirmCorporateActions,
} from '../lib/queries.js'
import { crore, num } from '../lib/supabase.js'

/**
 * Review inbox — the one screen that turns staged data into live data.
 *
 * Auto-ingested rows are deliberately inert until confirmed here. The design
 * goal is to make review FAST BUT REAL: fast, or 58 rows becomes the manual-entry
 * fatigue this project exists to avoid; real, or the unverified flag is theatre.
 *
 * So each row carries enough context to judge it at a glance — the figures in
 * crore, quarter-on-quarter movement, a direct link to the exact XBRL it came
 * from — and anything unusual (missing value, loss, big swing) is flagged for a
 * closer look rather than left for you to spot.
 */
export default function Review() {
  const actions = usePendingActions()
  const fundamentals = useAllFundamentals()

  const groups = useMemo(() => {
    const rows = fundamentals.data ?? []
    // Quarter-on-quarter needs the confirmed rows too, so compare within the
    // full history and then show only what still needs review.
    const prior = new Map()
    const sorted = [...rows].sort((a, b) => a.period_end.localeCompare(b.period_end))
    for (const r of sorted) {
      const key = `${r.isin}|${r.filing_type}`
      r._prev = prior.get(key) ?? null
      prior.set(key, r)
    }
    const byCompany = new Map()
    for (const r of rows) {
      if (r.status !== 'unverified') continue
      const name = r.companies?.company_name ?? r.isin
      if (!byCompany.has(r.isin)) byCompany.set(r.isin, { name, rows: [] })
      byCompany.get(r.isin).rows.push(r)
    }
    return [...byCompany.entries()]
      .map(([isin, g]) => ({ isin, ...g }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [fundamentals.data])

  const totalPending = groups.reduce((s, g) => s + g.rows.length, 0)
  const nothingToDo = !actions.data?.length && totalPending === 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Review inbox</h1>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Auto-ingested data does not affect any number until you confirm it here.
        </p>
      </div>

      {nothingToDo && (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
          <p className="text-sm font-medium">Nothing to review</p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            New filings and corporate actions will appear here automatically.
          </p>
        </div>
      )}

      {actions.data?.length > 0 && <CorporateActions rows={actions.data} />}

      {groups.map((g) => (
        <CompanyFundamentals key={g.isin} group={g} />
      ))}
    </div>
  )
}

function CorporateActions({ rows }) {
  const confirm = useConfirmCorporateActions()
  const ids = rows.map((r) => r.id)

  return (
    <section className="rounded-xl border border-amber-300 dark:border-amber-900">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950/40">
        <div>
          <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            {rows.length} corporate action{rows.length > 1 ? 's' : ''} to confirm
          </h2>
          <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">
            Until confirmed, share counts and adjusted prices for these companies are
            understated.
          </p>
        </div>
        <button
          onClick={() => confirm.mutate(ids)}
          disabled={confirm.isPending}
          className="rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-amber-200 dark:text-amber-950"
        >
          {confirm.isPending ? 'Confirming…' : `Confirm all ${rows.length}`}
        </button>
      </header>

      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {rows.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{a.company_name}</div>
              <div className="mt-0.5 text-xs text-slate-500 tnum dark:text-slate-400">
                {a.action_type} {num(a.ratio_from, 0)}:{num(a.ratio_to, 0)} · ex {a.ex_date}
                {a.affects_a_position && (
                  <span className="ml-2 font-semibold text-amber-700 dark:text-amber-300">
                    affects a position
                  </span>
                )}
              </div>
            </div>
            <span className="rounded bg-slate-100 px-2 py-1 text-xs tnum dark:bg-slate-800">
              scales ×{num(a.would_apply_factor, 2)}
            </span>
            <button
              onClick={() => confirm.mutate([a.id])}
              disabled={confirm.isPending}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Confirm
            </button>
          </li>
        ))}
      </ul>
      {confirm.isError && (
        <p className="px-4 py-2 text-xs text-rose-600">{confirm.error.message}</p>
      )}
    </section>
  )
}

/** Flags worth a second look. Not blockers — hints about where to actually look. */
function anomalies(r) {
  const out = []
  if (r.revenue == null) out.push('no revenue')
  if (r.pat == null) out.push('no profit figure')
  if (r.eps == null) out.push('no EPS')
  if (r.eps != null && Number(r.eps) < 0) out.push('loss')
  if (r._prev?.revenue && r.revenue) {
    const chg = ((Number(r.revenue) - Number(r._prev.revenue)) / Math.abs(Number(r._prev.revenue))) * 100
    if (Math.abs(chg) >= 50) out.push(`revenue ${chg > 0 ? '+' : ''}${chg.toFixed(0)}% QoQ`)
  }
  return out
}

function qoq(r, field) {
  if (!r._prev || r[field] == null || r._prev[field] == null) return null
  const prev = Number(r._prev[field])
  if (!prev) return null
  return ((Number(r[field]) - prev) / Math.abs(prev)) * 100
}

function CompanyFundamentals({ group }) {
  const [open, setOpen] = useState(false)
  const confirm = useConfirmFundamentals()
  const ids = group.rows.map((r) => r.id)
  const flagged = group.rows.filter((r) => anomalies(r).length > 0).length

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-800">
      <header className="flex flex-wrap items-center gap-3 px-4 py-3">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="text-slate-400">{open ? '▾' : '▸'}</span>
          <span className="min-w-0">
            <span className="text-sm font-medium">{group.name}</span>
            <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
              {group.rows.length} quarter{group.rows.length > 1 ? 's' : ''} to review
              {flagged > 0 && (
                <span className="ml-1 text-amber-700 dark:text-amber-400">
                  · {flagged} flagged
                </span>
              )}
            </span>
          </span>
        </button>
        <button
          onClick={() => confirm.mutate(ids)}
          disabled={confirm.isPending}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {confirm.isPending ? 'Confirming…' : 'Confirm all'}
        </button>
      </header>

      {open && (
        <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 font-medium">Quarter</th>
                <th className="px-3 py-2 font-medium">Basis</th>
                <th className="px-3 py-2 text-right font-medium">Revenue</th>
                <th className="px-3 py-2 text-right font-medium">PAT</th>
                <th className="px-3 py-2 text-right font-medium">EPS</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {group.rows.map((r) => {
                const flags = anomalies(r)
                const revChg = qoq(r, 'revenue')
                return (
                  <tr key={r.id} className={flags.length ? 'bg-amber-50/50 dark:bg-amber-950/20' : ''}>
                    <td className="px-4 py-2 tnum">{r.period_end}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{r.filing_type}</td>
                    <td className="px-3 py-2 text-right tnum">
                      {crore(r.revenue)}
                      {revChg !== null && (
                        <span className={`ml-1.5 text-xs ${
                          revChg >= 0 ? 'text-emerald-600 dark:text-emerald-400'
                                      : 'text-rose-600 dark:text-rose-400'}`}>
                          {revChg >= 0 ? '+' : ''}{revChg.toFixed(0)}%
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tnum">{crore(r.pat)}</td>
                    <td className="px-3 py-2 text-right tnum">{num(r.eps)}</td>
                    <td className="px-3 py-2">
                      {r.source_url ? (
                        <a
                          href={r.source_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-slate-500 underline hover:text-slate-800 dark:hover:text-slate-200"
                        >
                          XBRL
                        </a>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                      {flags.length > 0 && (
                        <div className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
                          {flags.join(' · ')}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => confirm.mutate([r.id])}
                        disabled={confirm.isPending}
                        className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
                      >
                        Confirm
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {confirm.isError && (
        <p className="px-4 py-2 text-xs text-rose-600">{confirm.error.message}</p>
      )}
    </section>
  )
}
