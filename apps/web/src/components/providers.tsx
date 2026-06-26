'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionProvider } from 'next-auth/react'
import { useState, useEffect } from 'react'

// One-time migration: copy localStorage keys from old brand names to new ones.
// Safe to remove after 2027 once all users have loaded the app at least once.
const LS_MIGRATIONS: [string, string][] = [
  ['aegisops-net-thresholds',    'vynops-net-thresholds'],
  ['aegisops-event-suppressions','vynops-event-suppressions'],
  ['aegisops-webhook-url',       'vynops-webhook-url'],
  ['aegisops-auto-esc',          'vynops-auto-esc'],
  ['mavops_conversations_v2',    'vynops_conversations_v2'],
  ['mavops_custom_runbooks',     'vynops_custom_runbooks'],
]

function migrateLocalStorage() {
  if (typeof window === 'undefined') return
  for (const [oldKey, newKey] of LS_MIGRATIONS) {
    const val = localStorage.getItem(oldKey)
    if (val !== null && localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, val)
      localStorage.removeItem(oldKey)
    }
  }
}

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => { migrateLocalStorage() }, [])

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            retry: 2,
            refetchOnWindowFocus: false,
          },
        },
      }),
  )

  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </SessionProvider>
  )
}
