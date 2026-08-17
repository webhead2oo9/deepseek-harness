import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import {
  apply,
  CHATGPT_CODEX_BASE_URL,
  DEFAULT_CODEX_CLIENT_VERSION,
  CODEX_OAUTH_CLIENT_ID,
  DEFAULT_CODEX_CALLBACK_PORTS,
  OPENAI_AUTH_ISSUER,
  resolveCodexOptions,
} from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { CodexAuthDriver, CODEX_PROVIDER } from '../src/auth.ts'
import { CodexAdapter } from '../src/adapter.ts'
import * as CodexInvariant from '../src/invariant.ts'

describe('Codex plugin configuration', () => {
  it('resolves defaults and detached explicit values', () => {
    const defaults = resolveCodexOptions({})
    expect(defaults.oauth).toMatchObject({
      issuer: OPENAI_AUTH_ISSUER,
      clientId: CODEX_OAUTH_CLIENT_ID,
      callbackPorts: [...DEFAULT_CODEX_CALLBACK_PORTS],
      allowedWorkspaceIds: [],
    })
    expect(defaults.connection.baseURL).toBe(CHATGPT_CODEX_BASE_URL)
    expect(defaults.connection.clientVersion).toBe(DEFAULT_CODEX_CLIENT_VERSION)

    const ports = [3000]
    const workspaces = ['workspace']
    const explicit = resolveCodexOptions({
      issuer: 'https://auth.example/path',
      clientId: 'client',
      originator: 'originator',
      callbackPorts: ports,
      loginTimeoutMs: 1,
      deviceTimeoutMs: 2,
      refreshWindowMs: 0,
      refreshIntervalMs: 3,
      allowedWorkspaceIds: workspaces,
      baseURL: 'https://codex.example/api',
      clientVersion: '1.2.3',
      defaultContextWindow: 4,
      streamIdleTimeoutMs: 5,
      modelCacheTtlMs: 6,
    })
    ports.push(3001)
    workspaces.push('other')
    expect(explicit.oauth).toMatchObject({
      issuer: 'https://auth.example/path', callbackPorts: [3000], refreshWindowMs: 0, allowedWorkspaceIds: ['workspace'],
    })
    expect(explicit.connection).toMatchObject({
      baseURL: 'https://codex.example/api', clientVersion: '1.2.3', defaultContextWindow: 4,
      streamIdleTimeoutMs: 5, modelCacheTtlMs: 6,
    })
  })

  it.each([
    [{ issuer: 'relative' }, /absolute URL/],
    [{ issuer: 'ftp://localhost' }, /HTTPS/],
    [{ baseURL: 'http://remote.example' }, /HTTPS/],
    [{ issuer: 'https://user:pass@auth.example' }, /must not include/],
    [{ issuer: 'https://auth.example/?query=1' }, /must not include/],
    [{ issuer: 'https://auth.example/#fragment' }, /must not include/],
    [{ callbackPorts: [] }, /callbackPorts/],
    [{ callbackPorts: [1.5] }, /callbackPorts/],
    [{ callbackPorts: [0] }, /callbackPorts/],
    [{ callbackPorts: [65_536] }, /callbackPorts/],
    [{ callbackPorts: [1455, 1455] }, /callbackPorts/],
    [{ allowedWorkspaceIds: [''] }, /allowedWorkspaceIds/],
    [{ allowedWorkspaceIds: ['same', 'same'] }, /allowedWorkspaceIds/],
    [{ clientId: ' ' }, /clientId/],
    [{ originator: 'not printable token' }, /originator/],
    [{ clientVersion: '' }, /clientVersion/],
    [{ defaultContextWindow: 0 }, /defaultContextWindow/],
    [{ defaultContextWindow: Number.MAX_VALUE }, /defaultContextWindow/],
    [{ loginTimeoutMs: 0 }, /loginTimeoutMs/],
    [{ deviceTimeoutMs: Number.NaN }, /deviceTimeoutMs/],
    [{ refreshWindowMs: -1 }, /refreshWindowMs/],
    [{ refreshIntervalMs: Number.POSITIVE_INFINITY }, /refreshIntervalMs/],
    [{ streamIdleTimeoutMs: 2_147_483_648 }, /streamIdleTimeoutMs/],
    [{ modelCacheTtlMs: -1 }, /modelCacheTtlMs/],
  ] as const)('rejects invalid config %#', (config, expected) => {
    expect(() => resolveCodexOptions(config as unknown as Config)).toThrow(expected)
  })

  it('registers one native auth driver and one LLM route', () => {
    const register = vi.fn()
    const registerAdapter = vi.fn()
    const attachments = {}
    const get = vi.fn(() => attachments)
    const ctx = { modelAuth: { register }, llm: { registerAdapter }, get } as unknown as Context
    apply(ctx, { issuer: 'http://localhost:3000', baseURL: 'http://127.0.0.1:4000' })
    expect(register.mock.calls[0]?.[0]).toBeInstanceOf(CodexAuthDriver)
    expect(registerAdapter.mock.calls[0]?.[0]).toEqual([CODEX_PROVIDER])
    const adapter = registerAdapter.mock.calls[0]?.[1] as CodexAdapter
    expect(adapter).toBeInstanceOf(CodexAdapter)
    expect(adapter.providerRetryPolicy(CODEX_PROVIDER)).toBeDefined()
    const registered = adapter as unknown as {
      config: { resolveAttachments: () => unknown }
    }
    expect(registered.config.resolveAttachments()).toBe(attachments)
    expect(get).toHaveBeenCalledWith('attachments')
  })
})

describe('Codex invariant companion', () => {
  it('reserves package ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(CodexInvariant)
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-llm-codex', () => undefined)).toThrow(/already registered/)
    await ctx.fiber.dispose()
  })
})
