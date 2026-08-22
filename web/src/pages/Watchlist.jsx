import { useState, useEffect } from 'react'
import {
  useWatchlistDetail, useSecuritySearch, useAddToWatchlist, useSetWatchlistActive,
} from '../lib/queries.js'
import { QueryState } from './Dashboard.jsx'

/**
 * Manage the watchlist — the front door of the product, which until now was
 * locked behind hand-written SQL.
 *
 * The ISIN is never typed. Search resolves against `nse_securities`, refreshed
 * daily from the UDiFF bhavcopy by the EOD job, which is the only source this
 * project treats as authoritative for a current ISIN. That matters more here
 * than anywhere else: ISIN is the primary key of the whole data model, and NSE's
 * filings APIs still report superseded ISINs for two of the five companies
 * already tracked.
 */
export default function Watchlist({ onBack, onOpen }) {
  const detail = useWatchlistDetail()
  const rows = detail.data ?? []
  const active = rows.filter((r) => r.active)
  const inactive = rows.filter((r) => !r.active)

  return (
    <div className="space-y-6">
      <button onClick={onBack} className="text-xs text-slate-500 hover:underline">
        ← back
      </button>

      <div>
        <h1 className="text-xl font-semibold tracking-tight">Watchlist</h1>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Companies tracked by the scheduled jobs. Adding one starts price, filing and
          announcement collection from the next run.
        </p>
      </div>

      <AddCompany existing={new Set(rows.map((r) => r.isin))} />

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
          Tracking ({active.length})
        </h2>
        <QueryState query={detail} empty="Nothing on the watchlist yet.">
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {active.map((r) => (
              <Row key={r.isin} row={r} onOpen={onOpen} />
            ))}
          </ul>
        </QueryState>
      </section>

      {inactive.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
            Not tracking ({inactive.length})
          </h2>
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
            Jobs skip these, but all past prices, filings and thesis entries are kept.
            Re-adding resumes collection.
          </p>
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 opacity-70 dark:divide-slate-800 dark:border-slate-800">
            {inactive.map((r) => (
              <Row key={r.isin} row={r} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function Row({ row, onOpen }) {
  const setActive = useSetWatchlistActive()
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <button
          onClick={() => onOpen(row.isin)}
          className="text-sm font-medium hover:underline"
        >
          {row.company_name}
        </button>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500 dark:text-slate-400">
          <span>{row.symbol_nse}</span>
          <span className="font-mono text-[11px]">{row.isin}</span>
          {row.sector && <span>· {row.sector}</span>}
        </div>
        {/* What the jobs have actually collected. Adding a company does not
            backfill history, so "no prices yet" must be visible rather than
            showing an empty chart on the company page. */}
        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-slate-500 dark:text-slate-500 tnum">
          <span className={row.price_days ? '' : 'text-amber-700 dark:text-amber-400'}>
            {row.price_days ? `${row.price_days} days of prices` : 'no prices yet'}
          </span>
          <span>{row.fundamentals_rows} quarters</span>
          <span>{row.conviction_entries} thesis entries</span>
        </div>
      </div>
      <button
        onClick={() => setActive.mutate({ isin: row.isin, active: !row.active })}
        disabled={setActive.isPending}
        className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        {row.active ? 'Stop tracking' : 'Track again'}
      </button>
    </li>
  )
}

/** Wait for a pause in typing before querying — otherwise every keystroke is a
 *  round trip, and the results flicker through partial prefixes. */
function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function AddCompany({ existing }) {
  const [term, setTerm] = useState('')
  const debounced = useDebounced(term)
  const results = useSecuritySearch(debounced)
  const add = useAddToWatchlist()
  const [added, setAdded] = useState(null)

  const submit = (security) => {
    add.mutate(security, {
      onSuccess: () => {
        setAdded(security)
        setTerm('')
      },
    })
  }

  return (
    <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
          Add a company — search by NSE symbol or name
        </span>
        <input
          value={term}
          onChange={(e) => { setTerm(e.target.value); setAdded(null) }}
          placeholder="e.g. RELIANCE, or Tata"
          className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:focus:border-slate-400"
        />
      </label>

      {added && (
        <p className="mt-2 rounded-lg border border-emerald-300 bg-emerald-50 p-2.5 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          Added <strong>{added.name || added.symbol}</strong>. Prices and filings start
          collecting on the next scheduled run — for history, run the{' '}
          <span className="font-medium">EOD price + index fetch</span> workflow with a
          backfill date range.
        </p>
      )}
      {add.isError && <p className="mt-2 text-xs text-rose-600">{add.error.message}</p>}

      {debounced.trim().length >= 2 && (
        <div className="mt-3">
          {results.isLoading && (
            <p className="text-xs text-slate-500">Searching…</p>
          )}
          {results.isError && (
            <p className="text-xs text-rose-600">{results.error.message}</p>
          )}
          {results.data?.length === 0 && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              No match. The catalogue holds NSE equity shares (series EQ) as of the last
              bhavcopy — ETFs and mutual-fund units are excluded.
            </p>
          )}
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {(results.data ?? []).map((s) => {
              const already = existing.has(s.isin)
              return (
                <li key={s.isin} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">
                      <span className="font-medium">{s.symbol}</span>
                      <span className="ml-2 text-slate-600 dark:text-slate-400">{s.name}</span>
                    </div>
                    <div className="font-mono text-[11px] text-slate-500">{s.isin}</div>
                  </div>
                  <button
                    onClick={() => submit(s)}
                    disabled={already || add.isPending}
                    className="shrink-0 rounded-lg bg-slate-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
                  >
                    {already ? 'On list' : add.isPending ? 'Adding…' : 'Add'}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
