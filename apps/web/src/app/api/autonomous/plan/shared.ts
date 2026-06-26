import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'

const DATA_DIR   = join(process.cwd(), 'data')
const PLANS_FILE = join(DATA_DIR, 'autonomous.plans.jsonl')

// Shared secret for server-to-server auto-approve calls.
export const INTERNAL_PLAN_SECRET: string =
  process.env.AUTONOMOUS_INTERNAL_SECRET ?? randomBytes(32).toString('hex')

// Action vocabulary used by both plan generation and execution.
export const ACTION_VOCAB: Record<string, { description: string; requiresTarget: boolean; risk: 'low' | 'medium' | 'high' }> = {
  check_pod_status:        { description: 'Read pod status and container states',        requiresTarget: false, risk: 'low'    },
  check_pod_logs:          { description: 'Retrieve recent container logs',              requiresTarget: false, risk: 'low'    },
  check_rollout_history:   { description: 'List deployment revision history',            requiresTarget: true,  risk: 'low'    },
  check_events:            { description: 'Fetch Kubernetes events for namespace',       requiresTarget: false, risk: 'low'    },
  check_resource_usage:    { description: 'Read CPU/memory limits and requests',         requiresTarget: true,  risk: 'low'    },
  restart_deployment:      { description: 'Trigger a rollout restart of a deployment',   requiresTarget: true,  risk: 'medium' },
  rollback_deployment:     { description: 'Roll back deployment to previous revision',   requiresTarget: true,  risk: 'medium' },
  scale_deployment:        { description: 'Scale deployment replica count',              requiresTarget: true,  risk: 'medium' },
  patch_memory_limit:      { description: 'Increase deployment memory limit by +256Mi',  requiresTarget: true,  risk: 'medium' },
  delete_crashed_pod:      { description: 'Delete a crashing pod (deployment recreates)',requiresTarget: false, risk: 'medium' },
  verify_health:           { description: 'Check deployment health after remediation',   requiresTarget: true,  risk: 'low'    },
}

export interface PlanStep {
  action:     keyof typeof ACTION_VOCAB
  target?:    string
  namespace?: string
  reason:     string
  replicas?:  number
}

export interface RemediationPlan {
  id:            string
  incidentId:    string
  incidentTitle: string
  severity:      string
  service:       string
  createdAt:     string
  reasoning:     string
  confidence:    number
  steps:         PlanStep[]
  status:        'pending' | 'approved' | 'dismissed' | 'executing' | 'done' | 'failed'
  executedAt?:   string
  approvedBy?:   string
  results?:      { step: string; ok: boolean; output: string }[]
  namespace:     string
}

export function readPlans(): RemediationPlan[] {
  try {
    if (!existsSync(PLANS_FILE)) return []
    return readFileSync(PLANS_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch { return [] }
}

export function appendPlan(plan: RemediationPlan): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(PLANS_FILE, JSON.stringify(plan) + '\n', 'utf8')
  } catch { /* non-critical */ }
}

export function updatePlan(id: string, update: Partial<RemediationPlan>): void {
  try {
    if (!existsSync(PLANS_FILE)) return
    const plans = readPlans()
    const idx = plans.findIndex(p => p.id === id)
    if (idx < 0) return
    plans[idx] = { ...plans[idx]!, ...update }
    writeFileSync(PLANS_FILE, plans.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf8')
  } catch { /* non-critical */ }
}

