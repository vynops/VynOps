/**
 * Shared notification dispatcher.
 * Reads runtime config and fires Slack / webhook alerts for incidents.
 * Safe to call fire-and-forget (never throws).
 */
import { readConfig, appendNotifLog } from '@/app/api/settings/config/shared'

export interface NotifyIncidentPayload {
  id:       string
  title:    string
  severity: string
  service:  string
  state:    string
  url?:     string
}

const SEV_EMOJI: Record<string, string> = {
  critical: '??',
  high:     '??',
  medium:   '??',
  low:      '??',
}

/**
 * Dispatch an incident notification to all configured channels.
 * Respects per-severity `notify_on` settings. Never throws.
 */
export async function notifyIncident(incident: NotifyIncidentPayload): Promise<void> {
  try {
    const cfg      = readConfig()
    const notifyOn = cfg.notify_on ?? {}
    const sev      = incident.severity

    // Skip if this severity is explicitly disabled
    if (notifyOn[sev] === false) return

    const channels: string[] = []
    const emoji = SEV_EMOJI[sev] ?? '?'
    const text  = `${emoji} *[${sev.toUpperCase()}]* Incident declared: *${incident.title}*\nService: \`${incident.service}\`  |  ID: \`${incident.id}\``

    // ?? Slack ????????????????????????????????????????????????
    const slackUrl = cfg.slack_webhook_url ?? process.env.SLACK_WEBHOOK_URL ?? ''
    if (slackUrl.startsWith('https://hooks.slack.com/')) {
      try {
        const r = await fetch(slackUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text } },
              {
                type: 'section',
                fields: [
                  { type: 'mrkdwn', text: `*Severity*\n${sev}` },
                  { type: 'mrkdwn', text: `*Service*\n${incident.service}` },
                  { type: 'mrkdwn', text: `*State*\n${incident.state}` },
                  { type: 'mrkdwn', text: `*Incident ID*\n${incident.id}` },
                ],
              },
              ...(incident.url
                ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'View Incident' }, url: incident.url }] }]
                : []),
            ],
          }),
          signal: AbortSignal.timeout(5000),
        })
        if (r.ok) channels.push('slack')
      } catch { /* network failure ? non-critical */ }
    }

    // ?? Generic webhook ??????????????????????????????????????
    const webhookUrl = cfg.alert_webhook_url ?? process.env.ALERT_WEBHOOK_URL ?? ''
    if (webhookUrl.startsWith('https://')) {
      try {
        const r = await fetch(webhookUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'incident.created', incident }),
          signal: AbortSignal.timeout(5000),
        })
        if (r.ok) channels.push('webhook')
      } catch { /* non-critical */ }
    }

    // ?? Append to notification log ???????????????????????????
    appendNotifLog({
      ts:       new Date().toISOString(),
      event:    'incident.created',
      channels,
      summary:  `${sev} incident ${incident.id}: ${incident.title}`,
      ok:       channels.length > 0,
    })
  } catch { /* never propagate */ }
}

export interface NotifyEscalationPayload {
  incidentId:    string
  incidentTitle: string
  severity:      string
  service:       string
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
  try {
    const cfg      = readConfig()
    const slackUrl = cfg.slack_webhook_url ?? process.env.SLACK_WEBHOOK_URL ?? ''
    if (!slackUrl.startsWith('https://hooks.slack.com/')) return false

    const emoji    = SEV_EMOJI[payload.severity] ?? '?'
    const mention  = payload.contactSlack
      ? (payload.contactSlack.startsWith('@') ? payload.contactSlack : `@${payload.contactSlack}`)
      : payload.contactName
    const levelTag = `*L${payload.nextLevel} ? ${payload.levelDesc}*`

    const r = await fetch(slackUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: `${emoji} Escalation ${levelTag.replace(/\*/g, '')}` },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${mention} you are being notified for incident *${payload.incidentTitle}*\n_${payload.incidentId} ? ${payload.service}_`,
            },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Severity*\n${payload.severity.toUpperCase()}` },
              { type: 'mrkdwn', text: `*Escalation Level*\nL${payload.nextLevel} ? ${payload.levelDesc}` },
              { type: 'mrkdwn', text: `*Contact*\n${payload.contactName}` },
              { type: 'mrkdwn', text: `*Email*\n${payload.contactEmail}` },
              ...(payload.slaInfo        ? [{ type: 'mrkdwn', text: `*SLA Status*\n${payload.slaInfo}` }]       : []),
              ...(payload.autoTriggered  ? [{ type: 'mrkdwn', text: `*Triggered by*\nAuto-escalation` }]        : []),
            ],
          },
          ...(payload.url
            ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '?? View Incident' }, url: payload.url, style: 'danger' }] }]
            : []),
        ],
      }),
      signal: AbortSignal.timeout(5000),
    })

    const ok = r.ok
    appendNotifLog({
      ts:      new Date().toISOString(),
      event:   'incident.escalated',
      channels: ok ? ['slack'] : [],
      summary: `Escalation L${payload.nextLevel} for ${payload.incidentId} ? ${payload.contactName}`,
      ok,
    })
    return ok
  } catch { return false }
}
