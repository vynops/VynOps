'use client'

import { useRealtimeStream }    from '@/hooks/useRealtimeStream'
import { useAutonomousLoop } from '@/hooks/useAutonomousLoop'
import { useNotificationSync } from '@/hooks/useNotificationSync'

/**
 * Thin client wrapper that activates the SSE realtime stream,
 * the autonomous healing loop, and the notification sync poller.
 * Must be a client component; mounted inside the dashboard layout.
 */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  useRealtimeStream()
  useAutonomousLoop()
  useNotificationSync()
  return <>{children}</>
}
