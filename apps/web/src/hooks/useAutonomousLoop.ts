import { useEffect, useRef } from 'react'

const LOOP_INTERVAL_MS = 5 * 60 * 1000  // every 5 minutes
const FIRST_RUN_DELAY  = 45 * 1000      // 45 s after mount (let dashboard settle)

/**
 * Wires the autonomous healing loop into the browser session.
 * When the user has the dashboard open, this silently POSTs to
 * /api/autonomous/loop on a 5-minute cadence.
 * The server-side handler is a no-op when autonomous healing is disabled.
 */
export function useAutonomousLoop() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const run = () => {
      fetch('/api/autonomous/loop', { method: 'POST' }).catch(() => { /* silent */ })
    }

    const first = setTimeout(run, FIRST_RUN_DELAY)
    timerRef.current = setInterval(run, LOOP_INTERVAL_MS)

    return () => {
      clearTimeout(first)
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])
}
