import { describe, expect, it, vi } from 'vitest'
import type { ModelAuthorization } from '@deepseek-ai/dsh-model-auth'
import { ModelAuthError } from '@deepseek-ai/dsh-model-auth'
import type { ModelAuth } from '@deepseek-ai/dsh-model-auth'
import { resolveXaiOptions } from '../src/index.ts'
import { XaiAdapter } from '../src/adapter.ts'
import { XAI_OAUTH_PROVIDER } from '../src/auth.ts'

function auth(overrides: Partial<ModelAuth> = {}): ModelAuth {
  return {
    resolve: vi.fn(() => Promise.resolve({ headers: { authorization: 'Bearer access' } })),
    refresh: vi.fn(() => Promise.resolve({ headers: { authorization: 'Bearer refreshed' } })),
    ...overrides,
  } as unknown as ModelAuth
}

function catalogResponse(status = 200): Response {
  return new Response(status === 200 ? JSON.stringify({
    models: [
      { id: 'grok-4.5', aliases: ['grok-latest'], input_modalities: ['text', 'image'] },
      { id: 'grok-new', aliases: [], input_modalities: ['text'] },
    ],
  }) : '{}', { status, headers: { 'content-type': 'application/json' } })
}

describe('xAI adapter discovery', () => {
  it('keeps a seed model visible while signed out', async () => {
    const modelAuth = auth({
      resolve: vi.fn(() => Promise.reject(new ModelAuthError('not signed in', 'NOT_AUTHENTICATED'))),
    })
    const adapter = new XaiAdapter({ options: () => resolveXaiOptions({}), modelAuth })
    await expect(adapter.listModels(XAI_OAUTH_PROVIDER)).resolves.toEqual([
      expect.objectContaining({ id: 'grok-4.5', provider: XAI_OAUTH_PROVIDER }),
    ])
  })

  it('discovers language models and preserves known metadata', async () => {
    const request = vi.fn(() => Promise.resolve(catalogResponse()))
    const adapter = new XaiAdapter({ options: () => resolveXaiOptions({}), modelAuth: auth(), fetch: request })
    await expect(adapter.listModels(XAI_OAUTH_PROVIDER)).resolves.toEqual([
      expect.objectContaining({ id: 'grok-4.5', name: 'grok-latest', inputModalities: ['text', 'image'] }),
      expect.objectContaining({ id: 'grok-new', inputModalities: ['text'] }),
    ])
    await expect(adapter.resolveModel(XAI_OAUTH_PROVIDER, 'grok-4.5')).resolves.toMatchObject({
      context: { contextWindow: 500_000 }, reasoning: { efforts: expect.any(Array) },
    })
    expect(request).toHaveBeenCalledOnce()
  })

  it('forces one refresh and retries model discovery after a 401', async () => {
    const modelAuth = auth()
    const request = vi.fn()
      .mockResolvedValueOnce(catalogResponse(401))
      .mockResolvedValueOnce(catalogResponse())
    const adapter = new XaiAdapter({ options: () => resolveXaiOptions({}), modelAuth, fetch: request })
    await adapter.listModels(XAI_OAUTH_PROVIDER)
    expect(modelAuth.refresh).toHaveBeenCalledWith(XAI_OAUTH_PROVIDER, undefined)
    const second = request.mock.calls[1]?.[1] as RequestInit
    expect((second.headers as ModelAuthorization['headers']).authorization).toBe('Bearer refreshed')
  })

  it('rejects malformed catalogs without retaining them', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response('{"models":[{}]}', { status: 200 }))
      .mockResolvedValueOnce(catalogResponse())
    const adapter = new XaiAdapter({ options: () => resolveXaiOptions({}), modelAuth: auth(), fetch: request })
    await expect(adapter.listModels(XAI_OAUTH_PROVIDER)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    await expect(adapter.listModels(XAI_OAUTH_PROVIDER)).resolves.toHaveLength(2)
  })
})
