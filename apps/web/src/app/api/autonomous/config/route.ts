import { NextResponse } from 'next/server'
import { auth }          from '@/lib/auth'
import { assertOperator } from '@/lib/rbac'
import { readConfig, writeConfig } from '@/app/api/settings/config/shared'

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const cfg = readConfig() as any
  return NextResponse.json({
    enabled:             !!cfg.autonomous_enabled,
    dryRun:              cfg.autonomous_dry_run !== false,
    confidenceThreshold: cfg.autonomous_confidence_threshold ?? 80,
    allowedActions:      cfg.autonomous_allowed_actions ?? ['restart_deployment'],
  })
}

export async function POST(req: Request) {
  const deny = await assertOperator()
  if (deny) return deny

  const body = await req.json()
  const cfg  = readConfig() as any

  if (typeof body.enabled             === 'boolean') cfg.autonomous_enabled              = body.enabled
  if (typeof body.dryRun              === 'boolean') cfg.autonomous_dry_run              = body.dryRun
  if (typeof body.confidenceThreshold === 'number')  cfg.autonomous_confidence_threshold = Math.max(50, Math.min(100, body.confidenceThreshold))
  if (Array.isArray(body.allowedActions))            cfg.autonomous_allowed_actions       = body.allowedActions

  writeConfig(cfg)
  return NextResponse.json({ ok: true })
}
