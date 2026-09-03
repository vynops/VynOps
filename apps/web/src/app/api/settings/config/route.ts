import { NextResponse } from 'next/server'
import { auth }         from '@/lib/auth'
import { z }            from 'zod'
import {
  readConfig,
  writeConfig,
  appendAuditLog,
  appendNotifLog,
  type RuntimeConfig,
} from '@/app/api/settings/config/shared'

// Fields whose full value must be masked in GET responses
const SECRET_FIELDS = new Set(['groq_api_key', 'ai_api_key', 'pagerduty_routing_key', 'smtp_pass'])
const SENTINEL      = '__UNCHANGED__'
const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-120b'
const RETIRED_GROQ_MODELS = new Set(['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'])

function maskSecret(value: string): string {
  return value ? '***configured***' : ''
}

// ── GET — load merged config (env fallbacks, secrets masked) ──
export async function GET(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const stored = readConfig()
  const configuredProvider = stored.ai_provider ?? (process.env.AI_PROVIDER as RuntimeConfig['ai_provider']) ?? 'groq'
  const providerEnvKey = configuredProvider === 'google'
    ? process.env.GOOGLE_GENERATIVE_AI_API_KEY
    : configuredProvider === 'anthropic'
      ? process.env.ANTHROPIC_API_KEY
      : configuredProvider === 'openai'
        ? process.env.OPENAI_API_KEY
        : configuredProvider === 'groq'
          ? process.env.GROQ_API_KEY
          : undefined

  // Merge: runtime config > .env fallbacks
  const merged: RuntimeConfig = {
    slack_webhook_url:       stored.slack_webhook_url       ?? process.env.SLACK_WEBHOOK_URL       ?? '',
    teams_webhook_url:       stored.teams_webhook_url       ?? process.env.TEAMS_WEBHOOK_URL       ?? '',
    alertmanager_url:        stored.alertmanager_url        ?? process.env.ALERTMANAGER_URL        ?? '',
    pagerduty_routing_key:   stored.pagerduty_routing_key   ?? process.env.PAGERDUTY_ROUTING_KEY   ?? '',
    alert_email:             stored.alert_email             ?? process.env.ALERT_EMAIL             ?? '',
    alert_webhook_url:       stored.alert_webhook_url       ?? process.env.ALERT_WEBHOOK_URL       ?? '',
    groq_api_key:            stored.groq_api_key            ?? process.env.GROQ_API_KEY            ?? '',
    groq_model:              stored.groq_model              ?? process.env.GROQ_MODEL              ?? GROQ_DEFAULT_MODEL,
    ai_provider:             configuredProvider,
    ai_api_key:              stored.ai_api_key              ?? process.env.AI_API_KEY              ?? providerEnvKey ?? '',
    ai_model:                stored.ai_model && !(configuredProvider === 'groq' && RETIRED_GROQ_MODELS.has(stored.ai_model))
      ? stored.ai_model
      : process.env.AI_MODEL && !(configuredProvider === 'groq' && RETIRED_GROQ_MODELS.has(process.env.AI_MODEL))
        ? process.env.AI_MODEL
        : configuredProvider === 'groq' ? GROQ_DEFAULT_MODEL : '',
    ai_base_url:             stored.ai_base_url             ?? process.env.AI_BASE_URL             ?? '',
    notify_on:               stored.notify_on               ?? {},
    integrations_enabled:    stored.integrations_enabled    ?? {},
    alert_routing:           stored.alert_routing           ?? { critical: ['slack'], warning: ['slack'], info: ['slack'] },
    notify_cooldown_minutes: stored.notify_cooldown_minutes ?? 30,
    last_tested:             stored.last_tested             ?? {},
    smtp_host:               stored.smtp_host  ?? process.env.SMTP_HOST  ?? '',
    smtp_port:               stored.smtp_port  ?? parseInt(process.env.SMTP_PORT ?? '587', 10),
    smtp_user:               stored.smtp_user  ?? process.env.SMTP_USER  ?? '',
    smtp_pass:               stored.smtp_pass  ?? process.env.SMTP_PASS  ?? '',
    smtp_from:               stored.smtp_from  ?? process.env.SMTP_FROM  ?? '',
  }

  // Mask secrets before sending to client
  const safe: Record<string, any> = { ...merged }
  for (const field of SECRET_FIELDS) {
    if (safe[field]) safe[field] = maskSecret(safe[field] as string)
  }

  // Tell the client which fields are sourced from env vs runtime file
  const source: Record<string, 'env' | 'runtime' | 'unset'> = {}
  for (const key of Object.keys(merged)) {
    const k = key as keyof RuntimeConfig
    if (stored[k] !== undefined) source[key] = 'runtime'
    else if (merged[k])          source[key] = 'env'
    else                         source[key] = 'unset'
  }

  return NextResponse.json({ config: safe, source })
}
// ── Zod validation schema ─────────────────────────────────────
const configBodySchema = z.object({
  slack_webhook_url:       z.string().max(500).optional(),
  teams_webhook_url:       z.string().max(500).optional(),
  alertmanager_url:        z.string().max(500).optional(),
  pagerduty_routing_key:   z.string().max(64).optional(),
  alert_email:             z.string().max(255).optional(),
  alert_webhook_url:       z.string().max(500).optional(),
  groq_api_key:            z.string().max(200).optional(),
  groq_model:              z.string().max(100).optional(),
  ai_provider:             z.enum(['groq', 'openai', 'google', 'anthropic', 'custom']).optional(),
  ai_api_key:              z.string().max(500).optional(),
  ai_model:                z.string().max(200).optional(),
  ai_base_url:             z.string().url().max(500).optional().or(z.literal('')),
  notify_on:               z.record(z.boolean()).optional(),
  integrations_enabled:    z.record(z.boolean()).optional(),
  alert_routing:           z.record(z.array(z.string())).optional(),
  notify_cooldown_minutes: z.number().int().min(1).max(10080).optional(),
  last_tested:             z.record(z.object({ ts: z.string(), ok: z.boolean(), msg: z.string() })).optional(),
  smtp_host:               z.string().max(255).optional(),
  smtp_port:               z.number().int().min(1).max(65535).optional(),
  smtp_user:               z.string().max(255).optional(),
  smtp_pass:               z.string().max(255).optional(),
  smtp_from:               z.string().max(500).optional(),
  finops_cpu_per_core_hr:    z.number().positive().optional(),
  finops_mem_per_gib_hr:     z.number().positive().optional(),
  finops_storage_per_gib_mo: z.number().positive().optional(),
  sla_minutes_critical:      z.number().int().min(5).max(10080).optional(),
  sla_minutes_high:          z.number().int().min(5).max(10080).optional(),
  sla_minutes_medium:        z.number().int().min(5).max(10080).optional(),
  sla_minutes_low:           z.number().int().min(5).max(10080).optional(),
  auto_escalate_enabled:     z.boolean().optional(),
  auto_runbook_enabled:      z.boolean().optional(),
  auto_runbook_allowed:      z.record(z.boolean()).optional(),
  auto_plan_enabled:         z.boolean().optional(),
  auto_execute_plans:        z.boolean().optional(),
  auto_execute_threshold:    z.number().int().min(50).max(99).optional(),
}).partial()
// ── POST — save config to runtime file ───────────────────────
export async function POST(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Only admins can change platform config
  if ((session.user as any)?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden — admin role required' }, { status: 403 })
  }

  const body: Partial<RuntimeConfig> = await req.json()

  const parseResult = configBodySchema.safeParse(body)
  if (!parseResult.success) {
    return NextResponse.json({ error: 'Invalid input', issues: parseResult.error.issues }, { status: 400 })
  }

  const existing = readConfig()

  // Merge — skip sentinel values (unchanged masked fields)
  const updated: RuntimeConfig = { ...existing }

  const fields: (keyof RuntimeConfig)[] = [
    'slack_webhook_url', 'teams_webhook_url', 'alertmanager_url', 'pagerduty_routing_key',
    'alert_email', 'alert_webhook_url', 'groq_api_key', 'groq_model',
    'ai_provider', 'ai_api_key', 'ai_model', 'ai_base_url',
  ]

  const changedFields: string[] = []
  for (const field of fields) {
    const v = body[field] as string | undefined
    if (v === undefined) continue
    if (v === SENTINEL)  continue
    // Store '' explicitly so env-var fallback is blocked (null-coalescing ?? skips only null/undefined)
    ;(updated as any)[field] = v
    changedFields.push(field)
  }

  if (body.notify_on               !== undefined) { updated.notify_on               = body.notify_on;               changedFields.push('notify_on') }
  if (body.integrations_enabled    !== undefined) { updated.integrations_enabled    = body.integrations_enabled;    changedFields.push('integrations_enabled') }
  if (body.alert_routing           !== undefined) { updated.alert_routing           = body.alert_routing;           changedFields.push('alert_routing') }
  if (body.notify_cooldown_minutes !== undefined) { updated.notify_cooldown_minutes = body.notify_cooldown_minutes; changedFields.push('notify_cooldown_minutes') }
  if (body.last_tested             !== undefined) { updated.last_tested             = body.last_tested             }

  // SMTP string fields — store '' explicitly to shadow env-var fallbacks
  for (const field of ['smtp_host', 'smtp_user', 'smtp_from'] as const) {
    const v = body[field]
    if (v === undefined) continue
    if (v === SENTINEL)  continue
    updated[field] = v
    changedFields.push(field)
  }
  if (body.smtp_pass !== undefined && body.smtp_pass !== SENTINEL) {
    updated.smtp_pass = body.smtp_pass
    changedFields.push('smtp_pass')
  }
  if (body.smtp_port !== undefined) { updated.smtp_port = body.smtp_port; changedFields.push('smtp_port') }

  // FinOps rates
  if (body.finops_cpu_per_core_hr    !== undefined) { updated.finops_cpu_per_core_hr    = body.finops_cpu_per_core_hr;    changedFields.push('finops_cpu_per_core_hr') }
  if (body.finops_mem_per_gib_hr     !== undefined) { updated.finops_mem_per_gib_hr     = body.finops_mem_per_gib_hr;     changedFields.push('finops_mem_per_gib_hr') }
  if (body.finops_storage_per_gib_mo !== undefined) { updated.finops_storage_per_gib_mo = body.finops_storage_per_gib_mo; changedFields.push('finops_storage_per_gib_mo') }

  // SLA windows + auto-escalation
  if (body.sla_minutes_critical  !== undefined) { updated.sla_minutes_critical  = body.sla_minutes_critical;  changedFields.push('sla_minutes_critical') }
  if (body.sla_minutes_high      !== undefined) { updated.sla_minutes_high      = body.sla_minutes_high;      changedFields.push('sla_minutes_high') }
  if (body.sla_minutes_medium    !== undefined) { updated.sla_minutes_medium    = body.sla_minutes_medium;    changedFields.push('sla_minutes_medium') }
  if (body.sla_minutes_low       !== undefined) { updated.sla_minutes_low       = body.sla_minutes_low;       changedFields.push('sla_minutes_low') }
  if (body.auto_escalate_enabled !== undefined) { updated.auto_escalate_enabled = body.auto_escalate_enabled; changedFields.push('auto_escalate_enabled') }
  if (body.auto_runbook_enabled  !== undefined) { updated.auto_runbook_enabled  = body.auto_runbook_enabled;  changedFields.push('auto_runbook_enabled') }
  if (body.auto_runbook_allowed  !== undefined) { updated.auto_runbook_allowed  = body.auto_runbook_allowed;  changedFields.push('auto_runbook_allowed') }
  if (body.auto_plan_enabled      !== undefined) { updated.auto_plan_enabled      = body.auto_plan_enabled;      changedFields.push('auto_plan_enabled') }
  if (body.auto_execute_plans     !== undefined) { updated.auto_execute_plans     = body.auto_execute_plans;     changedFields.push('auto_execute_plans') }
  if (body.auto_execute_threshold !== undefined) { updated.auto_execute_threshold = body.auto_execute_threshold; changedFields.push('auto_execute_threshold') }

  writeConfig(updated)

  // Audit log
  appendAuditLog({
    ts: new Date().toISOString(),
    user: (session.user as any)?.email ?? 'unknown',
    action: 'config.update',
    fields: changedFields,
  })

  return NextResponse.json({ ok: true })
}
