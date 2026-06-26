/**
 * VynOps Autonomous Learning Engine
 *
 * Reads the action log and outcomes file to compute per-pattern success rates,
 * derive adaptive confidence-threshold multipliers, and build a persistent
 * cooldown map (so the server can resume correctly after a restart).
 *
 * This module is a plain Node.js library — no Next.js imports.
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const DATA_DIR      = join(process.cwd(), 'data')
const LOG_FILE      = join(DATA_DIR, 'autonomous.log.jsonl')
const OUTCOMES_FILE = join(DATA_DIR, 'autonomous.outcomes.jsonl')

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ActionEntry {
  id:          string
  ts:          string
  result:      'ok' | 'failed' | 'dry_run' | 'skipped_cooldown' | 'unresolvable'
  action:      string
  target:      string
  namespace:   string
  confidence:  number
  patternKey?: string
  dryRun:      boolean
  insight?:    string
}

export interface OutcomeEntry {
  actionId: string
  ts:       string
  outcome:  'resolved' | 'persisted' | 'unknown'
  detail?:  string
}

export interface PatternStats {
  patternKey:         string
  action:             string
  /** All live (result=ok) actions for this pattern */
  total:              number
  /** Verified resolved */
  resolved:           number
  /** Verified persisted (action didn't fix it) */
  persisted:          number
  /** Verified but health-check returned unknown */
  unknown:            number
  /** resolved / (resolved + persisted); -1 means no verified data yet */
  successRate:        number
  avgConfidence:      number
  /** Threshold multiplier based on success rate (requires ≥5 verified samples) */
  multiplier:         number
}

// ── File I/O ───────────────────────────────────────────────────────────────────

export function readActions(): ActionEntry[] {
  if (!existsSync(LOG_FILE)) return []
  try {
    return readFileSync(LOG_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as ActionEntry)
  } catch { return [] }
}

export function readOutcomes(): OutcomeEntry[] {
  if (!existsSync(OUTCOMES_FILE)) return []
  try {
    return readFileSync(OUTCOMES_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as OutcomeEntry)
  } catch { return [] }
}

export function appendOutcome(entry: OutcomeEntry): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(OUTCOMES_FILE, JSON.stringify(entry) + '\n', 'utf8')
  } catch { /* non-critical */ }
}

// ── Learning computation ───────────────────────────────────────────────────────

/**
 * Compute per-pattern learning stats.
 * Only considers live (result=ok) actions with an `id` field.
 */
export function computePatternStats(): PatternStats[] {
  const actions  = readActions().filter(a => a.id && a.result === 'ok')
  const outcomes = readOutcomes()
  const outcomeMap = new Map(outcomes.map(o => [o.actionId, o]))

  // Group by patternKey
  const groups = new Map<string, { entries: ActionEntry[]; outcomes: OutcomeEntry[] }>()

  for (const a of actions) {
    const key = a.patternKey ?? `${a.action}:unknown`
    if (!groups.has(key)) groups.set(key, { entries: [], outcomes: [] })
    const g = groups.get(key)!
    g.entries.push(a)
    const outcome = outcomeMap.get(a.id)
    if (outcome) g.outcomes.push(outcome)
  }

  const stats: PatternStats[] = []

  for (const [key, g] of groups) {
    const verified  = g.outcomes
    const resolved  = verified.filter(o => o.outcome === 'resolved').length
    const persisted = verified.filter(o => o.outcome === 'persisted').length
    const unknown   = verified.filter(o => o.outcome === 'unknown').length
    const vTotal    = resolved + persisted   // exclude unknown from rate calc

    const successRate = vTotal >= 1 ? resolved / vTotal : -1

    const avgConf = g.entries.length
      ? g.entries.reduce((s, e) => s + e.confidence, 0) / g.entries.length
      : 0

    // Require ≥5 resolved/persisted samples before adjusting threshold
    let multiplier = 1.0
    if (vTotal >= 5) {
      if      (successRate >= 0.80) multiplier = 0.95   // high accuracy → slightly lower bar
      else if (successRate >= 0.60) multiplier = 1.00   // good → no change
      else if (successRate >= 0.40) multiplier = 1.10   // mediocre → require more confidence
      else                          multiplier = 1.20   // poor track record → raise bar
    }

    stats.push({
      patternKey:    key,
      action:        g.entries[0]?.action ?? key.split(':')[0],
      total:         g.entries.length,
      resolved,
      persisted,
      unknown,
      successRate,
      avgConfidence: Math.round(avgConf),
      multiplier,
    })
  }

  return stats.sort((a, b) => b.total - a.total)
}

/**
 * Returns the effective confidence threshold for a given pattern key,
 * adjusted by the pattern's historical success rate.
 * Always clamped to [50, 99].
 */
export function getEffectiveThreshold(baseThreshold: number, patternKey: string): number {
  const stats = computePatternStats()
  const s = stats.find(x => x.patternKey === patternKey)
  if (!s) return baseThreshold
  return Math.max(50, Math.min(99, Math.round(baseThreshold * s.multiplier)))
}

/**
 * Build a cooldown map from persisted log entries.
 * Used to restore cooldown state after a server restart.
 * Returns Map<cooldownKey, lastActionTimestamp>.
 */
export function buildPersistedCooldown(cooldownMs: number): Map<string, number> {
  const map = new Map<string, number>()
  const now = Date.now()

  for (const a of readActions()) {
    if (a.result !== 'ok') continue
    const ts = new Date(a.ts).getTime()
    if (now - ts > cooldownMs) continue   // already expired

    const key      = `${a.action}:${a.namespace}/${a.target}`
    const existing = map.get(key) ?? 0
    if (ts > existing) map.set(key, ts)
  }

  return map
}
