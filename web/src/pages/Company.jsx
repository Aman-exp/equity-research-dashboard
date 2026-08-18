import { useState } from 'react'
import {
  useWatchlist, usePrices, useFundamentals, useConvictions, useAddConviction,
} from '../lib/queries.js'
import { inr, num } from '../lib/supabase.js'
import { QueryState } from './Dashboard.jsx'

export default function Company({ isin, onBack }) {
  const watchlist = useWatchlist()
  const prices = usePrices(isin)
  const fundamentals = useFundamentals(isin)
  const convictions = useConvictions(isin)

  const company = watchlist.data?.find((w) => w.isin === isin)?.companies
  const latest = prices.data?.[0]

  return (
    <div className="space-y-6">
      <button onClick={onBack} className="text-xs text-slate-500 hover:underline">
        ← back
      </button>

      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {company?.company_name ?? isin}
        </h1>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          <span className="font-mono">{isin}</span>
          {company?.symbol_nse && <> · {company.symbol_nse}</>}
          {company?.sector && <> · {company.sector}</>}
        </p>
      </div>

      {latest && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Last close (adjusted)
            </div>
            <div className="mt-1 text-lg font-semibold tnum">
              {inr(latest.close_adjusted)}
            </div>
            <div className="mt-0.5 text-xs text-slate-500 tnum">
              raw {inr(latest.close_raw)} · {latest.date}
            </div>
          </div>
          <Sparkline rows={prices.data ?? []} />
        </div>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
          Quarterly fundamentals
        </h2>
        <QueryState
          query={fundamentals}
          empty="Nothing entered yet. The XBRL job stages these automatically once running."
        >
          <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-left text-xs uppercase text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Period</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 text-right font-medium">Revenue</th>
                  <th className="px-3 py-2 text-right font-medium">PAT</th>
                  <th className="px-3 py-2 text-right font-medium">EPS</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {(fundamentals.data ?? []).map((f) => (
                  <tr key={f.id}>
                    <td className="px-3 py-2 tnum">{f.period_end}</td>
                    <td className="px-3 py-2 text-xs">{f.filing_type}</td>
                    <td className="px-3 py-2 text-right tnum">{inr(f.revenue, { notation: 'compact' })}</td>
                    <td className="px-3 py-2 text-right tnum">{inr(f.pat, { notation: 'compact' })}</td>
                    <td className="px-3 py-2 text-right tnum">{num(f.eps)}</td>
                    <td className="px-3 py-2">
                      {f.status === 'unverified' ? (
                        // Never silently include unconfirmed auto-ingested data.
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                          unverified
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">confirmed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </QueryState>
      </section>

      <ConvictionSection isin={isin} query={convictions} price={latest?.close_raw} />
    </div>
  )
}

/** Minimal inline SVG — no chart library for one sparkline. */
function Sparkline({ rows }) {
  const pts = [...rows].reverse().map((r) => Number(r.close_adjusted)).filter(Boolean)
  if (pts.length < 2) {
    return (
      <div className="rounded-xl border border-slate-200 p-4 text-xs text-slate-500 dark:border-slate-800">
        Not enough price history to chart yet.
      </div>
    )
  }
  const min = Math.min(...pts), max = Math.max(...pts)
  const span = max - min || 1
  const d = pts
    .map((p, i) => `${(i / (pts.length - 1)) * 100},${30 - ((p - min) / span) * 28}`)
    .join(' ')
  const up = pts.at(-1) >= pts[0]

  return (
    <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="text-xs text-slate-500 dark:text-slate-400">
        Last {pts.length} sessions (adjusted)
      </div>
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="mt-2 h-12 w-full">
        <polyline
          points={d}
          fill="none"
          strokeWidth="1.2"
          vectorEffect="non-scaling-stroke"
          className={up ? 'stroke-emerald-500' : 'stroke-rose-500'}
        />
      </svg>
    </div>
  )
}

function ConvictionSection({ isin, query, price }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ thesis_text: '', falsifier_text: '', conviction_level: 'medium' })
  const add = useAddConviction()

  const submit = (e) => {
    e.preventDefault()
    add.mutate(
      { isin, ...form, linked_price_at_entry: price ?? null },
      { onSuccess: () => { setForm({ thesis_text: '', falsifier_text: '', conviction_level: 'medium' }); setOpen(false) } },
    )
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-600 dark:text-slate-300">Conviction log</h2>
        <button
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-300"
        >
          {open ? 'Cancel' : 'Add entry'}
        </button>
      </div>

      {open && (
        <form onSubmit={submit} className="mb-3 space-y-3 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          <Field label="Thesis — why own this?">
            <textarea
              required rows={3} value={form.thesis_text}
              onChange={(e) => setForm({ ...form, thesis_text: e.target.value })}
              className="w-full rounded-lg border border-slate-300 bg-transparent p-2 text-sm dark:border-slate-700"
            />
          </Field>
          {/* The falsifier is the point of this log — a thesis you cannot be
              wrong about is not a thesis. */}
          <Field label="Falsifier — what would change your mind?">
            <textarea
              required rows={2} value={form.falsifier_text}
              onChange={(e) => setForm({ ...form, falsifier_text: e.target.value })}
              className="w-full rounded-lg border border-slate-300 bg-transparent p-2 text-sm dark:border-slate-700"
            />
          </Field>
          <Field label="Conviction">
            <div className="flex gap-2">
              {['low', 'medium', 'high'].map((lvl) => (
                <button
                  key={lvl} type="button"
                  onClick={() => setForm({ ...form, conviction_level: lvl })}
                  className={`rounded-lg border px-3 py-1.5 text-xs capitalize ${
                    form.conviction_level === lvl
                      ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                      : 'border-slate-300 dark:border-slate-700'}`}
                >
                  {lvl}
                </button>
              ))}
            </div>
          </Field>
          {price != null && (
            <p className="text-xs text-slate-500">
              Will record price at entry: <span className="tnum">{inr(price)}</span>
            </p>
          )}
          {add.isError && <p className="text-xs text-rose-600">{add.error.message}</p>}
          <button
            type="submit" disabled={add.isPending}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {add.isPending ? 'Saving…' : 'Save entry'}
          </button>
        </form>
      )}

      <QueryState query={query} empty="No thesis recorded for this company yet.">
        <ul className="space-y-2">
          {(query.data ?? []).map((c) => (
            <li key={c.id} className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span className="tnum">{c.entry_date}</span>
                <span className="flex items-center gap-2">
                  {c.linked_price_at_entry && (
                    <span className="tnum">at {inr(c.linked_price_at_entry)}</span>
                  )}
                  <span className="rounded bg-slate-200 px-1.5 py-0.5 capitalize dark:bg-slate-800">
                    {c.conviction_level}
                  </span>
                </span>
              </div>
              <p className="mt-1.5">{c.thesis_text}</p>
              {c.falsifier_text && (
                <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-medium">Falsifier:</span> {c.falsifier_text}
                </p>
              )}
            </li>
          ))}
        </ul>
      </QueryState>
    </section>
  )
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">{label}</span>
      {children}
    </label>
  )
}
