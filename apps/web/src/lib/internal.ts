// Server-to-server calls (autonomous loop, plan auto-approve) authenticate with CRON_SECRET, which server.mjs guarantees at boot.

export const INTERNAL_BASE = `http://127.0.0.1:${process.env.PORT || 3030}`

// Routes the proxy lets through when the caller presents CRON_SECRET; each route still enforces its own checks.
const INTERNAL_PATHS = [
  /^\/api\/incidents\/(worker|auto-escalate)$/,
  /^\/api\/automation\/(auto-trigger|execute)$/,
  /^\/api\/autonomous\/(loop|plan)$/,
  /^\/api\/autonomous\/plan\/[^/]+\/approve$/,
  /^\/api\/ai\/insights$/,
]

export function isInternalPath(pathname: string): boolean {
  return INTERNAL_PATHS.some(re => re.test(pathname))
}

export function hasInternalSecret(headers: Headers): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return headers.get('x-internal-secret') === secret || headers.get('authorization') === `Bearer ${secret}`
}

/** Sends both header forms because existing routes check one or the other. */
export function internalHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const secret = process.env.CRON_SECRET ?? ''
  return { ...extra, 'x-internal-secret': secret, Authorization: `Bearer ${secret}` }
}

export async function internalFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 30_000, headers, ...rest } = init
  return fetch(`${INTERNAL_BASE}${path}`, {
    cache: 'no-store',
    ...rest,
    headers: internalHeaders(headers as Record<string, string> | undefined),
    signal: AbortSignal.timeout(timeoutMs),
  })
}
