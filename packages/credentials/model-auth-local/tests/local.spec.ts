import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelAuthError, modelAuthLoginAttemptId, modelAuthProviderId } from '@deepseek-ai/dsh-model-auth'
import type { ModelAuthDriver } from '@deepseek-ai/dsh-model-auth'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { LocalModelAuth, parseAuthDocument, resolveSpec } from '../src/index.ts'
import * as LocalInvariant from '../src/invariant.ts'

const PROVIDER = modelAuthProviderId('test-provider')
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function setup(initial?: string): Promise<{ ctx: Context; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-model-auth-'))
  const path = join(dir, '.model-auth.json')
  if (initial !== undefined) await writeFile(path, initial, 'utf8')
  const ctx = new Context()
  const fiber = ctx.plugin(LocalModelAuth, { path })
  try {
    await fiber
  } catch (error) {
    await fiber.dispose()
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  cleanups.push(async () => { await fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  return { ctx, path }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function driver(record: unknown = { token: 'secret', account: 'account-1' }): ModelAuthDriver {
  return {
    id: PROVIDER,
    displayName: 'Test Provider',
    methods: ['browser'],
    startLogin: () => Promise.resolve({
      challenge: { kind: 'browser', authorizationUrl: 'https://login.example/' },
      completion: Promise.resolve(record),
      cancel: () => Promise.resolve(),
    }),
    inspect: (value) => {
      if (typeof value !== 'object' || value === null || !('account' in value)) {
        throw new ModelAuthError('bad record', 'INVALID_RECORD')
      }
      return { accountId: String(value.account) }
    },
    resolve: (value, options) => Promise.resolve({
      authorization: { headers: { authorization: `Bearer ${(value as { token: string }).token}` } },
      ...options.forceRefresh ? { record: { ...(value as object), token: 'rotated' } } : {},
    }),
  }
}

describe('local model authentication', () => {
  it('persists login, returns Host-only authorization, refreshes, and logs out', async () => {
    const { ctx, path } = await setup()
    const disposeDriver = (ctx.modelAuth as LocalModelAuth).register(driver())
    cleanups.push(disposeDriver)
    expect(await ctx.modelAuth.list()).toMatchObject([{ provider: PROVIDER, state: 'signed-out' }])
    expect(await ctx.modelAuth.status(PROVIDER)).toMatchObject({ state: 'signed-out', methods: ['browser'] })
    const challenge = await ctx.modelAuth.beginLogin(PROVIDER, 'browser')
    expect(challenge).toMatchObject({ kind: 'browser', authorizationUrl: 'https://login.example/' })
    await vi.waitFor(async () => {
      expect(await ctx.modelAuth.status(PROVIDER)).toMatchObject({
        state: 'signed-in', account: { accountId: 'account-1' },
      })
    })
    expect(await ctx.modelAuth.resolve(PROVIDER)).toEqual({ headers: { authorization: 'Bearer secret' } })
    expect(await ctx.modelAuth.refresh(PROVIDER)).toEqual({ headers: { authorization: 'Bearer secret' } })
    expect(await ctx.modelAuth.resolve(PROVIDER)).toEqual({ headers: { authorization: 'Bearer rotated' } })
    expect(await readFile(path, 'utf8')).toContain('rotated')
    await ctx.modelAuth.logout(PROVIDER)
    expect(await ctx.modelAuth.status(PROVIDER)).toMatchObject({ state: 'signed-out' })
  })

  it('contains login failures in safe status and rejects missing authentication', async () => {
    const { ctx } = await setup()
    ctx.modelAuth.register({
      ...driver(),
      startLogin: () => Promise.resolve({
        challenge: { kind: 'browser', authorizationUrl: 'https://login.example/' },
        completion: Promise.reject(new ModelAuthError('sign-in denied', 'DENIED')),
        cancel: () => Promise.resolve(),
      }),
    })
    await ctx.modelAuth.beginLogin(PROVIDER, 'browser')
    await vi.waitFor(async () => { expect(await ctx.modelAuth.status(PROVIDER)).toMatchObject({ state: 'error', error: 'sign-in denied' }) })
    await expect(ctx.modelAuth.resolve(PROVIDER)).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' })
  })

  it('rejects malformed durable envelopes', () => {
    expect(() => parseAuthDocument('not json', 'auth.json')).toThrow(/invalid JSON/)
    expect(() => parseAuthDocument('null', 'auth.json')).toThrow(/must contain an object/)
    expect(() => parseAuthDocument('[]', 'auth.json')).toThrow(/must contain an object/)
    expect(() => parseAuthDocument('{"version":1,"providers":{}}', 'auth.json')).toThrow(/version/)
    expect(() => parseAuthDocument('{"version":0,"providers":[],"extra":1}', 'auth.json')).toThrow(/unknown/)
    expect(() => parseAuthDocument('{"version":0,"providers":null}', 'auth.json')).toThrow(/must be an object/)
    expect(() => parseAuthDocument('{"version":0,"providers":{"BAD_ID":{}}}', 'auth.json')).toThrow(/must match/)
    expect(parseAuthDocument('{"version":0,"providers":{"valid-id":{"x":1}}}', 'auth.json'))
      .toEqual({ version: 0, providers: { 'valid-id': { x: 1 } } })
  })

  it('refuses duplicate drivers and unsupported login methods', async () => {
    const { ctx } = await setup()
    ctx.modelAuth.register(driver())
    expect(() => ctx.modelAuth.register(driver())).toThrow(/already registered/)
    await expect(ctx.modelAuth.beginLogin(PROVIDER, 'device')).rejects.toMatchObject({ code: 'UNSUPPORTED_LOGIN_METHOD' })
  })

  it('resolves explicit and Harness-home document locations', () => {
    expect(resolveSpec({ path: './auth.json' }).filename).toMatch(/auth\.json$/)
    expect(resolveSpec({ dshHome: './private-home' }).filename).toMatch(/private-home[\\/]\.model-auth\.json$/)
  })

  it('rejects absent providers, invalid drivers, and operations after disposal', async () => {
    const { ctx } = await setup()
    expect(await ctx.modelAuth.list()).toEqual([])
    await expect(ctx.modelAuth.status(PROVIDER)).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    expect(() => ctx.modelAuth.register({ ...driver(), methods: [] })).toThrow(/unique login methods/)
    expect(() => ctx.modelAuth.register({ ...driver(), methods: ['browser', 'browser'] })).toThrow(/unique login methods/)
    const service = ctx.modelAuth
    await ctx.fiber.dispose()
    expect(() => service.register(driver())).toThrow(/disposed/)
    await expect(service.beginLogin(PROVIDER, 'browser')).rejects.toMatchObject({ code: 'DISPOSED' })
  })

  it('exposes device login state and cancellation failures safely', async () => {
    const { ctx } = await setup()
    const completion = deferred<unknown>()
    const cancel = vi.fn(() => { completion.reject('cancelled'); return Promise.resolve() })
    ctx.modelAuth.register({
      ...driver(),
      methods: ['device'],
      startLogin: () => Promise.resolve({
        challenge: {
          kind: 'device', verificationUrl: 'https://login.example/device', userCode: 'ABCD', expiresAt: '2030-01-01T00:00:00Z',
        },
        completion: completion.promise,
        cancel,
      }),
    })
    const challenge = await ctx.modelAuth.beginLogin(PROVIDER, 'device')
    expect(challenge).toMatchObject({ kind: 'device', verificationUrl: 'https://login.example/device', userCode: 'ABCD' })
    expect(await ctx.modelAuth.status(PROVIDER)).toMatchObject({
      state: 'signing-in',
      challenge: { attemptId: challenge.attemptId, userCode: 'ABCD' },
    })
    await expect(ctx.modelAuth.beginLogin(PROVIDER, 'device')).rejects.toMatchObject({ code: 'LOGIN_ACTIVE' })
    await ctx.modelAuth.cancelLogin(challenge.attemptId)
    expect(cancel).toHaveBeenCalledWith('model auth login cancelled')
    expect(await ctx.modelAuth.status(PROVIDER)).toMatchObject({ state: 'error', error: 'model authentication failed' })
    await expect(ctx.modelAuth.cancelLogin(challenge.attemptId)).rejects.toMatchObject({ code: 'NO_LOGIN' })
  })

  it('settles a live login before driver disposal', async () => {
    const { ctx } = await setup()
    const completion = deferred<unknown>()
    const cancel = vi.fn(() => { completion.reject(new Error('disposed login')); return Promise.resolve() })
    const dispose = (ctx.modelAuth as LocalModelAuth).register({
      ...driver(),
      startLogin: () => Promise.resolve({
        challenge: { kind: 'browser', authorizationUrl: 'https://login.example/' },
        completion: completion.promise,
        cancel,
      }),
    })
    await ctx.modelAuth.beginLogin(PROVIDER, 'browser')
    await dispose()
    expect(cancel).toHaveBeenCalledWith(`model auth provider "${PROVIDER}" was disposed`)
    expect(ctx.modelAuth.hasProvider(PROVIDER)).toBe(false)
  })

  it('cancels login startup before driver disposal returns', async () => {
    const { ctx } = await setup()
    const started = deferred<AbortSignal>()
    const operation = deferred<Awaited<ReturnType<ModelAuthDriver['startLogin']>>>()
    const cancel = vi.fn(() => Promise.resolve())
    const dispose = (ctx.modelAuth as LocalModelAuth).register({
      ...driver(),
      startLogin: (_method, signal) => {
        started.resolve(signal)
        return operation.promise
      },
    })
    const login = ctx.modelAuth.beginLogin(PROVIDER, 'browser')
    const signal = await started.promise
    const disposing = dispose()
    expect(signal.aborted).toBe(true)
    operation.resolve({
      challenge: { kind: 'browser', authorizationUrl: 'https://login.example/' },
      completion: new Promise(() => {}),
      cancel,
    })

    await disposing
    await expect(login).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' })
    expect(cancel).toHaveBeenCalledWith(`model auth provider "${PROVIDER}" was disposed`)
    expect(ctx.modelAuth.hasProvider(PROVIDER)).toBe(false)
  })

  it('cancels active provider resources during service teardown', async () => {
    const { ctx } = await setup()
    const service = ctx.modelAuth as LocalModelAuth
    const lifecycle = service[Service.init]()
    const initialized = await lifecycle.next()
    if (initialized.done) throw new Error('model-auth lifecycle produced no teardown')
    const completion = deferred<unknown>()
    const cancel = vi.fn(() => { completion.reject(new Error('service disposed')); return Promise.resolve() })
    service.register({
      ...driver(),
      startLogin: () => Promise.resolve({
        challenge: { kind: 'browser', authorizationUrl: 'https://login.example/' },
        completion: completion.promise,
        cancel,
      }),
    })
    await service.beginLogin(PROVIDER, 'browser')

    await initialized.value()
    expect(cancel).toHaveBeenCalledWith('model-auth service disposed')
    expect(service.hasProvider(PROVIDER)).toBe(false)
  })

  it('cancels login startup before service teardown returns', async () => {
    const { ctx } = await setup()
    const service = ctx.modelAuth as LocalModelAuth
    const lifecycle = service[Service.init]()
    const initialized = await lifecycle.next()
    if (initialized.done) throw new Error('model-auth lifecycle produced no teardown')
    const started = deferred<AbortSignal>()
    const operation = deferred<Awaited<ReturnType<ModelAuthDriver['startLogin']>>>()
    const cancel = vi.fn(() => Promise.resolve())
    service.register({
      ...driver(),
      startLogin: (_method, signal) => {
        started.resolve(signal)
        return operation.promise
      },
    })
    const login = service.beginLogin(PROVIDER, 'browser')
    const signal = await started.promise
    const disposing = initialized.value()
    expect(signal.aborted).toBe(true)
    operation.resolve({
      challenge: { kind: 'browser', authorizationUrl: 'https://login.example/' },
      completion: new Promise(() => {}),
      cancel,
    })

    await disposing
    await expect(login).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' })
    expect(cancel).toHaveBeenCalledWith('model-auth service disposed')
    expect(service.hasProvider(PROVIDER)).toBe(false)
  })

  it('rejects a live-attempt index that lost its owned record', async () => {
    const { ctx } = await setup()
    const service = ctx.modelAuth as LocalModelAuth
    const internal = service as unknown as {
      liveAttempt(attemptId: ReturnType<typeof modelAuthLoginAttemptId>): unknown
    }
    expect(() => internal.liveAttempt(modelAuthLoginAttemptId('missing'))).toThrow(
      expect.objectContaining({ code: 'INVARIANT' }),
    )
  })

  it('uses driver logout, treats an absent record as a no-op, and cancels active login', async () => {
    const { ctx } = await setup()
    const providerLogout = vi.fn(() => Promise.resolve())
    ctx.modelAuth.register({ ...driver(), logout: providerLogout })
    await ctx.modelAuth.logout(PROVIDER)
    expect(providerLogout).not.toHaveBeenCalled()

    await ctx.modelAuth.beginLogin(PROVIDER, 'browser')
    await vi.waitFor(async () => { expect(await ctx.modelAuth.status(PROVIDER)).toMatchObject({ state: 'signed-in' }) })
    const signal = new AbortController().signal
    await ctx.modelAuth.logout(PROVIDER, signal)
    expect(providerLogout).toHaveBeenCalledWith(expect.objectContaining({ token: 'secret' }), signal)

    const pending = deferred<unknown>()
    const cancel = vi.fn(() => { pending.reject(new Error('logout cancelled login')); return Promise.resolve() })
    ctx.modelAuth.register({
      ...driver(), id: modelAuthProviderId('second-provider'),
      startLogin: () => Promise.resolve({
        challenge: { kind: 'browser', authorizationUrl: 'https://login.example/' }, completion: pending.promise, cancel,
      }),
    })
    const second = modelAuthProviderId('second-provider')
    await ctx.modelAuth.beginLogin(second, 'browser')
    await ctx.modelAuth.logout(second)
    expect(cancel).toHaveBeenCalledWith('model auth logout cancelled the active login')
  })

  it('reports invalid stored and newly completed records without exposing values', async () => {
    const stored = await setup('{"version":0,"providers":{"test-provider":{"bad":true}}}\n')
    stored.ctx.modelAuth.register(driver())
    expect(await stored.ctx.modelAuth.status(PROVIDER)).toMatchObject({ state: 'error', error: 'bad record' })

    const { ctx } = await setup()
    const circular: Record<string, unknown> = { account: 'safe' }
    circular.self = circular
    ctx.modelAuth.register(driver(circular))
    await ctx.modelAuth.beginLogin(PROVIDER, 'browser')
    await vi.waitFor(async () => {
      expect(await ctx.modelAuth.status(PROVIDER)).toMatchObject({ state: 'error', error: /not JSON-serializable/ })
    })
  })

  it('serializes concurrent authorization and clones returned headers', async () => {
    const { ctx } = await setup()
    const gate = deferred<undefined>()
    let calls = 0
    ctx.modelAuth.register({
      ...driver(),
      resolve: async (_record, options) => {
        calls += 1
        if (calls === 1) await gate.promise
        return {
          authorization: { headers: { authorization: options.forceRefresh ? 'fresh' : 'current' } },
          ...options.forceRefresh ? { record: { token: 'next', account: 'account-1' } } : {},
        }
      },
    })
    await ctx.modelAuth.beginLogin(PROVIDER, 'browser')
    await vi.waitFor(async () => { expect((await ctx.modelAuth.status(PROVIDER)).state).toBe('signed-in') })
    const first = ctx.modelAuth.resolve(PROVIDER)
    const second = ctx.modelAuth.refresh(PROVIDER, new AbortController().signal)
    gate.resolve(undefined)
    const firstHeaders = await first
    expect(firstHeaders).toEqual({ headers: { authorization: 'current' } })
    expect(await second).toEqual({ headers: { authorization: 'fresh' } })
    ;(firstHeaders.headers as Record<string, string>).authorization = 'mutated'
    expect(await ctx.modelAuth.resolve(PROVIDER)).toEqual({ headers: { authorization: 'current' } })
  })

  it('fails startup for unreadable paths and malformed existing files', async () => {
    const badPath = new Context().plugin(LocalModelAuth, { path: '\u0000' })
    await expect(badPath).rejects.toBeDefined()
    await badPath.dispose()
    await expect(setup('broken')).rejects.toThrow(/invalid JSON/)
  })

  it('registers its invariant ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(LocalInvariant)
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-model-auth-local', () => undefined)).toThrow(/already registered/)
    await ctx.fiber.dispose()
  })
})
