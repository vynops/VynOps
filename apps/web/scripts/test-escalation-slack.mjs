/**
 * Quick test: sends a mock escalation Slack message using the webhook URL from config.runtime.json
 * Run: node scripts/test-escalation-slack.mjs
 */
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = join(ROOT, 'config.runtime.json')
const oncallPath = join(ROOT, 'data', 'oncall.json')
const envPath    = join(ROOT, '.env.local')

// Load .env.local manually so the script mirrors Next.js runtime
if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim()
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/)
    if (m) process.env[m[1]] = m[2].trim()
  }
}

if (!existsSync(configPath)) { console.error('❌ config.runtime.json not found'); process.exit(1) }

const cfg    = JSON.parse(readFileSync(configPath, 'utf8'))
const oncall = existsSync(oncallPath) ? JSON.parse(readFileSync(oncallPath, 'utf8')) : null

const webhookUrl = cfg.slack_webhook_url ?? process.env.SLACK_WEBHOOK_URL ?? ''
if (!webhookUrl.startsWith('https://hooks.slack.com/')) {
  console.error('❌ Slack webhook URL not found in config.runtime.json or .env.local')
  console.error('   Go to Settings → Notifications → Slack Webhook URL → Save.')
  process.exit(1)
}

// Pick first on-call member as test contact
const members = oncall?.schedules?.[0]?.members ?? []
const contact = members[0] ?? { name: 'Test User', email: 'test@example.com', slack: undefined }
const mention = contact.slack
  ? (contact.slack.startsWith('@') ? contact.slack : `@${contact.slack}`)
  : contact.name

console.log(`📤 Sending test escalation Slack message...`)
console.log(`   Webhook: ${webhookUrl.slice(0, 45)}...`)
console.log(`   Contact: ${contact.name} (${contact.email})${contact.slack ? ` · Slack: @${contact.slack}` : ' · no slack handle'}`)

const body = {
  blocks: [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🔴 TEST — Escalation L1 — Primary on-call' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${mention} *[TEST MESSAGE]* — This is a test escalation from VynOps.\n_INC-TEST-001 · kubernetes_`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Severity*\nCRITICAL' },
        { type: 'mrkdwn', text: '*Escalation Level*\nL1 — Primary on-call' },
        { type: 'mrkdwn', text: `*Contact*\n${contact.name}` },
        { type: 'mrkdwn', text: `*Email*\n${contact.email}` },
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '⚠️ This is a test — no real incident is active' }],
    },
  ],
}

const r = await fetch(webhookUrl, {
  method:  'POST',
  headers: { 'Content-Type': 'application/json' },
  body:    JSON.stringify(body),
})

if (r.ok) {
  console.log('✅ Slack message delivered successfully!')
  console.log('   Check your Slack channel now.')
} else {
  const text = await r.text()
  console.error(`❌ Slack delivery failed: HTTP ${r.status} — ${text}`)
}
