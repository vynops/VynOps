'use client'

import { useState, type FormEvent } from 'react'
import { signOut } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, KeyRound, Loader2 } from 'lucide-react'

export default function ForcePasswordChangePage() {
  const router = useRouter()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (newPassword.length < 8) {
      setError('Choose a password with at least 8 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.')
      return
    }

    setSaving(true)
    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(body.error ?? 'Unable to change password. Check the temporary password and try again.')
        return
      }
      await signOut({ redirect: false })
      router.replace('/login?passwordChanged=1')
    } catch {
      setError('Unable to change password. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-surface-950 px-4 py-10">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl border border-surface-800 bg-surface-900 p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-500/10 text-brand-400">
            <KeyRound className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-white">Set your password</h1>
            <p className="mt-0.5 text-xs text-surface-400">Choose a new password to finish setting up your account.</p>
          </div>
        </div>

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-xs text-surface-300">Temporary password</span>
            <input autoComplete="current-password" type="password" required value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2.5 text-sm text-white outline-none focus:border-brand-500" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs text-surface-300">New password</span>
            <input autoComplete="new-password" type="password" minLength={12} required value={newPassword} onChange={event => setNewPassword(event.target.value)} className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2.5 text-sm text-white outline-none focus:border-brand-500" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs text-surface-300">Confirm new password</span>
            <input autoComplete="new-password" type="password" minLength={12} required value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2.5 text-sm text-white outline-none focus:border-brand-500" />
          </label>
        </div>

        <button type="submit" disabled={saving} className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-600 disabled:opacity-50">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          {saving ? 'Updating password…' : 'Set password'}
        </button>
      </form>
    </main>
  )
}
