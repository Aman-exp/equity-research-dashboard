import { createClient } from '@supabase/supabase-js'

// ANON key only. The service_role key must NEVER appear in frontend code — it
// bypasses RLS entirely. Anything here ships publicly in the built bundle.
// Protection comes from RLS on every table, plus security_invoker on every view
// (without which a view would leak RLS-protected data to this very key).
const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isConfigured = Boolean(url && anonKey)

export const supabase = isConfigured ? createClient(url, anonKey) : null

/** ₹ formatting, Indian digit grouping (lakh/crore). */
export const inr = (n, opts = {}) =>
  n === null || n === undefined || Number.isNaN(Number(n))
    ? '—'
    : new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 2,
        ...opts,
      }).format(Number(n))

/**
 * Rupees in crore — how Indian financial statements are actually read.
 * Raw XBRL values are absolute rupees (₹1,331,103,600,000), which is unreadable
 * at a glance; ₹1,33,110 Cr is not.
 */
export const crore = (n) => {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—'
  const cr = Number(n) / 1e7
  return `₹${new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.abs(cr) < 100 ? 1 : 0,
  }).format(cr)} Cr`
}

export const num = (n, dp = 2) =>
  n === null || n === undefined || Number.isNaN(Number(n))
    ? '—'
    : new Intl.NumberFormat('en-IN', {
        minimumFractionDigits: dp,
        maximumFractionDigits: dp,
      }).format(Number(n))

/** Dates are timestamptz in the DB; display in Asia/Kolkata. */
export const istDate = (d) =>
  !d
    ? '—'
    : new Date(d).toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })

/** Whole days between a date and today, for the freshness indicator. */
export const daysSince = (d) => {
  if (!d) return null
  const then = new Date(`${d}T00:00:00+05:30`)
  const now = new Date()
  return Math.floor((now - then) / 86_400_000)
}
