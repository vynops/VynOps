import fs from 'fs'
import path from 'path'

const CONFIG_PATH = path.join(process.cwd(), 'config.runtime.json')
export const AUDIT_PATH = path.join(process.cwd(), 'audit.log.jsonl')
export const NOTIF_LOG_PATH = path.join(process.cwd(), 'notifications.log.jsonl')

export interface RuntimeConfig {
  slack_webhook_url?: string
  teams_webhook_url?: string
  alertmanager_url?: string
  pagerduty_routing_key?: string
  alert_email?: string
  alert_webhook_url?: string
  groq_api_key?: string
  groq_model?: string
  ai_provider?: 'groq' | 'openai' | 'google' | 'anthropic' | 'custom'
  ai_api_key?: string
  ai_model?: string
  ai_base_url?: string
  notify_on?: Record<string, boolean>
  integrations_enabled?: Record<string, boolean>
  alert_routing?: Record<string, string[]>
  notify_cooldown_minutes?: number
  last_tested?: Record<string, { ts: string; ok: boolean; msg: string }>
  smtp_host?: string
  smtp_port?: number
  smtp_user?: string
  smtp_pass?: string
  smtp_from?: string
  autonomous_enabled?: boolean
  autonomous_dry_run?: boolean
  autonomous_confidence_threshold?: number
  autonomous_allowed_actions?: string[]
  finops_cpu_per_core_hr?: number
  finops_mem_per_gib_hr?: number
  finops_storage_per_gib_mo?: number
  sla_minutes_critical?: number
  sla_minutes_high?: number
  sla_minutes_medium?: number
  sla_minutes_low?: number
  auto_escalate_enabled?: boolean
  auto_runbook_enabled?: boolean
  auto_runbook_allowed?: Record<string, boolean>
  auto_plan_enabled?: boolean
  auto_execute_plans?: boolean
  auto_execute_threshold?: number
  /** Highest action risk a plan may contain and still auto-execute; default 'low'. */
  auto_execute_max_risk?: 'low' | 'medium' | 'high'
}

export function readConfig(): RuntimeConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {}
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

export function writeConfig(cfg: RuntimeConfig): void {
  const tmp = CONFIG_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf-8')
  fs.renameSync(tmp, CONFIG_PATH)
}

// Rotated copies (.1, .2) stay on disk; the history pages read only the live file.
const MAX_LOG_BYTES = 5 * 1024 * 1024
function appendRotating(file: string, line: string) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      if (fs.existsSync(`${file}.1`)) fs.renameSync(`${file}.1`, `${file}.2`)
      fs.renameSync(file, `${file}.1`)
    }
  } catch { /* rotation must never block logging */ }
  fs.appendFileSync(file, line)
}

export function appendAuditLog(entry: { ts: string; user: string; action: string; fields?: string[]; detail?: string }) {
  appendRotating(AUDIT_PATH, JSON.stringify(entry) + '\n')
}

export function appendNotifLog(entry: { ts: string; event: string; channels: string[]; summary: string; ok: boolean; incidentId?: string; status?: string; attempts?: { channel: string; attempt: number; ok: boolean; status?: number }[] }) {
  appendRotating(NOTIF_LOG_PATH, JSON.stringify(entry) + '\n')
}
