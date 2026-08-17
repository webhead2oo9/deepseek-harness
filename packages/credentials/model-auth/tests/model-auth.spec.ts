import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import ModelAuth, {
  ModelAuthError,
  modelAuthLoginAttemptId,
  modelAuthProviderId,
} from '../src/index.ts'
import type {
  ModelAuthDriver,
  ModelAuthLoginMethod,
  ModelAuthorization,
} from '../src/index.ts'
import type { ModelAuthProviderId, ModelAuthProviderStatus } from '../src/types.ts'
import * as ModelAuthInvariant from '../src/invariant.ts'

const PROVIDER = modelAuthProviderId('openai-codex')

class TestModelAuth extends ModelAuth {
  readonly calls: unknown[][] = []

  register(driver: ModelAuthDriver): () => void {
    this.calls.push(['register', driver])
    return () => { this.calls.push(['dispose-driver']) }
  }

  hasProvider(provider: ModelAuthProviderId): boolean {
    this.calls.push(['has', provider])
    return provider === PROVIDER
  }

  list(): Promise<ModelAuthProviderStatus[]> {
    this.calls.push(['list'])
    return Promise.resolve([{ provider: PROVIDER, displayName: 'Codex', methods: ['browser'], state: 'signed-out' }])
  }

  status(provider: ModelAuthProviderId): Promise<ModelAuthProviderStatus> {
    this.calls.push(['status', provider])
    return Promise.resolve({ provider, displayName: 'Codex', methods: ['browser'], state: 'signed-out' })
  }

  beginLogin(provider: ModelAuthProviderId, method: ModelAuthLoginMethod) {
    this.calls.push(['begin', provider, method])
    return Promise.resolve({
      kind: 'browser' as const,
      provider,
      attemptId: modelAuthLoginAttemptId('attempt-1'),
      authorizationUrl: 'https://auth.example/',
    })
  }

  cancelLogin(attemptId: ReturnType<typeof modelAuthLoginAttemptId>): Promise<void> {
    this.calls.push(['cancel', attemptId])
    return Promise.resolve()
  }

  resolve(provider: ModelAuthProviderId, signal?: AbortSignal): Promise<ModelAuthorization> {
    this.calls.push(['resolve', provider, signal])
    return Promise.resolve({ headers: { authorization: 'secret' } })
  }

  refresh(provider: ModelAuthProviderId, signal?: AbortSignal): Promise<ModelAuthorization> {
    this.calls.push(['refresh', provider, signal])
    return Promise.resolve({ headers: { authorization: 'refreshed' } })
  }

  logout(provider: ModelAuthProviderId, signal?: AbortSignal): Promise<void> {
    this.calls.push(['logout', provider, signal])
    return Promise.resolve()
  }

  emitUpdated(provider: ModelAuthProviderId): void {
    this.notifyUpdated(provider)
  }
}

describe('model-auth Service Definition', () => {
  it('validates provider and attempt identifiers', () => {
    expect(modelAuthProviderId('a1-codex')).toBe('a1-codex')
    for (const invalid of ['', 'OpenAI', '-openai', 'openai-', 'open_ai']) {
      expect(() => modelAuthProviderId(invalid)).toThrow(/must match/)
    }
    expect(modelAuthLoginAttemptId('attempt')).toBe('attempt')
    expect(() => modelAuthLoginAttemptId('')).toThrow(/non-empty/)
  })

  it('preserves stable error identity and cause', () => {
    const cause = new Error('root')
    const error = new ModelAuthError('denied', 'DENIED', { cause })
    expect(error).toMatchObject({ name: 'ModelAuthError', message: 'denied', code: 'DENIED', cause })
  })

  it('binds safe Remote methods to the typed service methods', async () => {
    const ctx = new Context()
    const service = new TestModelAuth(ctx)
    const signal = new AbortController().signal

    expect(await service.remoteList()).toHaveLength(1)
    expect(await service.remoteBeginLogin('openai-codex', 'browser')).toMatchObject({ attemptId: 'attempt-1' })
    await service.remoteCancelLogin('attempt-1')
    await service.remoteLogout('openai-codex', signal)
    expect(service.hasProvider(PROVIDER)).toBe(true)
    expect(await service.status(PROVIDER)).toMatchObject({ provider: PROVIDER })
    expect(await service.resolve(PROVIDER, signal)).toEqual({ headers: { authorization: 'secret' } })
    expect(await service.refresh(PROVIDER, signal)).toEqual({ headers: { authorization: 'refreshed' } })
    const dispose = service.register({} as ModelAuthDriver)
    dispose()

    expect(service.calls.map(call => call[0])).toEqual([
      'list', 'begin', 'cancel', 'logout', 'has', 'status', 'resolve', 'refresh', 'register', 'dispose-driver',
    ])
    await ctx.fiber.dispose()
  })

  it('contains ordinary synchronous and asynchronous observer failures', async () => {
    const ctx = new Context()
    const service = new TestModelAuth(ctx)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const asyncObserver = (): unknown => Promise.reject(new Error('async observer'))
    ctx.on('model-auth/updated', () => { throw new Error('sync observer') })
    ctx.on('model-auth/updated', asyncObserver)
    ctx.on('model-auth/updated', () => undefined)

    expect(() => { service.emitUpdated(PROVIDER) }).not.toThrow()
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledTimes(4) })
    expect(warn.mock.calls.at(-1)?.[0]).toEqual(new Error('async observer'))
    await ctx.fiber.dispose()
  })

  it('rethrows the first invariant failure after every observer runs', () => {
    const ctx = new Context()
    const service = new TestModelAuth(ctx)
    const invariant = Object.assign(new Error('owned relationship failed'), { code: 'INVARIANT' })
    const later = vi.fn()
    ctx.on('model-auth/updated', () => { throw invariant })
    ctx.on('model-auth/updated', () => { throw Object.assign(new Error('second'), { code: 'INVARIANT' }) })
    ctx.on('model-auth/updated', later)

    expect(() => { service.emitUpdated(PROVIDER) }).toThrow(invariant)
    expect(later).toHaveBeenCalledWith(PROVIDER)
  })
})

describe('model-auth invariant companion', () => {
  it('accepts updates from a live model-auth service', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(ModelAuthInvariant)
    const service = new TestModelAuth(ctx)
    expect(() => { service.emitUpdated(PROVIDER) }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('rejects updates without a live service and duplicate ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(ModelAuthInvariant)
    expect(() => { ctx.emit('model-auth/updated', PROVIDER) }).toThrow(/without a live model-auth service/)
    expect(() => { ctx.invariants.register('@deepseek-ai/dsh-model-auth', () => undefined) }).toThrow(/already registered/)
    await ctx.fiber.dispose()
  })
})
