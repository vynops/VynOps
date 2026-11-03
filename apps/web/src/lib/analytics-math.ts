export function estimateBudgetExhaustionHours(
  burnRate: number | null,
  budgetUsedPct: number | null,
  windowDays = 30,
): number | null {
  if (burnRate === null || !Number.isFinite(burnRate) || burnRate <= 0 || budgetUsedPct === null || !Number.isFinite(budgetUsedPct) || windowDays <= 0) return null
  const usedFraction = Math.min(1, Math.max(0, budgetUsedPct / 100))
  return windowDays * 24 * (1 - usedFraction) / burnRate
}

export function hasCompleteDailyWindow(
  points: { ts: number; value: number }[],
  windowDays = 30,
  now = Date.now(),
  maxGapHours = 36,
): boolean {
  if (!Number.isFinite(windowDays) || windowDays <= 0 || !Number.isFinite(now) || maxGapHours <= 0) return false
  const validPoints = points
    .filter(point => Number.isFinite(point.ts) && Number.isFinite(point.value))
    .sort((a, b) => a.ts - b.ts)
  const dayMs = 86_400_000
  const maxGapMs = maxGapHours * 3_600_000
  if (validPoints.length < windowDays + 1 || validPoints[0]!.ts > now - windowDays * dayMs + 300_000) return false
  if (now - validPoints[validPoints.length - 1]!.ts > maxGapMs) return false
  return validPoints.every((point, index) => index === 0 || point.ts - validPoints[index - 1]!.ts <= maxGapMs)
}
