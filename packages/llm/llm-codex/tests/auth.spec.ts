import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  codexAccount,
  createCodexAuthRecord,
  decodeJwtClaims,
  parseCodexAuthRecord,
  refreshedCodexAuthRecord,
} from '../src/jwt.ts'
import { refreshCodexRecord, shouldRefreshCodexRecord } from '../src/oauth.ts'
import { resolveCodexOptions } from '../src/index.ts'
import type { CodexOAuthOptions } from '../src/oauth.ts'

function jwt(claims: Record<string, unknown>): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
}

const oauth: CodexOAuthOptions = {
  issuer: 'https://auth.example',
  clientId: 'client',
  originator: 'test',
  callbackPorts: [1455],
  loginTimeoutMs: 1_000,
  deviceTimeoutMs: 1_000,
  refreshWindowMs: 300_000,
  refreshIntervalMs: 600_000,
  allowedWorkspaceIds: [],
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Codex OAuth records', () => {
  it('extracts safe account and expiration claims', () => {
    const record = createCodexAuthRecord({
      idToken: jwt({
        email: 'person@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'workspace-1',
          chatgpt_plan_type: 'plus',
          chatgpt_account_is_fedramp: true,
        },
      }),
      accessToken: jwt({ exp: 2_000_000_000 }),
      refreshToken: 'refresh',
    })
    expect(codexAccount(record)).toEqual({
      accountId: 'workspace-1', email: 'person@example.com', plan: 'plus',
    })
    expect(record.fedRamp).toBe(true)
    expect(record.accessTokenExpiresAt).toBe(new Date(2_000_000_000_000).toISOString())
    expect(parseCodexAuthRecord(record)).toEqual(record)
  })

  it('rejects malformed tokens and durable records', () => {
    expect(() => decodeJwtClaims('bad')).toThrow(/invalid JWT/)
    expect(() => decodeJwtClaims('a.b.c')).toThrow(/payload/)
    expect(() => decodeJwtClaims(jwt([] as never))).toThrow(/payload/)
    expect(() => createCodexAuthRecord({ idToken: '', accessToken: 'a', refreshToken: 'r' })).toThrow(/incomplete/)
    expect(() => parseCodexAuthRecord(null)).toThrow(/invalid/)
    expect(() => parseCodexAuthRecord({ version: 0 })).toThrow(/invalid/)
  })

  it('uses profile email, omits absent claims, and rotates token fields independently', () => {
    const current = createCodexAuthRecord({
      idToken: jwt({ 'https://api.openai.com/profile': { email: 'profile@example.com' }, 'https://api.openai.com/auth': 'invalid' }),
      accessToken: jwt({ exp: 'unknown' }),
      refreshToken: 'refresh',
    })
    expect(current).toMatchObject({ email: 'profile@example.com', fedRamp: false })
    expect(current).not.toHaveProperty('accessTokenExpiresAt')
    expect(codexAccount(current)).toEqual({ email: 'profile@example.com' })
    const nextId = jwt({ email: 'next@example.com' })
    const nextAccess = jwt({ exp: 2_000_000_000 })
    expect(refreshedCodexAuthRecord(current, { idToken: nextId })).toMatchObject({
      idToken: nextId, accessToken: current.accessToken, refreshToken: 'refresh', email: 'next@example.com',
    })
    expect(refreshedCodexAuthRecord(current, { accessToken: nextAccess, refreshToken: 'next-refresh' })).toMatchObject({
      idToken: current.idToken, accessToken: nextAccess, refreshToken: 'next-refresh',
    })
    expect(createCodexAuthRecord({ idToken: jwt({}), accessToken: jwt({ exp: 1e20 }), refreshToken: 'r' }))
      .not.toHaveProperty('accessTokenExpiresAt')
  })

  it('validates optional durable fields and timestamps', () => {
    const valid = createCodexAuthRecord({ idToken: jwt({}), accessToken: jwt({}), refreshToken: 'refresh' })
    expect(parseCodexAuthRecord({ ...valid, accountId: 'workspace', email: 'a@b.c', plan: 'plus' }))
      .toMatchObject({ accountId: 'workspace', email: 'a@b.c', plan: 'plus' })
    for (const key of ['accessTokenExpiresAt', 'accountId', 'email', 'plan'] as const) {
      expect(() => parseCodexAuthRecord({ ...valid, [key]: '' })).toThrow(/invalid/)
      expect(() => parseCodexAuthRecord({ ...valid, [key]: 1 })).toThrow(/invalid/)
    }
    expect(() => parseCodexAuthRecord({ ...valid, refreshedAt: 'not-a-date' })).toThrow(/refresh time/)
    expect(() => parseCodexAuthRecord({ ...valid, accessTokenExpiresAt: 'not-a-date' })).toThrow(/expiration/)
    expect(codexAccount({ ...valid, accountId: 'workspace', plan: 'plus' })).toEqual({ accountId: 'workspace', plan: 'plus' })
  })

  it('refreshes rotated fields and enforces the selected workspace', async () => {
    const current = createCodexAuthRecord({
      idToken: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-1' } }),
      accessToken: jwt({ exp: 1 }),
      refreshToken: 'old-refresh',
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      access_token: jwt({ exp: 2_000_000_000 }),
      refresh_token: 'new-refresh',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    const next = await refreshCodexRecord({ ...oauth, allowedWorkspaceIds: ['workspace-1'] }, current)
    expect(next.refreshToken).toBe('new-refresh')
    expect(next.accountId).toBe('workspace-1')
    expect(shouldRefreshCodexRecord(oauth, next, 0)).toBe(false)
  })

  it('classifies permanent refresh failures without exposing response bodies', async () => {
    const record = createCodexAuthRecord({ idToken: jwt({}), accessToken: jwt({}), refreshToken: 'refresh' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      error: 'refresh_token_expired', detail: 'secret body',
    }), { status: 401, headers: { 'content-type': 'application/json' } }))))
    await expect(refreshCodexRecord(oauth, record)).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
  })
})

describe('Codex configuration', () => {
  it('resolves complete defaults and permits loopback test endpoints', () => {
    const resolved = resolveCodexOptions({ issuer: 'http://127.0.0.1:3000/', baseURL: 'http://localhost:4000/' })
    expect(resolved.oauth.issuer).toBe('http://127.0.0.1:3000')
    expect(resolved.connection.baseURL).toBe('http://localhost:4000')
    expect(resolved.oauth.callbackPorts).toEqual([1455, 1457])
  })

  it('rejects insecure remote endpoints and invalid callback or workspace lists', () => {
    expect(() => resolveCodexOptions({ baseURL: 'http://example.com' })).toThrow(/HTTPS/)
    expect(() => resolveCodexOptions({ callbackPorts: [1455, 1455] })).toThrow(/callbackPorts/)
    expect(() => resolveCodexOptions({ allowedWorkspaceIds: [''] })).toThrow(/allowedWorkspaceIds/)
  })
})
