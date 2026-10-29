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
import { hasInternalSecret, internalFetch }              from '@/lib/internal'
import { notifyIncident }                                from '@/lib/notify'
import { getAIUsageFailure, recordAIUsage }               from '@/lib/ai-usage'
import {
  ACTION_VOCAB,
  exceedsAutoRisk,
  readPlans,
  appendPlan,
  updatePlan,
  resolvePlanModel,
} from '@/app/api/autonomous/plan/shared'
import type { PlanStep, RemediationPlan } from '@/app/api/autonomous/plan/shared'

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// Kept in step with ai/chat/route.ts and settings/config/route.ts.
function getPlanModel(): { model: any; provider: string; modelName: string } | null {
  const cfg = readConfig()
  const provider = cfg.ai_provider ?? process.env.AI_PROVIDER ?? 'groq'
  const apiKey = cfg.ai_api_key
    ?? (provider === 'groq' ? cfg.groq_api_key : undefined)
    ?? process.env.AI_API_KEY
    ?? (provider === 'groq' ? process.env.GROQ_API_KEY : undefined)
    ?? (provider === 'google' ? process.env.GOOGLE_GENERATIVE_AI_API_KEY : undefined)
    ?? (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : undefined)
    ?? ''
  const model = resolvePlanModel(cfg, provider, process.env)
  const baseUrl = cfg.ai_base_url ?? process.env.AI_BASE_URL ?? ''

  if (!apiKey) return null
  if (provider === 'google') return { model: createGoogleGenerativeAI({ apiKey })(model), provider, modelName: model }
  if (provider === 'anthropic') return { model: createAnthropic({ apiKey })(model), provider, modelName: model }

  return {
    model: createOpenAI({
      apiKey,
      baseURL: baseUrl || (provider === 'groq' ? 'https://api.groq.com/openai/v1' : undefined),
    })(model),
    provider,
    modelName: model,
  }
}

async function generatePlan(
  inc: IncidentDoc,
  liveContext: string,
  allowedActions: string[],
): Promise<{ reasoning: string; confidence: number; steps: PlanStep[]; namespace: string } | null> {
  const selectedModel = getPlanModel()
  if (!selectedModel) return null

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

FIRING ALERTS:
${alertLines(inc)}

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

  const startedAt = Date.now()
  let usageRecorded = false
  try {
    const result = await generateText({
      model: selectedModel.model,
      prompt,
      temperature: 0.2,
      maxTokens: 800,
      abortSignal: AbortSignal.timeout(20_000),
    })
    recordAIUsage({
      source: 'autonomous_plan',
      provider: selectedModel.provider,
      model: selectedModel.modelName,
      status: 'success',
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      durationMs: Date.now() - startedAt,
    })
    usageRecorded = true
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

    if (!steps.length) { console.error(`[autonomous] plan for ${inc.id}: model returned no usable steps`); return null }

    return {
      reasoning:  String(parsed.reasoning ?? '').slice(0, 300),
      confidence: Math.min(100, Math.max(0, parseInt(parsed.confidence) || 0)),
      namespace:  String(parsed.namespace ?? 'default'),
      steps,
    }
  } catch (e: any) {
    if (!usageRecorded) {
      recordAIUsage({
        source: 'autonomous_plan',
        provider: selectedModel.provider,
        model: selectedModel.modelName,
        durationMs: Date.now() - startedAt,
        ...getAIUsageFailure(e),
      })
    }
    console.error(`[autonomous] plan generation failed for ${inc.id}: ${e?.message ?? e}`)
    return null
  }
}

const ALERT_CONTEXT_LABELS = ['namespace', 'deployment', 'statefulset', 'daemonset', 'pod', 'container', 'job_name'] as const

/** One line per firing alert with the labels that identify the workload, so the model works from facts. */
function alertLines(inc: IncidentDoc): string {
  const lines = (inc.alerts ?? []).slice(0, 8).map(a => {
    const where = ALERT_CONTEXT_LABELS.filter(k => a.labels?.[k]).map(k => `${k}=${a.labels[k]}`).join(' ')
    return `- ${a.name} (${a.severity})${where ? ` ${where}` : ''}`
  })
  return lines.length ? lines.join('\n') : '(none listed)'
}

// ── Gather live context for the LLM????
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
  if (!hasInternalSecret(req.headers)) {
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
  // A plan only covers the incident's current occurrence: plans older than the last reopen are superseded.
  const reopenedAt = (inc: IncidentDoc) =>
    Math.max(0, ...inc.timeline.filter(e => e.title === 'Alerts firing again').map(e => Date.parse(e.ts) || 0))
  const reopenTs = new Map(open.map(i => [i.id, reopenedAt(i)]))
  const existingPlans = readPlans()
  const plannedIds = new Set<string>()
  for (const p of existingPlans) {
    if (p.status === 'dismissed' || p.status === 'failed') continue
    if (Date.parse(p.createdAt) < (reopenTs.get(p.incidentId) ?? 0)) {
      if (p.status === 'pending') updatePlan(p.id, { status: 'dismissed' })
      continue
    }
    plannedIds.add(p.incidentId)
  }

  const nowIso = new Date().toISOString()
  const generated: { incidentId: string; planId: string; confidence: number }[] = []

  for (const inc of open) {
    if (plannedIds.has(inc.id)) continue          // already has an active plan
    if (inc.severity !== 'critical' && inc.severity !== 'high' && inc.severity !== 'medium') continue  // low/info never get plans

    // Determine namespace from labels or service name
    const alertNamespace = (inc.alerts ?? []).map(a => a.labels?.namespace).find(Boolean)
    const namespace = inc.labels?.namespace ?? alertNamespace ?? inc.service ?? 'default'

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
    if (autoExec && result.confidence >= execThreshold && !exceedsAutoRisk(result.steps, cfg.auto_execute_max_risk)) {
      plan.status     = 'approved'
      plan.approvedBy = 'system'
      updatePlan(plan.id, { status: 'approved', approvedBy: 'system' })
      // Not awaited so execution doesn't block plan generation; a failed hand-off drops the plan back to manual approval.
      const planId = plan.id
      const handBack = (why: string) => {
        console.error(`[autonomous] auto-approve of plan ${planId} failed: ${why}`)
        if (readPlans().find(p => p.id === planId)?.status === 'approved') {
          updatePlan(planId, { status: 'pending', approvedBy: undefined })
        }
      }
      internalFetch(`/api/autonomous/plan/${planId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto: true }),
        timeoutMs: 120_000,
      }).then(r => { if (!r.ok) handBack(`HTTP ${r.status}`) }).catch(e => handBack(e.message))
    }

    generated.push({ incidentId: inc.id, planId: plan.id, confidence: result.confidence })
  }

  // Tell a human about plans waiting for approval: once when pending, and once more as a reminder.
  const REMIND_AFTER_MS = 60 * 60_000
  const openById = new Map(open.map(i => [i.id, i]))
  const appBase  = (process.env.NEXTAUTH_URL ?? 'http://localhost:3030').replace(/\/$/, '')
  let planNotices = 0
  for (const p of readPlans()) {
    if (p.status !== 'pending') continue
    const inc = openById.get(p.incidentId)
    if (!inc) continue   // incident resolved: nothing left to approve
    const first  = !p.notifiedAt
    const remind = !first && !p.reminderSentAt && Date.now() - Date.parse(p.notifiedAt!) > REMIND_AFTER_MS
    if (!first && !remind) continue
    // Marked before sending so a failing channel cannot cause a notification every cycle.
    updatePlan(p.id, first ? { notifiedAt: nowIso } : { reminderSentAt: nowIso })
    await notifyIncident({
      id:       p.id,
      title:    `${remind ? 'Reminder: ' : ''}AI plan awaiting approval for ${p.incidentTitle}`,
      severity: inc.severity,
      service:  p.service,
      state:    `pending approval (${p.confidence}% confidence)`,
      url:      `${appBase}/autonomous`,
    }, 'plan.pending')
    planNotices++
  }

  return NextResponse.json({
    ok:        true,
    checked:   open.length,
    generated: generated.length,
    planNotices,
    plans:     generated,
    ranAt:     nowIso,
  })
}
