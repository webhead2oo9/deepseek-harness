import { createServer as createNetServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  generatePkce,
  refreshCodexRecord,
  shouldRefreshCodexRecord,
  startBrowserLogin,
  startDeviceLogin,
} from '../src/oauth.ts'
import type { CodexOAuthOptions } from '../src/oauth.ts'
import { createCodexAuthRecord } from '../src/jwt.ts'

const nativeFetch = globalThis.fetch

function jwt(claims: Record<string, unknown>): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
}

function options(overrides: Partial<CodexOAuthOptions> = {}): CodexOAuthOptions {
  return {
    issuer: 'https://auth.example',
    clientId: 'client',
    originator: 'test',
    callbackPorts: [1455],
    loginTimeoutMs: 1_000,
    deviceTimeoutMs: 10_000,
    refreshWindowMs: 300_000,
    refreshIntervalMs: 600_000,
    allowedWorkspaceIds: [],
    ...overrides,
  }
}

function tokenBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-1' } }),
    access_token: jwt({ exp: 2_000_000_000 }),
    refresh_token: 'refresh',
    ...overrides,
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function currentRecord(accountId = 'workspace-1') {
  return createCodexAuthRecord({
    idToken: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
    accessToken: jwt({ exp: 1 }),
    refreshToken: 'old-refresh',
  })
}

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no TCP port')
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
  return address.port
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('OAuth token exchanges', () => {
  it('generates PKCE and builds authorization URLs with optional workspace policy', () => {
    const pkce = generatePkce()
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(pkce.challenge).toBeTruthy()
    const plain = new URL(buildAuthorizationUrl(options(), 'http://localhost:1455/auth/callback', pkce, 'state'))
    expect(plain.searchParams.get('code_challenge')).toBe(pkce.challenge)
    expect(plain.searchParams.has('allowed_workspace_id')).toBe(false)
    const restricted = new URL(buildAuthorizationUrl(
      options({ allowedWorkspaceIds: ['one', 'two'] }), 'http://localhost:1455/auth/callback', pkce, 'state',
    ))
    expect(restricted.searchParams.get('allowed_workspace_id')).toBe('one,two')
  })

  it('exchanges a code and enforces workspace policy', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(tokenBody())))
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    const record = await exchangeAuthorizationCode(
      options({ allowedWorkspaceIds: ['workspace-1'] }), 'code', 'http://localhost/callback', 'verifier', signal,
    )
    expect(record.accountId).toBe('workspace-1')
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.body).toBeInstanceOf(URLSearchParams)
    expect((init.body as URLSearchParams).get('code_verifier')).toBe('verifier')
    expect(init.signal).toBe(signal)

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(tokenBody({
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'other' } }),
    })))))
    await expect(exchangeAuthorizationCode(options({ allowedWorkspaceIds: ['workspace-1'] }), 'code', 'uri', 'v'))
      .rejects.toMatchObject({ code: 'WORKSPACE_NOT_ALLOWED' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(tokenBody({ id_token: jwt({}) })))))
    await expect(exchangeAuthorizationCode(options({ allowedWorkspaceIds: ['workspace-1'] }), 'code', 'uri', 'v'))
      .rejects.toMatchObject({ code: 'WORKSPACE_NOT_ALLOWED' })
  })

  it('classifies token transport, HTTP, JSON, and incomplete responses', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    await expect(exchangeAuthorizationCode(options(), 'code', 'uri', 'v')).rejects.toMatchObject({ code: 'AUTH_TRANSPORT' })
    const controller = new AbortController()
    controller.abort()
    await expect(exchangeAuthorizationCode(options(), 'code', 'uri', 'v', controller.signal))
      .rejects.toMatchObject({ code: 'LOGIN_CANCELLED' })

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ error: { code: 'denied' } }, 400))))
    await expect(exchangeAuthorizationCode(options(), 'code', 'uri', 'v')).rejects.toMatchObject({ code: 'denied' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ code: 'top-level' }, 400))))
    await expect(exchangeAuthorizationCode(options(), 'code', 'uri', 'v')).rejects.toMatchObject({ code: 'top-level' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('not json', { status: 400 }))))
    await expect(exchangeAuthorizationCode(options(), 'code', 'uri', 'v')).rejects.toMatchObject({ code: 'HTTP_400' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json([], 400))))
    await expect(exchangeAuthorizationCode(options(), 'code', 'uri', 'v')).rejects.toMatchObject({ code: 'HTTP_400' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('not json', { status: 200 }))))
    await expect(exchangeAuthorizationCode(options(), 'code', 'uri', 'v')).rejects.toMatchObject({ code: 'INVALID_TOKEN_RESPONSE' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json([]))))
    await expect(exchangeAuthorizationCode(options(), 'code', 'uri', 'v')).rejects.toMatchObject({ code: 'INVALID_TOKEN_RESPONSE' })
    for (const missing of ['id_token', 'access_token', 'refresh_token']) {
      const body = tokenBody()
      Reflect.deleteProperty(body, missing)
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(body))))
      await expect(exchangeAuthorizationCode(options(), 'code', 'uri', 'v')).rejects.toMatchObject({ code: 'INVALID_TOKEN_RESPONSE' })
    }
  })

  it('refreshes partial rotations and classifies every refresh failure family', async () => {
    const current = currentRecord()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ access_token: jwt({ exp: 2_000_000_000 }) }))))
    await expect(refreshCodexRecord(options(), current)).resolves.toMatchObject({ refreshToken: 'old-refresh' })

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    await expect(refreshCodexRecord(options(), current)).rejects.toMatchObject({ code: 'AUTH_TRANSPORT' })
    const controller = new AbortController()
    controller.abort()
    await expect(refreshCodexRecord(options(), current, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })

    for (const [status, body, code] of [
      [401, { error: 'anything' }, 'AUTH_EXPIRED'],
      [400, { error: 'refresh_token_reused' }, 'AUTH_EXPIRED'],
      [400, { error: 'refresh_token_invalidated' }, 'AUTH_EXPIRED'],
      [400, { error: 'ordinary' }, 'ordinary'],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(body, status))))
      await expect(refreshCodexRecord(options(), current)).rejects.toMatchObject({ code })
    }
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({}))))
    await expect(refreshCodexRecord(options(), current)).rejects.toMatchObject({ code: 'INVALID_TOKEN_RESPONSE' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'other' } }),
    }))))
    await expect(refreshCodexRecord(options(), current)).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ access_token: jwt({}) }))))
    await expect(refreshCodexRecord(options({ allowedWorkspaceIds: ['other'] }), current))
      .rejects.toMatchObject({ code: 'WORKSPACE_NOT_ALLOWED' })
  })

  it('uses expiration claims or refresh age for proactive refresh', () => {
    const expiring = currentRecord()
    expect(shouldRefreshCodexRecord(options(), expiring, 1_000)).toBe(true)
    const noExpiry = createCodexAuthRecord({ idToken: jwt({}), accessToken: jwt({}), refreshToken: 'refresh' })
    const refreshed = new Date(noExpiry.refreshedAt).getTime()
    expect(shouldRefreshCodexRecord(options(), noExpiry, refreshed)).toBe(false)
    expect(shouldRefreshCodexRecord(options(), noExpiry, refreshed + 600_000)).toBe(true)
  })
})

describe('device login', () => {
  it('completes after pending polls and supports legacy challenge fields', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ device_auth_id: 'device', usercode: 'ABCD', interval: '1' }))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(json({ authorization_code: 'code', code_verifier: 'verifier' }))
      .mockResolvedValueOnce(json(tokenBody()))
    vi.stubGlobal('fetch', fetchMock)
    const operation = await startDeviceLogin(options(), new AbortController().signal)
    expect(operation.challenge).toMatchObject({ kind: 'device', userCode: 'ABCD' })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(operation.completion).resolves.toMatchObject({ accountId: 'workspace-1' })
  })

  it('accepts numeric/default intervals and rejects invalid challenges', async () => {
    for (const body of [
      null,
      { user_code: 'A' },
      { device_auth_id: 'd' },
      { device_auth_id: 'd', user_code: 'A', interval: 0 },
      { device_auth_id: 'd', user_code: 'A', interval: 'nope' },
    ]) {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(body))))
      await expect(startDeviceLogin(options(), new AbortController().signal))
        .rejects.toMatchObject({ code: 'INVALID_DEVICE_RESPONSE' })
    }
    for (const interval of [undefined, 2]) {
      const controller = new AbortController()
      const body = { device_auth_id: 'd', user_code: 'A', ...(interval === undefined ? {} : { interval }) }
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(json(body))
        .mockImplementationOnce(() => new Promise((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        })))
      const operation = await startDeviceLogin(options(), controller.signal)
      controller.abort()
      await expect(operation.completion).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' })
    }
  })

  it('classifies challenge and polling transport or provider failures', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    await expect(startDeviceLogin(options(), new AbortController().signal)).rejects.toMatchObject({ code: 'AUTH_TRANSPORT' })
    const aborted = new AbortController()
    aborted.abort()
    await expect(startDeviceLogin(options(), aborted.signal)).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ error: 'denied' }, 401))))
    await expect(startDeviceLogin(options(), new AbortController().signal)).rejects.toMatchObject({ code: 'denied' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('bad json', { status: 200 }))))
    await expect(startDeviceLogin(options(), new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_DEVICE_RESPONSE' })

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ device_auth_id: 'd', user_code: 'A', interval: 1 }))
      .mockRejectedValueOnce(new Error('poll offline')))
    const transport = await startDeviceLogin(options(), new AbortController().signal)
    await expect(transport.completion).rejects.toMatchObject({ code: 'AUTH_TRANSPORT' })

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ device_auth_id: 'd', user_code: 'A', interval: 1 }))
      .mockResolvedValueOnce(json({ error: 'blocked' }, 500)))
    const provider = await startDeviceLogin(options(), new AbortController().signal)
    await expect(provider.completion).rejects.toMatchObject({ code: 'blocked' })
  })

  it('rejects invalid authorization-code responses and supports quiescent cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ device_auth_id: 'd', user_code: 'A', interval: 1 }))
      .mockResolvedValueOnce(json({ authorization_code: 'code' })))
    const invalid = await startDeviceLogin(options(), new AbortController().signal)
    await expect(invalid.completion).rejects.toMatchObject({ code: 'INVALID_DEVICE_RESPONSE' })

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ device_auth_id: 'd', user_code: 'A', interval: 1 }))
      .mockResolvedValueOnce(new Response('', { status: 404 })))
    const cancelled = await startDeviceLogin(options(), new AbortController().signal)
    await cancelled.cancel('custom reason')
    await cancelled.cancel()
    await expect(cancelled.completion).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' })
  })

  it('times out when the device code is not approved', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ device_auth_id: 'd', user_code: 'A', interval: 5 }))
      .mockResolvedValue(new Response('', { status: 403 })))
    const operation = await startDeviceLogin(options({ deviceTimeoutMs: 1 }), new AbortController().signal)
    const completion = expect(operation.completion).rejects.toMatchObject({ code: 'LOGIN_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(1)
    await completion
  })

  it('observes cancellation that arrives immediately before a poll delay', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ device_auth_id: 'd', user_code: 'A', interval: 1 }))
      .mockImplementationOnce(() => {
        controller.abort()
        return Promise.resolve(new Response('', { status: 403 }))
      }))
    const operation = await startDeviceLogin(options(), controller.signal)
    await expect(operation.completion).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' })
  })
})

describe('browser login', () => {
  it('serves callback validation and completes a browser exchange', async () => {
    const port = await freePort()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(tokenBody()))))
    const operation = await startBrowserLogin(options({ callbackPorts: [port] }), new AbortController().signal)
    if (operation.challenge.kind !== 'browser') throw new Error('expected browser challenge')
    const authorization = new URL(operation.challenge.authorizationUrl)
    const redirect = authorization.searchParams.get('redirect_uri')!
    const state = authorization.searchParams.get('state')!
    expect((await nativeFetch(`http://localhost:${port}/wrong`)).status).toBe(404)
    expect((await nativeFetch(`${redirect}?state=wrong&code=code`)).status).toBe(400)
    expect((await nativeFetch(`${redirect}?state=${state}&code=code`)).status).toBe(200)
    await expect(operation.completion).resolves.toMatchObject({ accountId: 'workspace-1' })
  })

  it('rejects provider errors, missing codes, exchange failures, cancellation, and timeout', async () => {
    const providerPort = await freePort()
    let operation = await startBrowserLogin(options({ callbackPorts: [providerPort] }), new AbortController().signal)
    let authorization = new URL((operation.challenge as { authorizationUrl: string }).authorizationUrl)
    let redirect = authorization.searchParams.get('redirect_uri')!
    let state = authorization.searchParams.get('state')!
    let rejected = expect(operation.completion).rejects.toMatchObject({ code: 'LOGIN_REJECTED' })
    expect((await nativeFetch(`${redirect}?state=${state}&error=access_denied`)).status).toBe(400)
    await rejected

    const missingPort = await freePort()
    operation = await startBrowserLogin(options({ callbackPorts: [missingPort] }), new AbortController().signal)
    authorization = new URL((operation.challenge as { authorizationUrl: string }).authorizationUrl)
    redirect = authorization.searchParams.get('redirect_uri')!
    state = authorization.searchParams.get('state')!
    rejected = expect(operation.completion).rejects.toMatchObject({ code: 'INVALID_CALLBACK' })
    expect((await nativeFetch(`${redirect}?state=${state}`)).status).toBe(400)
    await rejected

    const exchangePort = await freePort()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ error: 'denied' }, 400))))
    operation = await startBrowserLogin(options({ callbackPorts: [exchangePort] }), new AbortController().signal)
    authorization = new URL((operation.challenge as { authorizationUrl: string }).authorizationUrl)
    redirect = authorization.searchParams.get('redirect_uri')!
    state = authorization.searchParams.get('state')!
    rejected = expect(operation.completion).rejects.toMatchObject({ code: 'denied' })
    expect((await nativeFetch(`${redirect}?state=${state}&code=code`)).status).toBe(500)
    await rejected

    const cancelPort = await freePort()
    operation = await startBrowserLogin(options({ callbackPorts: [cancelPort] }), new AbortController().signal)
    await operation.cancel()
    await expect(operation.completion).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' })

    vi.useFakeTimers()
    const timeoutPort = await freePort()
    operation = await startBrowserLogin(options({ callbackPorts: [timeoutPort], loginTimeoutMs: 1 }), new AbortController().signal)
    rejected = expect(operation.completion).rejects.toMatchObject({ code: 'LOGIN_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(1)
    await rejected
  })

  it('rejects an already-aborted service and falls through occupied callback ports', async () => {
    const occupied = createNetServer()
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '127.0.0.1', resolve)
    })
    const address = occupied.address()
    if (address === null || typeof address === 'string') throw new Error('occupied server has no port')
    const available = await freePort()
    const controller = new AbortController()
    controller.abort()
    const operation = await startBrowserLogin(options({ callbackPorts: [address.port, available] }), controller.signal)
    await expect(operation.completion).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' })
    await new Promise<void>((resolve, reject) => {
      occupied.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
  })

  it('rejects a concurrent duplicate callback while the first exchange is pending', async () => {
    const port = await freePort()
    let release!: () => void
    const exchange = new Promise<Response>((resolve) => { release = () => { resolve(json(tokenBody())) } })
    vi.stubGlobal('fetch', vi.fn(() => exchange))
    const operation = await startBrowserLogin(options({ callbackPorts: [port] }), new AbortController().signal)
    const authorization = new URL((operation.challenge as { authorizationUrl: string }).authorizationUrl)
    const redirect = authorization.searchParams.get('redirect_uri')!
    const state = authorization.searchParams.get('state')!
    const first = nativeFetch(`${redirect}?state=${state}&code=code`)
    await vi.waitFor(() => { expect((globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalled() })
    expect((await nativeFetch(`${redirect}?state=${state}&code=code`)).status).toBe(409)
    release()
    expect((await first).status).toBe(200)
    await expect(operation.completion).resolves.toBeDefined()
  })

  it('aborts a pending token exchange before timeout completion settles', async () => {
    const port = await freePort()
    let exchangeSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      exchangeSignal = init?.signal as AbortSignal | undefined
      return new Promise<Response>((_resolve, reject) => {
        exchangeSignal?.addEventListener('abort', () => { reject(new Error('exchange aborted')) }, { once: true })
      })
    }))
    const operation = await startBrowserLogin(
      options({ callbackPorts: [port], loginTimeoutMs: 1_000 }),
      new AbortController().signal,
    )
    const completion = expect(operation.completion).rejects.toMatchObject({ code: 'LOGIN_TIMEOUT' })
    const authorization = new URL((operation.challenge as { authorizationUrl: string }).authorizationUrl)
    const redirect = authorization.searchParams.get('redirect_uri')!
    const state = authorization.searchParams.get('state')!
    const callback = nativeFetch(`${redirect}?state=${state}&code=code`)
    await vi.waitFor(() => { expect(exchangeSignal).toBeDefined() })

    await completion
    expect(exchangeSignal?.aborted).toBe(true)
    expect((await callback).status).toBe(500)
  })

  it('reports callback-port exhaustion and non-collision bind errors', async () => {
    const occupied = createNetServer()
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '127.0.0.1', resolve)
    })
    const address = occupied.address()
    if (address === null || typeof address === 'string') throw new Error('occupied server has no port')
    await expect(startBrowserLogin(options({ callbackPorts: [address.port] }), new AbortController().signal))
      .rejects.toMatchObject({ code: 'CALLBACK_PORT_IN_USE' })
    await new Promise<void>((resolve, reject) => {
      occupied.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
    await expect(startBrowserLogin(options({ callbackPorts: [-1] }), new AbortController().signal)).rejects.toBeDefined()
  })
})
