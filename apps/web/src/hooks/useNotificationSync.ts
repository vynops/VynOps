'use client'

/**
 * Polls /api/incidents every 30s and syncs alerts + incidents into the global
 * Zustand store so that TopHeader's notification bell badge and dropdown
 * always reflect live data regardless of which page is active.
 */

import { useEffect, useRef } from 'react'
import { useDashboardStore } from '@/store'
import type { Alert, Incident, Severity } from '@/types'

const POLL_MS = 30_000

export function useNotificationSync() {
  const setAlerts    = useDashboardStore(s => s.setAlerts)
  const setIncidents = useDashboardStore(s => s.setIncidents)
  const activeCluster = useDashboardStore(s => s.activeCluster)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      if (cancelled) return
      try {
        const headers: Record<string, string> = {}
        if (activeCluster) {
          headers['X-K8s-Url']          = activeCluster.k8sUrl          || 'none'
          headers['X-Prom-Url']         = activeCluster.promUrl         || 'none'
          headers['X-Alertmanager-Url'] = activeCluster.alertmanagerUrl || 'none'
          headers['X-Loki-Url']         = activeCluster.lokiUrl         || 'none'
          headers['X-Jaeger-Url']       = activeCluster.jaegerUrl       || 'none'
          headers['X-Grafana-Url']      = activeCluster.grafanaUrl      || 'none'
        }

        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 10_000)
        let data: any = null
        try {
          const res = await fetch('/api/incidents', { headers, signal: controller.signal })
          clearTimeout(timeoutId)
          if (!res.ok || cancelled) return
          data = await res.json()
        } catch {
          clearTimeout(timeoutId)
          // Network/abort errors are silent — badge just won't update until next poll
        }

        if (!data || cancelled) return

        // Map IncidentDoc → Alert[] (firing alerts surfaced via incidents)
        const alerts: Alert[] = (data.incidents ?? [])
          .filter((inc: any) => inc.state !== 'resolved')
          .flatMap((inc: any) =>
            (inc.alerts ?? []).map((a: any) => ({
              id:               a.id ?? `${inc.id}-alert`,
              name:             a.name ?? inc.title,
              severity:         (a.severity ?? inc.severity ?? 'medium') as Severity,
              state:            'firing' as const,
              summary:          a.summary ?? inc.description ?? '',
              description:      a.description ?? '',
              labels:           a.labels ?? {},
              annotations:      a.annotations ?? {},
              startsAt:         a.startsAt ?? inc.createdAt,
              source:           a.source ?? 'prometheus',
              affectedServices: inc.affectedServices ?? [inc.service],
            }))
          )

        // Deduplicate alerts by id
        const seen = new Set<string>()
        const dedupedAlerts = alerts.filter(a => {
          if (seen.has(a.id)) return false
          seen.add(a.id)
          return true
        })

        // Map IncidentDoc → Incident[] for the store
        const incidents: Incident[] = (data.incidents ?? []).map((inc: any) => ({
          id:                 inc.id,
          title:              inc.title,
          description:        inc.description ?? '',
          severity:           inc.severity,
          state:              inc.state,
          owner:              inc.owner ?? '',
          team:               inc.team ?? '',
          service:            inc.service ?? '',
          environment:        inc.environment ?? 'production',
          labels:             inc.labels ?? {},
          createdAt:          inc.createdAt,
          updatedAt:          inc.updatedAt ?? inc.createdAt,
          resolvedAt:         inc.resolvedAt,
          slaDeadline:        inc.slaDeadline,
          slaBreached:        inc.slaBreached ?? false,
          alerts:             dedupedAlerts.filter(a => a.incidentId === inc.id || (inc.alerts ?? []).some((ia: any) => ia.id === a.id)),
          timeline:           inc.timeline ?? [],
          blastRadius:        inc.blastRadius ?? { affectedServices: [inc.service], affectedUsers: 0, affectedRegions: [], slaBreached: inc.slaBreached ?? false, dependentServices: [] },
          runbookUrl:         inc.runbookUrl,
          affectedServices:   inc.affectedServices,
        }))

        if (!cancelled) {
          setAlerts(dedupedAlerts)
          setIncidents(incidents)
        }
      } catch {
        // outer catch — safety net for unexpected errors
      }

      if (!cancelled) {
        timerRef.current = setTimeout(poll, POLL_MS)
      }
    }

    poll()

    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  // Re-run when cluster changes so headers are fresh
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCluster?.id])
}
