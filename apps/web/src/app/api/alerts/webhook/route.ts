/**
 * POST /api/alerts/webhook
 *
 * Alertmanager webhook receiver.
 * Receives Alertmanager v4 webhook payloads and forwards them to Slack as
 * rich Block Kit messages with a "View in VynOps" action button.
 *
 * Add to Alertmanager config:
 *   receivers:
 *   - name: "vynops-slack"
 *     webhook_configs:
 *     - url: "https://ops.vynops.online/api/alerts/webhook"
 *       send_resolved: true
 *       http_config:
 *         tls_config:
 *           insecure_skip_verify: false
 */
import { NextResponse } from 'next/server'
import { readConfig, appendNotifLog } from '@/app/api/settings/config/shared'
import fs from 'fs'
import path from 'path'

const VYNOPS_URL = (process.env.NEXTAUTH_URL ?? 'https://ops.vynops.online').replace(/\/$/, '')

/**
 * Returns the first external Prometheus URL from clusters.json, or null.
 * Used to rewrite internal K8s-DNS generator URLs (e.g.
 * http://svc.namespace:9090) into browser-accessible links.
 */
function getExternalPromUrl(): string | null {
  try {
    const file = path.join(process.cwd(), 'data', 'clusters.json')
    if (!fs.existsSync(file)) return null
    const clusters: { promUrl?: string }[] = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const c of clusters) {
      if (c.promUrl && c.promUrl.startsWith('http')) {
        // Skip loopback/internal URLs — they're useless as rewrite targets
        try {
          const u = new URL(c.promUrl)
          if (!isInternalK8sHost(u.host)) return c.promUrl.replace(/\/$/, '')
        } catch { /* skip malformed */ }
      }
    }
  } catch { /* non-fatal */ }
  return null
}

/**
 * Detects hosts that are unreachable from a browser outside the cluster:
 *   - Kubernetes internal service DNS  (service.namespace[:port])
 *   - Loopback addresses               (127.x.x.x, ::1, localhost)
 *   - Unspecified                       (0.0.0.0)
 */
function isInternalK8sHost(hostname: string): boolean {
  const host = hostname.split(':')[0] ?? ''
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return true
  if (/^127\./.test(host)) return true
  if (host.endsWith('.svc.cluster.local')) return true
  const parts = host.split('.')
  if (parts.length === 2) return true   // service.namespace
  if (parts.length === 3) return true   // service.namespace.svc
  return false
}

/**
 * Rewrites an internal Prometheus generatorURL to use the external promUrl.
 * Keeps the path + query string intact so the graph expression still works.
 * Returns null if the URL is already external or can't be parsed.
 */
function rewriteGeneratorUrl(genUrl: string, externalPromUrl: string): string | null {
  try {
    const u = new URL(genUrl)
    if (!isInternalK8sHost(u.host)) return null   // already external, use as-is
    const ext = new URL(externalPromUrl)
    u.protocol = ext.protocol
    u.host     = ext.host
    return u.toString()
  } catch {
    return null
  }
}

const SEV_EMOJI: Record<string, string> = {
  critical: '🔴',
  high:     '🟠',
  warning:  '🟡',
  medium:   '🟡',
  low:      '🔵',
  info:     '⚪',
}

interface AmAlert {
  status:      string
  labels:      Record<string, string>
  annotations: Record<string, string>
  startsAt:    string
  endsAt?:     string
  generatorURL?: string
  fingerprint?: string
}

interface AmPayload {
  version:          string
  groupKey:         string
  status:           'firing' | 'resolved'
  receiver:         string
  groupLabels:      Record<string, string>
  commonLabels:     Record<string, string>
  commonAnnotations: Record<string, string>
  externalURL:      string
  alerts:           AmAlert[]
}

function buildSlackBlocks(payload: AmPayload): object[] {
  const isFiring   = payload.status === 'firing'
  const firingList = payload.alerts.filter(a => a.status === 'firing')
  const alerts     = firingList.length > 0 ? firingList : payload.alerts

  const sev   = (payload.commonLabels.severity ?? '').toLowerCase()
  const emoji = isFiring ? (SEV_EMOJI[sev] ?? '⚪') : '✅'
  const ns    = payload.groupLabels.namespace ?? payload.commonLabels.namespace ?? ''

  // ── Header ──────────────────────────────────────────────────────────────
  const alertName = payload.commonLabels.alertname
    ?? (alerts[0]?.labels.alertname ?? 'Alert')
  const headerText = isFiring
    ? `${emoji} [${sev.toUpperCase() || 'ALERT'}] ${alertName}`
    : `✅ [RESOLVED] ${alertName}`

  const blocks: object[] = [
    { type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } },
  ]

  // ── Per-alert detail (max 5 to avoid Slack limits) ───────────────────────
  for (const alert of alerts.slice(0, 5)) {
    const alertSev     = alert.labels.severity ?? sev
    const alertEmoji   = isFiring ? (SEV_EMOJI[alertSev] ?? '⚪') : '✅'
    const summary      = alert.annotations.summary ?? alert.labels.alertname ?? ''
    const description  = alert.annotations.description ?? ''
    const alertNs      = alert.labels.namespace ?? ns

    const lines: string[] = [`${alertEmoji} *${alert.labels.alertname ?? alertName}*`]
    if (summary)     lines.push(summary)
    if (description) lines.push(`_${description}_`)

    const fields: object[] = [
      { type: 'mrkdwn', text: `*Severity*\n${alertSev.toUpperCase() || '—'}` },
      { type: 'mrkdwn', text: `*Namespace*\n${alertNs || 'cluster'}` },
      { type: 'mrkdwn', text: `*Since*\n<!date^${Math.floor(new Date(alert.startsAt).getTime() / 1000)}^{date_short_pretty} at {time}|${alert.startsAt}>` },
    ]

    const runbook = alert.annotations.runbook_url ?? alert.annotations.runbook ?? ''
    if (runbook) {
      fields.push({ type: 'mrkdwn', text: `*Runbook*\n<${runbook}|Open runbook>` })
    }

    blocks.push(
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
      { type: 'section', fields },
    )
  }

  if (alerts.length > 5) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_… and ${alerts.length - 5} more alert(s) in this group_` }],
    })
  }

  // ── Actions: View in VynOps button (+ Prometheus link if available) ─────
  const alertQuery = encodeURIComponent(alertName)
  const actionElements: object[] = [
    {
      type:  'button',
      text:  { type: 'plain_text', text: '🔍 View in VynOps', emoji: true },
      url:   `${VYNOPS_URL}/alerts?name=${alertQuery}`,
      style: 'primary',
    },
  ]

  const genUrl = alerts[0]?.generatorURL
  if (genUrl) {
    const extPromUrl  = getExternalPromUrl()
    const rewritten   = extPromUrl ? rewriteGeneratorUrl(genUrl, extPromUrl) : null
    // Use rewritten URL if internal, raw URL if already external, skip if neither
    const promLinkUrl = rewritten ?? (extPromUrl === null && !isInternalK8sHost(new URL(genUrl).host) ? genUrl : null)
    if (promLinkUrl) {
      actionElements.push({
        type: 'button',
        text: { type: 'plain_text', text: '📈 Prometheus', emoji: true },
        url:  promLinkUrl,
      })
    }
  }

  blocks.push(
    { type: 'actions', elements: actionElements },
    { type: 'divider' },
  )

  return blocks
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const payload: AmPayload = await req.json()

    // Ignore Watchdog heartbeat
    if (payload.commonLabels.alertname === 'Watchdog') {
      return NextResponse.json({ ok: true, skipped: 'watchdog' })
    }

    const cfg      = readConfig()
    const slackUrl = cfg.slack_webhook_url ?? process.env.SLACK_WEBHOOK_URL ?? ''
    if (!slackUrl.startsWith('https://hooks.slack.com/')) {
      return NextResponse.json({ ok: false, error: 'Slack webhook not configured' }, { status: 503 })
    }

    const blocks = buildSlackBlocks(payload)
    const isFiring = payload.status === 'firing'

    const r = await fetch(slackUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ blocks }),
      signal:  AbortSignal.timeout(5000),
    })

    const ok = r.ok
    const alertName = payload.commonLabels.alertname ?? 'unknown'
    const sev       = payload.commonLabels.severity  ?? 'unknown'

    appendNotifLog({
      ts:       new Date().toISOString(),
      event:    isFiring ? 'alert.firing' : 'alert.resolved',
      channels: ok ? ['slack'] : [],
      summary:  `[${sev}] ${alertName} (${payload.alerts.length} alert(s)) — ${payload.status}`,
      ok,
    })

    return NextResponse.json({ ok, alerts: payload.alerts.length })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 400 })
  }
}
