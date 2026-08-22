import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase, isConfigured } from './lib/supabase.js'
import { useFreshness, usePendingActions } from './lib/queries.js'
import Dashboard from './pages/Dashboard.jsx'
import Company from './pages/Company.jsx'
import Review from './pages/Review.jsx'
import Login from './pages/Login.jsx'

// Three views, so state routing rather than a router dependency.
// "Prefer small and boring" — add react-router when there is a real need.
export default function App() {
  const [route, setRoute] = useState({ name: 'dashboard' })
  // undefined = still checking localStorage for a saved session; null = signed out.
  // The distinction avoids a login-page flash on every reload for a signed-in user.
  const [session, setSession] = useState(undefined)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!isConfigured) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s ?? null)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const signOut = async () => {
    await supabase.auth.signOut()
    // Drop everything cached in memory — prices, fundamentals, theses — so
    // nothing lingers after sign-out on a shared machine.
    queryClient.clear()
    setRoute({ name: 'dashboard' })
  }

  if (!isConfigured) return <SetupNeeded />
  if (session === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-slate-400">Loading…</p>
      </div>
    )
  }
  if (!session) return <Login />

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 dark:border-slate-800">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <button
            onClick={() => setRoute({ name: 'dashboard' })}
            className="text-sm font-semibold tracking-tight hover:opacity-70"
          >
            Equity Research
          </button>

          <nav className="ml-auto flex items-center gap-4">
            <ReviewLink route={route} setRoute={setRoute} />
            <button
              onClick={signOut}
              className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        {route.name === 'company' ? (
          <Company isin={route.isin} onBack={() => setRoute({ name: 'dashboard' })} />
        ) : route.name === 'review' ? (
          <Review />
        ) : (
          <Dashboard
            onOpen={(isin) => setRoute({ name: 'company', isin })}
            onReview={() => setRoute({ name: 'review' })}
          />
        )}
      </main>
    </div>
  )
}

/** Pending-item counter, per the requirements doc's "badge for pending items". */
function ReviewLink({ route, setRoute }) {
  const freshness = useFreshness()
  const actions = usePendingActions()
  const pending =
    Number(freshness.data?.[0]?.unverified_rows ?? 0) + (actions.data?.length ?? 0)

  return (
    <button
      onClick={() => setRoute({ name: 'review' })}
      className={`flex items-center gap-1.5 text-xs ${
        route.name === 'review'
          ? 'font-medium text-slate-900 dark:text-slate-100'
          : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
      }`}
    >
      Review
      {pending > 0 && (
        <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-white tnum">
          {pending}
        </span>
      )}
    </button>
  )
}

function SetupNeeded() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-lg font-semibold">Supabase is not configured</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
        Create <code className="rounded bg-slate-200 px-1 dark:bg-slate-800">web/.env.local</code> with
        your project URL and <strong>publishable</strong> key:
      </p>
      <pre className="mt-4 overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
{`VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable / anon key>`}
      </pre>
      <p className="mt-4 text-sm text-slate-600 dark:text-slate-400">
        Use the <strong>publishable/anon</strong> key only. Secret keys bypass RLS and
        must never appear in frontend code.
      </p>
    </div>
  )
}
