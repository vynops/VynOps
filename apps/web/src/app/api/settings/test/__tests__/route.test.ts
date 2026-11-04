import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { authMock, readConfigMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  readConfigMock: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ auth: authMock }))
vi.mock('@/app/api/settings/config/shared', () => ({
  readConfig: readConfigMock,
  writeConfig: vi.fn(),
  appendAuditLog: vi.fn(),
}))

import { POST } from '../route'

describe('POST /api/settings/test Groq key resolution', () => {
  beforeEach(() => {
    authMock.mockResolvedValue({ user: { email: `groq-test-${Date.now()}@example.com` } })
    readConfigMock.mockReturnValue({ ai_api_key: 'saved-ai-api-key' })
    vi.stubEnv('GROQ_API_KEY', 'older-environment-key')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('uses the saved AI key when the reloaded form sends the configured sentinel', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: [{ id: 'openai/gpt-oss-120b' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(new Request('http://localhost/api/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'ai',
        provider: 'groq',
        apiKey: '***configured***',
        model: 'openai/gpt-oss-120b',
      }),
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('https://api.groq.com/openai/v1/models', expect.objectContaining({
      headers: { Authorization: 'Bearer saved-ai-api-key' },
    }))
  })
})