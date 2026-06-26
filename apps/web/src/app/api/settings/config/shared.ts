import fs from 'fs'
import path from 'path'

const CONFIG_PATH = path.join(process.cwd(), 'config.runtime.json')
export const AUDIT_PATH = path.join(process.cwd(), 'audit.log.jsonl')
export const NOTIF_LOG_PATH = path.join(process.cwd(), 'notifications.log.jsonl')

export interface RuntimeConfig {
  slack_webhook_url?: string
  alertmanager_url?: string
  pagerduty_routing_key?: string
  alert_email?: string
  alert_webhook_url?: string
  groq_api_key?: string
  groq_model?: string
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

export function appendAuditLog(entry: { ts: string; user: string; action: string; fields?: string[]; detail?: string }) {
  try {
    fs.appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n')
  } catch {
    // non-critical
  }
}

export function appendNotifLog(entry: { ts: string; event: string; channels: string[]; summary: string; ok: boolean }) {
  try {
    fs.appendFileSync(NOTIF_LOG_PATH, JSON.stringify(entry) + '\n')
  } catch {
    // non-critical
  }
}
