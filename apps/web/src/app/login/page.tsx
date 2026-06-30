'use client'

import { useState, type FormEvent } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Loader2, Shield, AlertCircle } from 'lucide-react'
import { Suspense } from 'react'

const DEMO_CREDS = [
  { label: 'Admin', email: 'admin@VynOps.io', password: 'admin123', color: 'border-brand-500/40 bg-brand-500/10 hover:bg-brand-500/20 text-brand-300', badge: 'Full Access' },
  { label: 'Operator', email: 'operator@VynOps.io', password: 'operator123', color: 'border-warning-500/40 bg-warning-500/10 hover:bg-warning-500/20 text-warning-300', badge: 'SRE Access' },
  { label: 'Viewer', email: 'viewer@VynOps.io', password: 'viewer123', color: 'border-surface-600 bg-surface-800/60 hover:bg-surface-700 text-surface-300', badge: 'Read Only' },
]

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const callbackUrl = searchParams.get('callbackUrl') ?? '/dashboard'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await signIn('credentials', {
        email,
        password,
        redirect: false,
      })

      if (res?.error) {
        setError('Invalid email or password. Try a demo account below.')
      } else {
        router.push(callbackUrl)
        router.refresh()
      }
    } finally {
      setLoading(false)
    }
  }

  const fillDemo = (cred: (typeof DEMO_CREDS)[0]) => {
    setEmail(cred.email)
    setPassword(cred.password)
    setError('')
  }

  return (
    <div className="min-h-screen bg-surface-950 flex items-center justify-center p-4">
      {/* Background gradient blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/3 w-96 h-96 rounded-full bg-brand-500/5 blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-80 h-80 rounded-full bg-purple-500/5 blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8 gap-3">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-brand-500 to-blue-600 flex items-center justify-center shadow-lg shadow-brand-500/25">
            <Shield className="w-7 h-7 text-white" />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold text-white tracking-tight">
              Vyn<span className="text-brand-400">Ops</span>
            </h1>
            <p className="text-sm text-surface-400 mt-1">
              Autonomous Kubernetes Operations Platform
            </p>
          </div>
        </div>

        {/* Card */}
        <div className="glass-card p-8 space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-white">Sign in</h2>
            <p className="text-sm text-surface-400 mt-1">
              Access your infrastructure dashboard
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-danger-500/10 border border-danger-500/20 text-danger-400 text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-surface-300 uppercase tracking-wider">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@VynOps.io"
                required
                className="w-full px-3 py-2.5 rounded-lg bg-surface-800 border border-surface-700 text-white placeholder-surface-500 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500/60 transition-all"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-surface-300 uppercase tracking-wider">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="w-full px-3 py-2.5 rounded-lg bg-surface-800 border border-surface-700 text-white placeholder-surface-500 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500/60 transition-all"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg bg-brand-500 hover:bg-brand-400 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm transition-colors flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Signing in…
                </>
              ) : (
                'Sign in'
              )}
            </button>
          </form>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-surface-700" />
            <span className="text-xs text-surface-500">Demo accounts</span>
            <div className="flex-1 h-px bg-surface-700" />
          </div>

          {/* Demo credential chips */}
          <div className="grid grid-cols-3 gap-2">
            {DEMO_CREDS.map((cred) => (
              <button
                key={cred.label}
                type="button"
                onClick={() => fillDemo(cred)}
                className={`flex flex-col items-center gap-1 p-3 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${cred.color}`}
              >
                <span className="font-semibold">{cred.label}</span>
                <span className="opacity-70 font-normal">{cred.badge}</span>
              </button>
            ))}
          </div>

          <p className="text-center text-xs text-surface-500">
            Click a demo account to autofill credentials
          </p>
        </div>

        {/* Family footer */}
        <div className="mt-8 flex flex-col items-center gap-3">
          <p className="text-xs text-surface-600 tracking-widest uppercase">Part of the VynOps Suite</p>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-brand-500/20 text-brand-300 border border-brand-500/30">VynOps</span>
            <a href="http://localhost:3010" className="px-2.5 py-1 rounded-full text-xs font-medium text-surface-500 border border-surface-700 hover:text-surface-300 hover:border-surface-500 transition-colors">VynAI</a>
            <a href="http://localhost:3020" className="px-2.5 py-1 rounded-full text-xs font-medium text-surface-500 border border-surface-700 hover:text-surface-300 hover:border-surface-500 transition-colors">VynCost</a>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}
