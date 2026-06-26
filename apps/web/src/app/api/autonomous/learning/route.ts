import { NextResponse }     from 'next/server'
import { auth }             from '@/lib/auth'
import { computePatternStats, readOutcomes } from '@/lib/autonomousLearning'
import { readConfig }       from '@/app/api/settings/config/shared'

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const cfg           = readConfig() as any
  const baseThreshold = cfg.autonomous_confidence_threshold ?? 80

  const patterns = computePatternStats()
  const outcomes = readOutcomes()

  const totalVerified = outcomes.length
  const resolved      = outcomes.filter(o => o.outcome === 'resolved').length
  const persisted     = outcomes.filter(o => o.outcome === 'persisted').length
  const overallRate   = (resolved + persisted) > 0
    ? resolved / (resolved + persisted)
    : null

  return NextResponse.json({
    baseThreshold,
    overallSuccessRate: overallRate,
    totalVerified,
    resolved,
    persisted,
    hasEnoughData: totalVerified >= 5,
    patterns: patterns.map(s => ({
      ...s,
      effectiveThreshold: Math.max(50, Math.min(99, Math.round(baseThreshold * s.multiplier))),
      successRateDisplay: s.successRate === -1 ? null : Math.round(s.successRate * 100),
    })),
  })
}
