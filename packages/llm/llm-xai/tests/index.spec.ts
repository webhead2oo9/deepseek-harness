import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalModelAuth from '@deepseek-ai/dsh-model-auth-local'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { apply, resolveXaiOptions, XAI_API_BASE_URL } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import * as XaiPlugin from '../src/index.ts'
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
    const attachments = {}
    const get = vi.fn(() => attachments)
    const ctx = { modelAuth: { register }, llm: { registerAdapter }, get } as unknown as Context
    apply(ctx, {})
    expect(register.mock.calls[0]?.[0]).toBeInstanceOf(XaiAuthDriver)
    expect(registerAdapter.mock.calls[0]?.[0]).toEqual([XAI_OAUTH_PROVIDER])
    const adapter = registerAdapter.mock.calls[0]?.[1] as XaiAdapter
    expect(adapter).toBeInstanceOf(XaiAdapter)
    const registered = adapter as unknown as {
      config: { resolveAttachments: () => unknown }
    }
    expect(registered.config.resolveAttachments()).toBe(attachments)
    expect(get).toHaveBeenCalledWith('attachments')
  })

  it('removes its auth driver and LLM route when the plugin fiber disposes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-xai-hmr-'))
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LocalModelAuth, { path: join(dir, '.model-auth.json') })
      const fiber = ctx.plugin(XaiPlugin, { baseURL: 'http://127.0.0.1:3000' })
      await fiber
      expect(ctx.modelAuth.hasProvider(XAI_OAUTH_PROVIDER)).toBe(true)
      expect(ctx.llm.listProviders()).toContainEqual({ id: XAI_OAUTH_PROVIDER, name: 'xAI (Grok)' })

      await fiber.dispose()
      expect(ctx.modelAuth.hasProvider(XAI_OAUTH_PROVIDER)).toBe(false)
      expect(ctx.llm.listProviders()).not.toContainEqual({ id: XAI_OAUTH_PROVIDER, name: 'xAI (Grok)' })
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
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
