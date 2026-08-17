import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  browser: vi.fn(),
  device: vi.fn(),
  refresh: vi.fn(),
  shouldRefresh: vi.fn(),
}))

vi.mock('../src/oauth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/oauth.ts')>()
  return {
    ...actual,
    startBrowserLogin: mocked.browser,
    startDeviceLogin: mocked.device,
    refreshCodexRecord: mocked.refresh,
    shouldRefreshCodexRecord: mocked.shouldRefresh,
  }
})

import { CodexAuthDriver, CODEX_PROVIDER } from '../src/auth.ts'
import { createCodexAuthRecord } from '../src/jwt.ts'
import type { CodexOAuthOptions } from '../src/oauth.ts'

function jwt(claims: Record<string, unknown>): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
}

const options: CodexOAuthOptions = {
  issuer: 'https://auth.example',
  clientId: 'client',
  originator: 'test-originator',
  callbackPorts: [1455],
  loginTimeoutMs: 1_000,
  deviceTimeoutMs: 1_000,
  refreshWindowMs: 300_000,
  refreshIntervalMs: 600_000,
  allowedWorkspaceIds: [],
}

function record() {
  return createCodexAuthRecord({
    idToken: jwt({
      email: 'person@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'workspace-1', chatgpt_plan_type: 'plus', chatgpt_account_is_fedramp: true,
      },
    }),
    accessToken: jwt({}),
    refreshToken: 'refresh',
  })
}

beforeEach(() => { vi.clearAllMocks() })

describe('CodexAuthDriver', () => {
  it('routes both login methods to the native OAuth implementations', async () => {
    const operation = { challenge: { kind: 'browser' }, completion: Promise.resolve({}), cancel: vi.fn() }
    mocked.browser.mockResolvedValueOnce(operation)
    mocked.device.mockResolvedValueOnce(operation)
    const driver = new CodexAuthDriver(options)
    const signal = new AbortController().signal

    expect(driver.id).toBe(CODEX_PROVIDER)
    expect(driver.displayName).toBe('OpenAI Codex')
    expect(driver.methods).toEqual(['browser', 'device'])
    await expect(driver.startLogin('browser', signal)).resolves.toBe(operation)
    await expect(driver.startLogin('device', signal)).resolves.toBe(operation)
    expect(mocked.browser).toHaveBeenCalledWith(options, signal)
    expect(mocked.device).toHaveBeenCalledWith(options, signal)
  })

  it('inspects safe account fields and resolves current authorization', async () => {
    mocked.shouldRefresh.mockReturnValueOnce(false)
    const current = record()
    const driver = new CodexAuthDriver(options)
    expect(driver.inspect(current)).toEqual({ accountId: 'workspace-1', email: 'person@example.com', plan: 'plus' })
    expect(await driver.resolve(current, { forceRefresh: false })).toEqual({
      authorization: {
        headers: {
          authorization: `Bearer ${current.accessToken}`,
          originator: 'test-originator',
          'ChatGPT-Account-ID': 'workspace-1',
          'x-openai-internal-codex-residency': 'us',
        },
      },
    })
  })

  it('rejects a stored record outside the configured workspace before reuse', async () => {
    const driver = new CodexAuthDriver({ ...options, allowedWorkspaceIds: ['workspace-2'] })

    await expect(driver.resolve(record(), { forceRefresh: false })).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_ALLOWED',
    })
    expect(mocked.shouldRefresh).not.toHaveBeenCalled()
    expect(mocked.refresh).not.toHaveBeenCalled()
  })

  it('returns a refreshed record and omits optional account headers', async () => {
    const current = record()
    const refreshed = createCodexAuthRecord({ idToken: jwt({}), accessToken: jwt({ exp: 2_000_000_000 }), refreshToken: 'next' })
    mocked.refresh.mockResolvedValueOnce(refreshed)
    const driver = new CodexAuthDriver(options)
    const signal = new AbortController().signal
    expect(await driver.resolve(current, { forceRefresh: true, signal })).toEqual({
      authorization: { headers: { authorization: `Bearer ${refreshed.accessToken}`, originator: 'test-originator' } },
      record: refreshed,
    })
    expect(mocked.refresh).toHaveBeenCalledWith(options, current, signal)
  })

  it('refreshes when the record policy requires it', async () => {
    const current = record()
    const refreshed = { ...current, accessToken: jwt({ exp: 2_000_000_000 }) }
    mocked.shouldRefresh.mockReturnValueOnce(true)
    mocked.refresh.mockResolvedValueOnce(refreshed)
    const driver = new CodexAuthDriver(options)
    await expect(driver.resolve(current, { forceRefresh: false })).resolves.toMatchObject({ record: refreshed })
  })
})
