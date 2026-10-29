/**
 * Shared notification dispatcher.
 * Reads runtime config and fires Slack / webhook alerts for incidents.
 * Delivery failures are returned; notification-history write failures propagate.
 */
import { readConfig, appendNotifLog } from '@/app/api/settings/config/shared'

export interface NotifyIncidentPayload {
  id:       string
  title:    string
  severity: string
  service:  string
  state:    string
  url?:     string
  detail?:  string   // e.g. which workloads the incident's alerts point at
}

const SEV_EMOJI: Record<string, string> = {
  critical: '🔴',
  high:     '🟠',
  medium:   '🟡',
  low:      '🔵',
}

/** Teams Workflows webhook body: Adaptive Card in attachments, plus plain `text` for text-only flows. */
export function teamsPayload(title: string, detail: string, url?: string) {
  return {
    type: 'message',
    text: `${title}\n${detail}${url ? `\n${url}` : ''}`,
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: title, weight: 'Bolder', wrap: true },
          { type: 'TextBlock', text: detail, wrap: true },
        ],
        ...(url ? { actions: [{ type: 'Action.OpenUrl', title: 'View incident', url }] } : {}),
      },
    }],
  }
}

export interface NotifyDelivery {
  ok: boolean
  channels: string[]
  status: 'delivered' | 'failed' | 'disabled' | 'unconfigured'
}

async function deliver(url: string, body: unknown, channel: string, attempts: { channel: string; attempt: number; ok: boolean; status?: number }[]): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
      attempts.push({ channel, attempt, ok: response.ok, status: response.status })
      if (response.ok) return true
      if (response.status < 500 && response.status !== 429) return false
    } catch {
      attempts.push({ channel, attempt, ok: false })
    }
  }
  return false
}

/** Human label for an event key, e.g. incident.sla_breached -> "Incident sla breached". */
function eventLabel(event: string): string {
  return event.replace(/^incident\./, 'Incident ').replace(/[._]/g, ' ')
}

/**
 * Dispatch an incident notification to all configured channels.
 * Respects per-severity `notify_on` settings and records delivery attempts.
 */
export async function notifyIncident(incident: NotifyIncidentPayload, event = 'incident.created', deliveredChannels: string[] = []): Promise<NotifyDelivery> {
  const channels = [...deliveredChannels]
  const attempts: { channel: string; attempt: number; ok: boolean; status?: number }[] = []
  try {
    const cfg      = readConfig()
    const notifyOn = cfg.notify_on ?? {}
    const sev      = incident.severity

    // Skip if this severity is explicitly disabled
    if ((notifyOn[sev] ?? notifyOn[`${sev}_incidents`]) === false || (event === 'incident.sla_breached' && notifyOn.sla_breaches === false)) {
      appendNotifLog({ ts: new Date().toISOString(), event, incidentId: incident.id, channels: [], summary: 'Notification disabled by severity policy', ok: false, status: 'disabled' })
      return { ok: true, channels: [], status: 'disabled' }
    }

    const routing = cfg.alert_routing?.[sev] ?? cfg.alert_routing?.[`${sev}_incidents`] ?? (sev === 'medium' ? cfg.alert_routing?.warning : undefined)
    const enabled = (channel: string) => cfg.integrations_enabled?.[channel] !== false && (!routing || routing.includes(channel))
    const configured: string[] = []
    const emoji = SEV_EMOJI[sev] ?? '⚪'
    const headerText = `${emoji} VynOps — ${sev.toUpperCase()} ${eventLabel(event)}`
    const bodyText   = `*${incident.title}*${incident.detail ? `\n${incident.detail}` : ''}`

    // ── Slack ────────────────────────────────────────────────
    const slackUrl = cfg.slack_webhook_url || process.env.SLACK_WEBHOOK_URL || ''
    if (enabled('slack') && slackUrl.startsWith('https://hooks.slack.com/')) {
      configured.push('slack')
      if (!channels.includes('slack')) {
      try {
        const ok = await deliver(slackUrl, {
            blocks: [
              { type: 'header', text: { type: 'plain_text', text: headerText } },
              { type: 'section', text: { type: 'mrkdwn', text: bodyText } },
              {
                type: 'section',
                fields: [
                  { type: 'mrkdwn', text: `*Severity*\n${sev.toUpperCase()}` },
                  { type: 'mrkdwn', text: `*Service*\n${incident.service}` },
                  { type: 'mrkdwn', text: `*State*\n${incident.state}` },
                  { type: 'mrkdwn', text: `*Incident ID*\n${incident.id}` },
                  { type: 'mrkdwn', text: `*Platform*\nVynOps` },
                  { type: 'mrkdwn', text: `*Time*\n<!date^${Math.floor(Date.now()/1000)}^{date_short_pretty} at {time}|${new Date().toISOString()}>` },
                ],
              },
              ...(incident.url
                ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '🔍 View in VynOps' }, url: incident.url, style: 'primary' }] }]
                : []),
              { type: 'divider' },
            ],
          }, 'slack', attempts)
        if (ok) channels.push('slack')
      } catch { /* network failure — non-critical */ }
      }
    }

    const teamsUrl = cfg.teams_webhook_url || process.env.TEAMS_WEBHOOK_URL || ''
    if (enabled('teams') && teamsUrl.startsWith('https://')) {
      configured.push('teams')
      if (!channels.includes('teams') && await deliver(teamsUrl, teamsPayload(headerText, `${incident.title}\n${incident.id} | ${incident.service} | ${incident.state}${incident.detail ? `\nAffected: ${incident.detail}` : ''}`, incident.url), 'teams', attempts)) channels.push('teams')
    }

    // ── Generic webhook ──────────────────────────────────────
    const webhookUrl = cfg.alert_webhook_url || process.env.ALERT_WEBHOOK_URL || ''
    if (enabled('webhook') && webhookUrl.startsWith('https://')) {
      configured.push('webhook')
      if (!channels.includes('webhook')) {
      try {
        if (await deliver(webhookUrl, { event, incident }, 'webhook', attempts)) channels.push('webhook')
      } catch { /* non-critical */ }
      }
    }

    // ── Append to notification log ───────────────────────────
    const ok = configured.length > 0 && configured.every(channel => channels.includes(channel))
    const status = ok ? 'delivered' : configured.length ? 'failed' : 'unconfigured'
    appendNotifLog({
      ts:       new Date().toISOString(),
      event,
      incidentId: incident.id,
      channels,
      summary:  `${sev} incident ${incident.id}: ${incident.title}`,
      ok,
      status,
      attempts,
    })
    return { ok, channels, status }
  } catch {
    appendNotifLog({ ts: new Date().toISOString(), event, incidentId: incident.id, channels, summary: 'Incident notification failed', ok: false, status: 'failed', attempts })
    return { ok: false, channels, status: 'failed' }
  }
}

export interface NotifyEscalationPayload {
  incidentId:    string
  incidentTitle: string
  severity:      string
  service:       string
  affected?:     string
  levelDesc:     string
  nextLevel:     number
  contactName:   string
  contactEmail:  string
  contactSlack?: string
  url?:          string
  autoTriggered?: boolean
  slaInfo?:       string
}

/**
 * Send a Slack escalation message tagging the on-call contact.
 * Returns true if Slack delivery succeeded.
 */
export async function notifyEscalation(payload: NotifyEscalationPayload): Promise<boolean> {
  const attempts: { channel: string; attempt: number; ok: boolean; status?: number }[] = []
  try {
    const cfg      = readConfig()
    const slackUrl = cfg.slack_webhook_url || process.env.SLACK_WEBHOOK_URL || ''
    const slackAvailable = slackUrl.startsWith('https://hooks.slack.com/') && cfg.integrations_enabled?.slack !== false
    const sev      = payload.severity
    const routing  = cfg.alert_routing?.[sev] ?? cfg.alert_routing?.[`${sev}_incidents`] ?? (sev === 'medium' ? cfg.alert_routing?.warning : undefined)
    const teamsUrl = cfg.teams_webhook_url || process.env.TEAMS_WEBHOOK_URL || ''
    const teamsAvailable = teamsUrl.startsWith('https://') && cfg.integrations_enabled?.teams !== false && (!routing || routing.includes('teams'))
    if (!slackAvailable && !teamsAvailable) {
      appendNotifLog({ ts: new Date().toISOString(), event: 'incident.escalated', incidentId: payload.incidentId, channels: [], summary: 'Escalation channel unavailable', ok: false, status: 'unconfigured' })
      return false
    }

    const emoji    = SEV_EMOJI[payload.severity] ?? '⚪'
    const mention  = payload.contactSlack && /^@?[UW][A-Z0-9]+$/.test(payload.contactSlack)
      ? `<@${payload.contactSlack.replace(/^@/, '')}>`
      : payload.contactName
    const levelTag = `*L${payload.nextLevel} — ${payload.levelDesc}*`

    let slackOk = false
    if (slackAvailable) slackOk = await deliver(slackUrl, {
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: `${emoji} VynOps Escalation — ${levelTag.replace(/\*/g, '')}` },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${mention} VynOps is escalating incident *${payload.incidentTitle}* to you.\n_Incident ID: ${payload.incidentId} · Service: ${payload.service}_`,
            },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Severity*\n${payload.severity.toUpperCase()}` },
              { type: 'mrkdwn', text: `*Escalation Level*\nL${payload.nextLevel} — ${payload.levelDesc}` },
              { type: 'mrkdwn', text: `*On-Call Contact*\n${payload.contactName}` },
              { type: 'mrkdwn', text: `*Email*\n${payload.contactEmail}` },
              { type: 'mrkdwn', text: `*Platform*\nVynOps` },
              { type: 'mrkdwn', text: `*Time*\n<!date^${Math.floor(Date.now()/1000)}^{date_short_pretty} at {time}|${new Date().toISOString()}>` },
              ...(payload.affected       ? [{ type: 'mrkdwn', text: `*Affected*\n${payload.affected}` }]       : []),
              ...(payload.slaInfo        ? [{ type: 'mrkdwn', text: `*SLA Status*\n${payload.slaInfo}` }]       : []),
              ...(payload.autoTriggered  ? [{ type: 'mrkdwn', text: `*Triggered by*\nVynOps Auto-escalation` }] : []),
            ],
          },
          ...(payload.url
            ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'View in VynOps' }, url: payload.url, style: 'danger' }] }]
            : []),
          { type: 'divider' },
        ],
      }, 'slack', attempts)
    const channelsOk: string[] = slackOk ? ['slack'] : []
    if (teamsAvailable && await deliver(teamsUrl, teamsPayload(
      `VynOps Escalation - L${payload.nextLevel} ${payload.levelDesc}`,
      `${payload.contactName} (${payload.contactEmail}) is asked to act on ${payload.incidentTitle}\n${payload.incidentId} | ${payload.service}${payload.affected ? `\nAffected: ${payload.affected}` : ''}${payload.slaInfo ? `\n${payload.slaInfo}` : ''}`,
      payload.url,
    ), 'teams', attempts)) channelsOk.push('teams')
    const ok = channelsOk.length > 0
    appendNotifLog({
      ts:      new Date().toISOString(),
      event:   'incident.escalated',
      channels: channelsOk,
      summary: `Escalation L${payload.nextLevel} for ${payload.incidentId} → ${payload.contactName}`,
      ok,
      incidentId: payload.incidentId,
      status: ok ? 'delivered' : 'failed',
      attempts,
    })
    return ok
  } catch {
    appendNotifLog({ ts: new Date().toISOString(), event: 'incident.escalated', incidentId: payload.incidentId, channels: [], summary: 'Escalation notification failed', ok: false, status: 'failed', attempts })
    return false
  }
}
