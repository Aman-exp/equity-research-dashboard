import { useState } from 'react'
import { supabase } from '../lib/supabase.js'

/**
 * Single-user sign-in. Deliberately no sign-up link, no OAuth buttons, no
 * "forgot password" flow — sign-ups are disabled server-side (any authenticated
 * user would get full access under the blanket RLS policy, so account creation
 * happens only in the Supabase dashboard). Password reset likewise happens in
 * the dashboard; a self-serve reset flow is attack surface with one user.
 */
export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const friendly = (message) => {
    const m = (message || '').toLowerCase()
    if (m.includes('invalid login credentials')) return 'Wrong email or password.'
    if (m.includes('email not confirmed'))
      return 'This account was created without auto-confirm. In Supabase: Authentication → Users → confirm the user.'
    if (m.includes('rate limit') || m.includes('too many'))
      return 'Too many attempts — wait a minute and try again.'
    if (m.includes('failed to fetch') || m.includes('network'))
      return 'Could not reach the server. Check your connection and try again.'
    return message || 'Sign-in failed.'
  }

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error: err } = await supabase.auth.signInWithPassword({ email, password })
    // On success the onAuthStateChange listener in App.jsx swaps in the
    // dashboard — nothing to do here.
    if (err) {
      setError(friendly(err.message))
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-xl font-semibold tracking-tight">Equity Research</h1>
        <p className="mt-1 text-center text-xs text-slate-500 dark:text-slate-400">
          Personal dashboard — sign in to continue
        </p>

        <form onSubmit={submit} className="mt-8 space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
              Email
            </span>
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2.5 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:focus:border-slate-400"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
              Password
            </span>
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2.5 pr-16 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:focus:border-slate-400"
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                tabIndex={-1}
                className="absolute inset-y-0 right-0 px-3 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
              >
                {showPw ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>

          {error && (
            <p className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-slate-900 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-slate-400 dark:text-slate-500">
          Single-user app — there is no sign-up. Accounts and password resets are
          managed in the Supabase dashboard.
        </p>
      </div>
    </div>
  )
}
