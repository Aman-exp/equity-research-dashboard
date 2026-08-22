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

/**
 * Today's date in Asia/Kolkata as YYYY-MM-DD.
 *
 * Needed because Postgres `DEFAULT current_date` evaluates in the SERVER's zone
 * (Supabase runs UTC), so anything written between 00:00 and 05:30 IST would be
 * stamped with the previous calendar day. A research journal that mis-dates
 * late-night entries corrupts the one thing it exists to record.
 */
export const istToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

/**
 * NSE trading days between a date and now, approximated by excluding weekends.
 *
 * Calendar days false-fire the staleness banner after any holiday cluster (last
 * close Wednesday + Thu/Fri holidays + weekend = "5 days old" on Monday morning
 * when nothing is wrong), and an alert that cries wolf is the failure mode this
 * project treats as serious. Public holidays are NOT modelled (that would need a
 * holiday table), so a two-day holiday cluster still inflates the count by two —
 * the banner threshold sits above that so such a cluster cannot trip it alone.
 * Weekends, the case that recurs every single week, are eliminated exactly.
 */
export const tradingDaysSince = (d) => {
  if (!d) return null
  // Anchor both ends at UTC NOON of the IST calendar date. Anchoring at IST
  // midnight instead would put the instant at 18:30 UTC the previous day, so
  // getUTCDay() would report the wrong weekday and count Saturdays as trading
  // days — the exact off-by-one this comment exists to prevent.
  const noonUTC = (iso) => new Date(`${iso}T12:00:00Z`)
  const cursor = noonUTC(d)
  const end = noonUTC(istToday())
  let count = 0
  cursor.setUTCDate(cursor.getUTCDate() + 1)
  while (cursor <= end) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) count += 1
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return count
}
