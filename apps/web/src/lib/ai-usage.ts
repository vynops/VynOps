import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export type AIUsageSource = 'copilot' | 'autonomous_plan'
export type AIUsageStatus = 'success' | 'error'

export interface AIUsageEvent {
  source: AIUsageSource
  provider: string
  model: string
  status: AIUsageStatus
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  durationMs?: number
  statusCode?: number
  errorType?: 'rate_limit' | 'provider_error'
  retryAfterSecs?: number
  rateLimitUnit?: string
  rateLimitLimit?: number
  rateLimitUsed?: number
  rateLimitRequested?: number
  providerAttempts?: number
}

const DATA_DIR = join(process.cwd(), 'data')
const USAGE_FILE = join(DATA_DIR, 'ai-usage.jsonl')
const MAX_USAGE_ENTRIES = 2000

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function errorChain(error: unknown): Record<string, any>[] {
  const chain: Record<string, any>[] = []
  const pending: unknown[] = [error]
  const seen = new Set<unknown>()

  while (pending.length && chain.length < 8) {
    const current = pending.shift()
    if (!current || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    const item = current as Record<string, any>
    chain.push(item)
    if (item.cause) pending.push(item.cause)
    if (item.lastError) pending.push(item.lastError)
    if (Array.isArray(item.errors) && item.errors.length) pending.push(item.errors[item.errors.length - 1])
  }

  return chain
}

function headerValue(headers: any, name: string): unknown {
  if (typeof headers?.get === 'function') return headers.get(name)
  if (!headers || typeof headers !== 'object') return undefined
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name)
  return key ? headers[key] : undefined
}

function parseRetrySeconds(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const match = String(value).match(/^(\d+(?:\.\d+)?)\s*s$/i)
  return match ? Math.ceil(Number(match[1])) : undefined
}

export function getAIUsageFailure(error: unknown): Omit<AIUsageEvent, 'source' | 'provider' | 'model' | 'durationMs' | 'promptTokens' | 'completionTokens' | 'totalTokens'> {
  const chain = errorChain(error)
  const messages = chain.map(item => typeof item.message === 'string' ? item.message : '').filter(Boolean)
  const message = messages.join(' ')
  const statusCode = chain.map(item => finiteNumber(item.statusCode ?? item.status)).find(value => value !== undefined)
  const rateLimitMatch = message.match(/on\s+(tokens per minute|requests per minute|tokens per day|requests per day)\s+\([^)]*\):\s*Limit\s+([\d,]+),\s*Used\s+([\d,]+),\s*Requested\s+([\d,]+)/i)
  const retryFromMessage = message.match(/try again in\s+([\d.]+)\s*s/i)?.[1]
  const headers = chain.map(item => item.responseHeaders ?? item.headers).find(Boolean)
  const retryAfterSecs = parseRetrySeconds(retryFromMessage ?? headerValue(headers, 'retry-after'))
  const errorType = statusCode === 429 || /rate[ _-]?limit|rate_limit_exceeded/i.test(message)
    ? 'rate_limit'
    : 'provider_error'

  return {
    status: 'error',
    ...(statusCode !== undefined ? { statusCode } : {}),
    errorType,
    ...(retryAfterSecs !== undefined ? { retryAfterSecs } : {}),
    ...(rateLimitMatch ? {
      rateLimitUnit: rateLimitMatch[1]!.toLowerCase().replace(/ /g, '_'),
      rateLimitLimit: Number(rateLimitMatch[2]!.replace(/,/g, '')),
      rateLimitUsed: Number(rateLimitMatch[3]!.replace(/,/g, '')),
      rateLimitRequested: Number(rateLimitMatch[4]!.replace(/,/g, '')),
    } : {}),
    ...(chain[0]?.errors?.length ? { providerAttempts: chain[0].errors.length } : {}),
  }
}

export interface AIUsageSummary {
  requests: number
  successfulRequests: number
  failedRequests: number
  rateLimitErrors: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export function summarizeAIUsage(entries: readonly Record<string, any>[]): AIUsageSummary {
  return entries.reduce<AIUsageSummary>((summary, entry) => {
    summary.requests++
    if (entry.status === 'error') summary.failedRequests++
    else summary.successfulRequests++
    if (entry.errorType === 'rate_limit') summary.rateLimitErrors++
    summary.promptTokens += finiteNumber(entry.promptTokens) ?? 0
    summary.completionTokens += finiteNumber(entry.completionTokens) ?? 0
    summary.totalTokens += finiteNumber(entry.totalTokens) ?? 0
    return summary
  }, {
    requests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    rateLimitErrors: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  })
}

export function summarizeAIUsageBySource(entries: readonly Record<string, any>[]) {
  return {
    copilot: summarizeAIUsage(entries.filter(entry => entry.source !== 'autonomous_plan')),
    autonomousPlan: summarizeAIUsage(entries.filter(entry => entry.source === 'autonomous_plan')),
  }
}

export function recordAIUsage(event: AIUsageEvent): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    const record = {
      ts: new Date().toISOString(),
      source: event.source,
      provider: event.provider.slice(0, 40),
      model: event.model.slice(0, 120),
      status: event.status,
      ...(['promptTokens', 'completionTokens', 'totalTokens', 'durationMs', 'statusCode', 'retryAfterSecs', 'rateLimitLimit', 'rateLimitUsed', 'rateLimitRequested', 'providerAttempts'] as const)
        .reduce<Record<string, number>>((values, key) => {
          const value = finiteNumber(event[key])
          if (value !== undefined) values[key] = value
          return values
        }, {}),
      ...(event.errorType ? { errorType: event.errorType } : {}),
      ...(event.rateLimitUnit ? { rateLimitUnit: event.rateLimitUnit.slice(0, 40) } : {}),
    }
    appendFileSync(USAGE_FILE, JSON.stringify(record) + '\n', 'utf8')

    const lines = readFileSync(USAGE_FILE, 'utf8').split('\n').filter(Boolean)
    if (lines.length > MAX_USAGE_ENTRIES) {
      writeFileSync(USAGE_FILE, lines.slice(-MAX_USAGE_ENTRIES).join('\n') + '\n', 'utf8')
    }
  } catch {
    console.error('[ai/usage] Failed to record usage event')
  }
}