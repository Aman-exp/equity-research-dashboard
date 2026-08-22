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
    // Only recent failures matter — an old resolved one shouldn't nag forever.
    queryFn: from('job_failures', (q) =>
      q.gte('failed_at', new Date(Date.now() - 7 * 86_400_000).toISOString())
       .order('failed_at', { ascending: false })),
  })

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
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
      const { data, error } = await supabase
        .from('price_history')
        .select('isin, date, close')
        .gte('date', since)
        .order('date', { ascending: false })
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

export const usePortfolio = () =>
  useQuery({ queryKey: ['portfolio'], queryFn: from('v_portfolio_summary') })

export const useConcentration = () =>
  useQuery({ queryKey: ['concentration'], queryFn: from('v_concentration') })

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
