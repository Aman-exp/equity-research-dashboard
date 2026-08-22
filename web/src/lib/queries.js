import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from './supabase.js'

/** Every read goes through a view or table protected by RLS + security_invoker. */
const from = (table, build = (q) => q) => async () => {
  const q = build(supabase.from(table).select('*'))
  const { data, error } = await q
  if (error) throw new Error(`${table}: ${error.message}`)
  return data
}

export const useFreshness = () =>
  useQuery({ queryKey: ['freshness'], queryFn: from('v_data_freshness') })

export const useJobFailures = () =>
  useQuery({
    queryKey: ['job_failures'],
    // Recent AND unacknowledged. An alert you cannot clear — for something you
    // cannot fix — teaches you to ignore the banner, which is the only alerting
    // this project has.
    queryFn: from('job_failures', (q) =>
      q.gte('failed_at', new Date(Date.now() - 7 * 86_400_000).toISOString())
       .is('acknowledged_at', null)
       .order('failed_at', { ascending: false })),
  })

export const useAcknowledgeFailures = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (ids) => {
      // Acknowledge, never delete — the row stays as history, it just stops
      // shouting.
      const { error } = await supabase
        .from('job_failures')
        .update({ acknowledged_at: new Date().toISOString() })
        .in('id', ids)
      if (error) throw new Error(error.message)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['job_failures'] }),
  })
}

// ---------------------------------------------------------------------------
// Watchlist management.
//
// Adding a company needs its ISIN, and the project's hardest rule is that ISINs
// come from the bhavcopy — never a filings API, which reports the ISIN as of
// filing time and goes stale. The browser cannot enforce that itself (the
// bhavcopy is a zipped CSV on a host with no CORS headers), so the EOD job
// maintains `nse_securities` from it daily and the UI searches that. The ISIN
// written here is therefore authoritative by construction, and the user never
// types one.
// ---------------------------------------------------------------------------

export const useWatchlistDetail = () =>
  useQuery({ queryKey: ['watchlist_detail'], queryFn: from('v_watchlist_detail') })

/**
 * Search the equity catalogue by symbol or name.
 *
 * Two plain .ilike() queries merged here, rather than one .or() filter string.
 * PostgREST's or= syntax parses the filter out of a comma-separated string, so
 * wildcards and punctuation inside a user-typed term change its meaning, and the
 * failure mode is a silently empty result rather than an error. Two unambiguous
 * single-column queries cost one extra round trip against a 2,285-row table and
 * cannot be broken by whatever the user types.
 */
export const useSecuritySearch = (term) => {
  const q = (term ?? '').trim()
  return useQuery({
    queryKey: ['security_search', q],
    enabled: q.length >= 2,
    queryFn: async () => {
      const cols = 'isin, symbol, name, last_seen'
      const [bySymbol, byName] = await Promise.all([
        supabase.from('nse_securities').select(cols)
          .ilike('symbol', `${q}%`).order('symbol').limit(15),
        supabase.from('nse_securities').select(cols)
          .ilike('name', `%${q}%`).order('symbol').limit(15),
      ])
      if (bySymbol.error) throw new Error(bySymbol.error.message)
      if (byName.error) throw new Error(byName.error.message)

      // Symbol matches first — typing "TATA" should surface TATACHEM before a
      // company that merely mentions Tata in its name.
      const seen = new Set()
      const merged = []
      for (const r of [...(bySymbol.data ?? []), ...(byName.data ?? [])]) {
        if (seen.has(r.isin)) continue
        seen.add(r.isin)
        merged.push(r)
      }
      return merged.slice(0, 15)
    },
  })
}

export const useAddToWatchlist = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (security) => {
      // ignoreDuplicates: a company already known (perhaps removed from the
      // watchlist earlier, with sector and notes curated by hand) must not have
      // that overwritten by the bhavcopy's terse uppercase name.
      const { error: cErr } = await supabase
        .from('companies')
        .upsert(
          {
            isin: security.isin,
            symbol_nse: security.symbol,
            company_name: security.name || security.symbol,
          },
          { onConflict: 'isin', ignoreDuplicates: true },
        )
      if (cErr) throw new Error(`companies: ${cErr.message}`)

      // This one DOES overwrite, so re-adding a previously removed company
      // reactivates it rather than failing on the primary key.
      const { error: wErr } = await supabase
        .from('watchlist')
        .upsert({ isin: security.isin, active: true }, { onConflict: 'isin' })
      if (wErr) throw new Error(`watchlist: ${wErr.message}`)
    },
    onSuccess: () => qc.invalidateQueries(),
  })
}

/**
 * Deactivate rather than delete. price_history, fundamentals and any conviction
 * entries reference the company, and dropping the row would either fail on the
 * foreign key or discard research. `active = false` stops the jobs fetching it
 * while every past record survives — and re-adding later resumes it intact.
 */
export const useSetWatchlistActive = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ isin, active }) => {
      const { error } = await supabase.from('watchlist').update({ active }).eq('isin', isin)
      if (error) throw new Error(error.message)
    },
    onSuccess: () => qc.invalidateQueries(),
  })
}

// ---------------------------------------------------------------------------
// Task queue — "what should I look at today".
//
// Populated by the announcement-feed job. This is the only part of the app that
// changes on an ordinary weekday, so it is the reason to open the dashboard at
// all; everything else moves quarterly.
// ---------------------------------------------------------------------------

export const useTaskQueue = () =>
  useQuery({ queryKey: ['task_queue'], queryFn: from('v_task_queue') })

/**
 * Clear an item. 'processed' means acted on; 'dismissed' means consciously
 * skipped — deliberately different claims, because a queue you can only empty
 * by pretending you did the work is a queue you learn to ignore. The DB trigger
 * stamps processed_at either way.
 */
export const useUpdateTask = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ ids, status }) => {
      const { error } = await supabase
        .from('filings_queue')
        .update({ status })
        .in('id', ids)
      if (error) throw new Error(error.message)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['task_queue'] }),
  })
}

export const usePendingActions = () =>
  useQuery({
    queryKey: ['pending_actions'],
    queryFn: from('v_pending_corporate_actions'),
  })

export const useWatchlist = () =>
  useQuery({
    queryKey: ['watchlist'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('watchlist')
        .select('isin, added_date, active, companies(company_name, symbol_nse, sector, sector_template)')
        .eq('active', true)
      if (error) throw new Error(error.message)
      return data
    },
  })

export const useLatestPrices = () =>
  useQuery({
    queryKey: ['latest_prices'],
    queryFn: async () => {
      // price_history has no "latest" flag; pull a recent window and reduce.
      // 10 days is enough to find a prior close across a long weekend or holiday
      // cluster, and keeps this well clear of PostgREST's 1000-row default cap
      // (which truncates SILENTLY — oldest rows drop first, so a company would
      // lose its `prev` and show "—" for 1d with no error).
      const since = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10)
      const { data, error } = await supabase
        .from('price_history')
        .select('isin, date, close')
        .gte('date', since)
        .order('date', { ascending: false })
        .limit(1000)
      if (error) throw new Error(error.message)
      const latest = {}
      for (const row of data) {
        // rows are date-desc, so first seen per isin is the newest; second is prior close
        if (!latest[row.isin]) latest[row.isin] = { ...row }
        else if (latest[row.isin].prev === undefined) latest[row.isin].prev = row.close
      }
      return latest
    },
  })

/**
 * Latest NIFTY 50 close + prior close. The index is fetched by the same EOD job
 * as prices but was never displayed — without it, "the market was down today" is
 * indistinguishable from "my watchlist was down today".
 */
export const useIndexLatest = (indexName = 'NIFTY 50') =>
  useQuery({
    queryKey: ['index_latest', indexName],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('index_history')
        .select('index_name, date, close')
        .eq('index_name', indexName)
        .order('date', { ascending: false })
        .limit(2)
      if (error) throw new Error(error.message)
      const [latest, prev] = data ?? []
      return latest ? { ...latest, prev: prev?.close ?? null } : null
    },
  })

/**
 * Current TTM P/E per company.
 *
 * v_pe_current emits ONE ROW PER filing_type, so a company reporting both bases
 * yields two materially different P/Es (live example: SUNPHARMA consolidated
 * 37.7 vs standalone 153.4). The spec settled on consolidated-where-available
 * (build spec §14), so that convention is applied here rather than letting the
 * UI show whichever row happened to arrive first.
 */
export const usePE = () =>
  useQuery({
    queryKey: ['pe_current'],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_pe_current').select('*')
      if (error) throw new Error(`v_pe_current: ${error.message}`)
      const byIsin = {}
      for (const row of data ?? []) {
        const held = byIsin[row.isin]
        if (!held || (held.filing_type !== 'consolidated' && row.filing_type === 'consolidated')) {
          byIsin[row.isin] = row
        }
      }
      return byIsin
    },
  })

export const usePortfolio = () =>
  useQuery({ queryKey: ['portfolio'], queryFn: from('v_portfolio_summary') })

// NOTE: v_concentration exists in the DB but has no consumer while there are no
// holdings — a hook here would be dead code on both tiers. Add it back alongside
// the portfolio section when the first real position exists.

export const useConvictions = (isin) =>
  useQuery({
    queryKey: ['convictions', isin ?? 'all'],
    queryFn: from('conviction_log', (q) => {
      const base = q.order('entry_date', { ascending: false })
      return isin ? base.eq('isin', isin) : base
    }),
  })

export const useFundamentals = (isin) =>
  useQuery({
    queryKey: ['fundamentals', isin],
    enabled: Boolean(isin),
    queryFn: from('fundamentals_quarterly', (q) =>
      q.eq('isin', isin).order('period_end', { ascending: false })),
  })

export const usePrices = (isin) =>
  useQuery({
    queryKey: ['prices', isin],
    enabled: Boolean(isin),
    // Adjusted, not raw: split/bonus-adjusted is the only comparable series.
    queryFn: from('v_price_adjusted', (q) =>
      q.eq('isin', isin).order('date', { ascending: false }).limit(120)),
  })

/**
 * Split/bonus-adjusted closes for a specific set of dates.
 *
 * Used to compute "how has this thesis done since I wrote it". conviction_log
 * stores the RAW close at entry (an immutable record of the screen the user was
 * looking at), but comparing a pre-split raw price against a post-split current
 * price would report a fake collapse. Both sides of the comparison therefore come
 * from v_price_adjusted instead.
 */
export const useAdjustedCloseAt = (isin, dates) => {
  const key = [...new Set(dates ?? [])].sort()
  return useQuery({
    queryKey: ['adj_close_at', isin, key.join(',')],
    enabled: Boolean(isin) && key.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_price_adjusted')
        .select('date, close_adjusted')
        .eq('isin', isin)
        .in('date', key)
      if (error) throw new Error(error.message)
      return Object.fromEntries((data ?? []).map((r) => [r.date, r.close_adjusted]))
    },
  })
}

export const useAddConviction = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (entry) => {
      const { error } = await supabase.from('conviction_log').insert(entry)
      if (error) throw new Error(error.message)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['convictions'] }),
  })
}

// ---------------------------------------------------------------------------
// Review inbox
//
// Auto-ingested rows land as `unverified` and are deliberately inert until
// confirmed: adj_factor() ignores unverified corporate actions, and the UI flags
// unverified fundamentals. Confirming is the one action that makes staged data
// count, so it belongs in the app rather than in raw SQL.
// ---------------------------------------------------------------------------

/** Every fundamentals row, so the inbox can show quarter-on-quarter context. */
export const useAllFundamentals = () =>
  useQuery({
    queryKey: ['all_fundamentals'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fundamentals_quarterly')
        .select('*, companies(company_name, symbol_nse)')
        .order('period_end', { ascending: false })
      if (error) throw new Error(error.message)
      return data
    },
  })

const confirmRows = (table) => async (ids) => {
  const { error } = await supabase
    .from(table)
    .update({ status: 'confirmed' })
    .in('id', ids)
  if (error) throw new Error(error.message)
}

export const useConfirmFundamentals = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: confirmRows('fundamentals_quarterly'),
    // Confirming changes TTM EPS and therefore P/E, so refresh broadly rather
    // than only the inbox.
    onSuccess: () => qc.invalidateQueries(),
  })
}

export const useConfirmCorporateActions = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: confirmRows('corporate_actions'),
    // A confirmed split/bonus rescales quantities AND adjusted prices, so every
    // derived number on the dashboard can move.
    onSuccess: () => qc.invalidateQueries(),
  })
}
