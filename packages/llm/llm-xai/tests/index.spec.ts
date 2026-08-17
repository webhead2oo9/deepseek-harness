import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it, vi } from 'vitest'
import { apply, resolveXaiOptions, XAI_API_BASE_URL } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { XaiAdapter } from '../src/adapter.ts'
import { XAI_OAUTH_PROVIDER, XaiAuthDriver } from '../src/auth.ts'
import * as XaiInvariant from '../src/invariant.ts'

describe('xAI plugin configuration', () => {
  it('resolves defaults and a loopback test endpoint', () => {
    expect(resolveXaiOptions({}).baseURL).toBe(XAI_API_BASE_URL)
    expect(resolveXaiOptions({ baseURL: 'http://127.0.0.1:3000/' }).baseURL).toBe('http://127.0.0.1:3000')
  })

  it.each([
    [{ baseURL: 'relative' }, /absolute URL/],
    [{ baseURL: 'http://api.x.ai/v1' }, /HTTPS/],
    [{ baseURL: 'https://example.com/v1' }, /x\.ai/],
    [{ baseURL: 'https://user:pass@api.x.ai/v1' }, /must not include/],
    [{ defaultContextWindow: 0 }, /defaultContextWindow/],
    [{ defaultMaxTokens: 1.5 }, /defaultMaxTokens/],
    [{ streamIdleTimeoutMs: 0 }, /streamIdleTimeoutMs/],
    [{ modelCacheTtlMs: Number.POSITIVE_INFINITY }, /modelCacheTtlMs/],
  ] as const)('rejects invalid configuration %#', (config, expected) => {
    expect(() => resolveXaiOptions(config as unknown as Config)).toThrow(expected)
  })

  it('registers one auth driver and one LLM route', () => {
    const register = vi.fn()
    const registerAdapter = vi.fn()
    const ctx = { modelAuth: { register }, llm: { registerAdapter } } as unknown as Context
    apply(ctx, {})
    expect(register.mock.calls[0]?.[0]).toBeInstanceOf(XaiAuthDriver)
    expect(registerAdapter.mock.calls[0]?.[0]).toEqual([XAI_OAUTH_PROVIDER])
    expect(registerAdapter.mock.calls[0]?.[1]).toBeInstanceOf(XaiAdapter)
  })
})

describe('xAI invariant companion', () => {
  it('reserves package ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(XaiInvariant)
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-llm-xai', () => undefined)).toThrow(/already registered/)
    await ctx.fiber.dispose()
  })
})
