/**
 * POST /api/autonomous/plan
 *
 * Generates a multi-step remediation plan for an open incident using the configured LLM.
 * Called by the autonomous loop every cycle for incidents without a plan yet.
 *
 * The LLM picks and sequences from a validated VOCABULARY of known-safe primitives ?
 * it cannot invent new commands. Novel strategy, bounded execution.
 *
 * Plan stored in data/autonomous.plans.jsonl.
 * Returns { plan } or { skipped, reason }.
 */
import { generateText }                                  from 'ai'
import { createOpenAI }                                  from '@ai-sdk/openai'
import { createGoogleGenerativeAI }                      from '@ai-sdk/google'
import { createAnthropic }                                from '@ai-sdk/anthropic'
import { NextResponse }                                  from 'next/server'
import { readConfig }                                    from '@/app/api/settings/config/shared'
import { manualStore, buildAutoIncidents }               from '@/app/api/incidents/shared'
import type { IncidentDoc }                              from '@/app/api/incidents/shared'
import { resolveK8sUrl, K8S_TIMEOUT_MS }                from '@/lib/cluster'
import { assertOperator, assertSession }                from '@/lib/rbac'
import {
  ACTION_VOCAB,
  INTERNAL_PLAN_SECRET,
  readPlans,
  appendPlan,
  updatePlan,
} from '@/app/api/autonomous/plan/shared'
import type { PlanStep, RemediationPlan } from '@/app/api/autonomous/plan/shared'

const BASE        = (process.env.NEXTAUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '')

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function getPlanModel(): any | null {
  const cfg = readConfig()
  const provider = cfg.ai_provider ?? process.env.AI_PROVIDER ?? 'groq'
  const apiKey = cfg.ai_api_key
    ?? (provider === 'groq' ? cfg.groq_api_key : undefined)
    ?? process.env.AI_API_KEY
    ?? (provider === 'groq' ? process.env.GROQ_API_KEY : undefined)
    ?? (provider === 'google' ? process.env.GOOGLE_GENERATIVE_AI_API_KEY : undefined)
    ?? (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : undefined)
    ?? ''
  const model = cfg.ai_model
    ?? (provider === 'groq' ? cfg.groq_model : undefined)
    ?? process.env.AI_MODEL
    ?? (provider === 'groq' ? process.env.GROQ_MODEL : undefined)
    ?? 'llama-3.3-70b-versatile'
  const baseUrl = cfg.ai_base_url ?? process.env.AI_BASE_URL ?? ''

  if (!apiKey) return null
  if (provider === 'google') return createGoogleGenerativeAI({ apiKey })(model)
  if (provider === 'anthropic') return createAnthropic({ apiKey })(model)

  return createOpenAI({
    apiKey,
    baseURL: baseUrl || (provider === 'groq' ? 'https://api.groq.com/openai/v1' : undefined),
  })(model)
}

async function generatePlan(
  inc: IncidentDoc,
  liveContext: string,
  allowedActions: string[],
): Promise<{ reasoning: string; confidence: number; steps: PlanStep[]; namespace: string } | null> {
  const model = getPlanModel()
  if (!model) return null

  const vocabList = Object.entries(ACTION_VOCAB)
    .filter(([id]) => allowedActions.includes(id) || ACTION_VOCAB[id]?.risk === 'low')
    .map(([id, v]) => `- ${id}: ${v.description} [risk: ${v.risk}]`)
    .join('\n')

  const prompt = `You are an expert SRE generating a Kubernetes remediation plan.

INCIDENT:
- ID: ${inc.id}
- Title: ${inc.title}
- Severity: ${inc.severity}
- Service: ${inc.service}
- Duration: ${inc.durationMinutes} minutes
- SLA breached: ${inc.slaBreached}
- Alert count: ${inc.alertCount}

LIVE CLUSTER CONTEXT:
${liveContext}

AVAILABLE ACTIONS (you may ONLY use these):
${vocabList}

Respond with a JSON object (no markdown, no code blocks) with this exact shape:
{
  "reasoning": "one sentence explaining what is wrong and why this plan will fix it",
  "confidence": <integer 0-100>,
  "namespace": "<kubernetes namespace, default if unknown>",
  "steps": [
    { "action": "<action_id>", "target": "<deployment_name or empty>", "namespace": "<ns>", "reason": "<why this step>", "replicas": <integer, ONLY include for scale_deployment, omit for all other actions> }
  ]
}

Rules:
- Maximum 5 steps
- Always start with at least one read/check step before any remediation
- Only include remediation steps if confidence > 60
- Target must be a real deployment name from the context, or empty string
- If you cannot determine a safe plan, return confidence: 0 and steps: []`

  try {
    const result = await generateText({
      model,
      prompt,
      temperature: 0.2,
      maxTokens: 800,
      abortSignal: AbortSignal.timeout(20_000),
    })
    const raw = result.text
    const parsed = JSON.parse(raw.trim())

    // Validate steps against vocabulary, preserve replicas for scale_deployment
    const steps: PlanStep[] = (parsed.steps ?? [])
      .filter((s: any) => s.action && ACTION_VOCAB[s.action as keyof typeof ACTION_VOCAB])
      .map((s: any) => ({
        action:    s.action as keyof typeof ACTION_VOCAB,
        target:    s.target    ? String(s.target)    : undefined,
        namespace: s.namespace ? String(s.namespace) : undefined,
        reason:    String(s.reason ?? ''),
        ...(s.action === 'scale_deployment' && s.replicas != null
          ? { replicas: Math.max(1, Math.min(100, parseInt(s.replicas, 10) || 1)) }
          : {}),
      }))
      .slice(0, 5)

    if (!steps.length) return null

    return {
      reasoning:  String(parsed.reasoning ?? '').slice(0, 300),
      confidence: Math.min(100, Math.max(0, parseInt(parsed.confidence) || 0)),
      namespace:  String(parsed.namespace ?? 'default'),
      steps,
    }
  } catch { return null }
}

// ?? Gather live context for the LLM ??????????????????????????????????????????
async function gatherLiveContext(service: string, namespace: string): Promise<string> {
  const lines: string[] = []
  try {
    const K8S = await resolveK8sUrl()
    if (!K8S) return '(K8s unavailable)'

    // Pod status
    const pods = await fetch(`${K8S}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`,
      { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) }).then(r => r.ok ? r.json() : null).catch(() => null)

    if (pods?.items) {
      const summary = (pods.items as any[]).slice(0, 8).map((p: any) => {
        const cs  = (p.status?.containerStatuses ?? [])[0]
        const img = p.spec?.containers?.[0]?.image ?? '?'
        return `  pod=${p.metadata.name} ready=${cs?.ready ?? '?'} restarts=${cs?.restartCount ?? 0} state=${cs?.state?.waiting?.reason ?? cs?.state?.running ? 'Running' : 'Unknown'} image=${img.split('/').pop()}`
      }).join('\n')
      lines.push(`PODS in ${namespace}:\n${summary}`)
    }

    // Recent deployments
    const deps = await fetch(`${K8S}/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments`,
      { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) }).then(r => r.ok ? r.json() : null).catch(() => null)

    if (deps?.items) {
      const depSummary = (deps.items as any[]).slice(0, 6).map((d: any) =>
        `  deploy=${d.metadata.name} desired=${d.spec?.replicas} available=${d.status?.availableReplicas ?? 0}`
      ).join('\n')
      lines.push(`DEPLOYMENTS in ${namespace}:\n${depSummary}`)
    }

    // Recent events
    const events = await fetch(
      `${K8S}/api/v1/namespaces/${encodeURIComponent(namespace)}/events?limit=10`,
      { signal: AbortSignal.timeout(K8S_TIMEOUT_MS) }
    ).then(r => r.ok ? r.json() : null).catch(() => null)

    if (events?.items) {
      const evtSummary = (events.items as any[])
        .filter((e: any) => e.type !== 'Normal')
        .slice(0, 5)
        .map((e: any) => `  [${e.reason}] ${e.involvedObject?.name}: ${e.message?.slice(0, 80)}`)
        .join('\n')
      if (evtSummary) lines.push(`RECENT WARNING EVENTS:\n${evtSummary}`)
    }
  } catch { /* non-critical */ }

  return lines.join('\n\n') || '(no live context available)'
}

// ?? GET ? list all plans ??????????????????????????????????????????????????????
export async function GET() {
  const deny = await assertSession()
  if (deny) return deny

  const plans = readPlans()
  return NextResponse.json({ plans: [...plans].reverse() })
}

// ?? POST handler ??????????????????????????????????????????????????????????????
export async function POST(req: Request) {
  const cronSecret = process.env.CRON_SECRET
  const isInternal = !!(cronSecret && req.headers.get('x-internal-secret') === cronSecret)
  if (!isInternal) {
    const deny = await assertOperator()
    if (deny) return deny
  }

  const cfg = readConfig()
  if (!cfg.auto_plan_enabled) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'AI plan generation disabled in settings' })
  }

  const allowedActions = Object.keys(ACTION_VOCAB) // all actions available for planning

  // Gather open incidents
  const { incidents: autoIncidents } = await buildAutoIncidents()
  const manualEntries = Array.from(manualStore.values())
  const manualIds     = new Set(manualEntries.map(i => i.id))
  const all: IncidentDoc[] = [
    ...autoIncidents.filter(i => !manualIds.has(i.id)),
    ...manualEntries,
  ]
  const open = all.filter(i => i.state !== 'resolved')

  // Build set of already-planned incident IDs
  const existingPlans = readPlans()
  const plannedIds = new Set(
    existingPlans
      .filter(p => p.status !== 'dismissed' && p.status !== 'failed')
      .map(p => p.incidentId)
  )

  const nowIso = new Date().toISOString()
  const generated: { incidentId: string; planId: string; confidence: number }[] = []

  for (const inc of open) {
    if (plannedIds.has(inc.id)) continue          // already has an active plan
    if (inc.severity !== 'critical' && inc.severity !== 'high') continue  // only critical/high

    // Determine namespace from labels or service name
    const namespace = inc.labels?.namespace ?? inc.service ?? 'default'

    const liveContext = await gatherLiveContext(inc.service, namespace)
    const result      = await generatePlan(inc, liveContext, allowedActions)

    if (!result || result.confidence === 0) continue

    const plan: RemediationPlan = {
      id:            generateId(),
      incidentId:    inc.id,
      incidentTitle: inc.title,
      severity:      inc.severity,
      service:       inc.service,
      createdAt:     nowIso,
      reasoning:     result.reasoning,
      confidence:    result.confidence,
      steps:         result.steps,
      status:        'pending',
      namespace:     result.namespace,
    }

    appendPlan(plan)
    plannedIds.add(inc.id)

    // Auto-execute if enabled and confidence is above threshold
    const autoExec      = cfg.auto_execute_plans ?? false
    const execThreshold = cfg.auto_execute_threshold ?? 85
    if (autoExec && result.confidence >= execThreshold) {
      plan.status     = 'approved'
      plan.approvedBy = 'system'
      updatePlan(plan.id, { status: 'approved', approvedBy: 'system' })
      // Fire approval endpoint async (don't block plan generation)
      fetch(`${BASE}/api/autonomous/plan/${plan.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_PLAN_SECRET },
        body: JSON.stringify({ auto: true }),
      }).catch(() => {})
    }

    generated.push({ incidentId: inc.id, planId: plan.id, confidence: result.confidence })
  }

  return NextResponse.json({
    ok:        true,
    checked:   open.length,
    generated: generated.length,
    plans:     generated,
    ranAt:     nowIso,
  })
}

