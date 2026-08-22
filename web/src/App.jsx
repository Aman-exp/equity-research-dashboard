import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase, isConfigured } from './lib/supabase.js'
import Dashboard from './pages/Dashboard.jsx'
import Company from './pages/Company.jsx'
import Login from './pages/Login.jsx'

// Two views, so state routing rather than a router dependency.
// "Prefer small and boring" — add react-router when there is a real need.
export default function App() {
  const [isin, setIsin] = useState(null)
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
    setIsin(null)
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
            onClick={() => setIsin(null)}
            className="text-sm font-semibold tracking-tight hover:opacity-70"
          >
            Equity Research
          </button>
          {isin && (
            <>
              <span className="text-slate-400">/</span>
              <span className="text-sm text-slate-500 dark:text-slate-400">company</span>
            </>
          )}
          <button
            onClick={signOut}
            className="ml-auto text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        {isin ? (
          <Company isin={isin} onBack={() => setIsin(null)} />
        ) : (
          <Dashboard onOpen={setIsin} />
        )}
      </main>
    </div>
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
