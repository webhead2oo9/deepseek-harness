import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ModelAuthorization } from '@deepseek-ai/dsh-model-auth'
import { ModelAuthError } from '@deepseek-ai/dsh-model-auth'
import type { ModelAuth } from '@deepseek-ai/dsh-model-auth'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveXaiOptions } from '../src/index.ts'
import { DEFAULT_XAI_REASONING_EFFORTS, XaiAdapter } from '../src/adapter.ts'
import { XAI_OAUTH_PROVIDER } from '../src/auth.ts'

const DEFAULT_REASONING_IDS = Object.keys(DEFAULT_XAI_REASONING_EFFORTS)

const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

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

function responseBody(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
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
    await expect(adapter.resolveModel(XAI_OAUTH_PROVIDER, 'grok-4.5')).resolves.toMatchObject({
      id: 'grok-4.5', provider: XAI_OAUTH_PROVIDER,
    })
  })

  it('discovers language models and preserves known metadata', async () => {
    const request = vi.fn(() => Promise.resolve(catalogResponse()))
    const adapter = new XaiAdapter({ options: () => resolveXaiOptions({}), modelAuth: auth(), fetch: request })
    await expect(adapter.listModels(XAI_OAUTH_PROVIDER)).resolves.toEqual([
      expect.objectContaining({ id: 'grok-4.5', name: 'grok-latest', inputModalities: ['text', 'image'] }),
      expect.objectContaining({ id: 'grok-new', inputModalities: ['text'] }),
    ])
    const resolved = await adapter.resolveModel(XAI_OAUTH_PROVIDER, 'grok-4.5')
    expect(resolved.context).toEqual({ contextWindow: 500_000 })
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(DEFAULT_REASONING_IDS)
    expect(request).toHaveBeenCalledOnce()
  })

  it('forces one refresh and retries model discovery after a 401', async () => {
    const refresh = vi.fn(() => Promise.resolve({ headers: { authorization: 'Bearer refreshed' } }))
    const modelAuth = auth({ refresh })
    const request = vi.fn()
      .mockResolvedValueOnce(catalogResponse(401))
      .mockResolvedValueOnce(catalogResponse())
    const adapter = new XaiAdapter({ options: () => resolveXaiOptions({}), modelAuth, fetch: request })
    const signal = new AbortController().signal
    await adapter.resolveModel(XAI_OAUTH_PROVIDER, 'grok-4.5', signal)
    expect(refresh).toHaveBeenCalledWith(XAI_OAUTH_PROVIDER, signal)
    const second = request.mock.calls[1]?.[1] as RequestInit
    expect((second.headers as ModelAuthorization['headers']).authorization).toBe('Bearer refreshed')
    expect(second.signal).toBe(signal)
  })

  it('rejects malformed catalogs without retaining them', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response('{"models":[{}]}', { status: 200 }))
      .mockResolvedValueOnce(catalogResponse())
    const adapter = new XaiAdapter({ options: () => resolveXaiOptions({}), modelAuth: auth(), fetch: request })
    await expect(adapter.listModels(XAI_OAUTH_PROVIDER)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    await expect(adapter.listModels(XAI_OAUTH_PROVIDER)).resolves.toHaveLength(2)
  })

  it('exposes provider metadata, retry policy, and cached catalog values', async () => {
    const request = vi.fn(() => Promise.resolve(catalogResponse()))
    const adapter = new XaiAdapter({ options: () => resolveXaiOptions({}), modelAuth: auth(), fetch: request })
    expect(adapter.providerInfo(XAI_OAUTH_PROVIDER)).toEqual({ id: XAI_OAUTH_PROVIDER, name: 'xAI (Grok)' })
    expect(adapter.providerRetryPolicy(XAI_OAUTH_PROVIDER)).toEqual(resolveXaiOptions({}).retryPolicy)
    await adapter.listModels(XAI_OAUTH_PROVIDER)
    await adapter.listModels(XAI_OAUTH_PROVIDER)
    expect(request).toHaveBeenCalledOnce()
  })

  it('uses catalog aliases, modality filtering, and conservative unknown-model metadata', async () => {
    const request = vi.fn(() => Promise.resolve(responseBody({ models: [
      { id: 'grok-2026', input_modalities: ['text', 'audio', 'image'] },
      { id: 'grok-unknown', aliases: ['grok-1.2-2026', 'Friendly Grok'], input_modalities: ['text'] },
    ] })))
    const adapter = new XaiAdapter({
      options: () => resolveXaiOptions({ defaultContextWindow: 1234, defaultMaxTokens: 234 }),
      modelAuth: auth(),
      fetch: request,
    })
    await expect(adapter.listModels(XAI_OAUTH_PROVIDER)).resolves.toEqual([
      expect.objectContaining({ id: 'grok-2026', name: 'grok-2026', inputModalities: ['text', 'image'] }),
      expect.objectContaining({ id: 'grok-unknown', name: 'Friendly Grok', inputModalities: ['text'] }),
    ])
    const unknown = await adapter.resolveModel(XAI_OAUTH_PROVIDER, 'grok-unknown')
    expect(unknown.context).toEqual({ contextWindow: 1234 })
    expect(unknown.reasoning?.efforts.map(effort => effort.id)).toEqual(DEFAULT_REASONING_IDS)
  })

  it('offers Responses-family reasoning levels for a model newer than the static catalog', async () => {
    const adapter = new XaiAdapter({
      options: () => resolveXaiOptions({}), modelAuth: auth(),
      fetch: () => Promise.resolve(responseBody({ models: [
        { id: 'grok-4.6', aliases: ['grok-latest'], input_modalities: ['text', 'image'] },
      ] })),
    })
    const resolved = await adapter.resolveModel(XAI_OAUTH_PROVIDER, 'grok-4.6')
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(DEFAULT_REASONING_IDS)
    expect(resolved.reasoning?.efforts.some(effort => effort.id === 'off')).toBe(false)
  })

  it('inherits static metadata when a live catalog alias matches a known model', async () => {
    const adapter = new XaiAdapter({
      options: () => resolveXaiOptions({}), modelAuth: auth(),
      fetch: () => Promise.resolve(responseBody({ models: [
        { id: 'grok-4.5-0309', aliases: ['grok-4.5'], input_modalities: ['text', 'image'] },
      ] })),
    })
    const aliased = await adapter.resolveModel(XAI_OAUTH_PROVIDER, 'grok-4.5-0309')
    expect(aliased.context).toEqual({ contextWindow: 500_000 })
    expect(aliased.reasoning?.efforts.map(effort => effort.id)).toEqual(DEFAULT_REASONING_IDS)
  })

  it('uses pi-ai reasoning defaults when static metadata has no explicit level map', async () => {
    const adapter = new XaiAdapter({
      options: () => resolveXaiOptions({}), modelAuth: auth(),
      fetch: () => Promise.resolve(responseBody({ models: [
        { id: 'grok-4.3', aliases: [], input_modalities: ['text', 'image'] },
      ] })),
    })
    const resolved = await adapter.resolveModel(XAI_OAUTH_PROVIDER, 'grok-4.3')
    expect(resolved.reasoning?.efforts.length).toBeGreaterThan(0)
  })

  it.each([
    null,
    {},
    { models: null },
    { models: [null] },
    { models: [{}] },
    { models: [{ id: '', aliases: [], input_modalities: ['text'] }] },
    { models: [{ id: 'grok', aliases: 'latest', input_modalities: ['text'] }] },
    { models: [{ id: 'grok', aliases: [], input_modalities: null }] },
    { models: [{ id: 'grok', aliases: [], input_modalities: [1] }] },
    { models: [{ id: 'grok', aliases: [], input_modalities: ['image'] }] },
  ])('rejects malformed catalog body %#', async (body) => {
    const adapter = new XaiAdapter({
      options: () => resolveXaiOptions({}), modelAuth: auth(), fetch: () => Promise.resolve(responseBody(body)),
    })
    await expect(adapter.listModels(XAI_OAUTH_PROVIDER)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('rejects invalid JSON and classifies catalog HTTP failures', async () => {
    const invalid = new XaiAdapter({
      options: () => resolveXaiOptions({}), modelAuth: auth(),
      fetch: () => Promise.resolve(new Response('{', { status: 200 })),
    })
    await expect(invalid.listModels(XAI_OAUTH_PROVIDER)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })

    for (const [status, code] of [[403, 'AUTH'], [429, 'RATE_LIMIT'], [500, 'SERVER']] as const) {
      const adapter = new XaiAdapter({
        options: () => resolveXaiOptions({}), modelAuth: auth(),
        fetch: () => Promise.resolve(catalogResponse(status)),
      })
      await expect(adapter.listModels(XAI_OAUTH_PROVIDER)).rejects.toMatchObject({ code })
    }
  })

  it('classifies a second 401 after forced refresh', async () => {
    const request = vi.fn(() => Promise.resolve(catalogResponse(401)))
    const adapter = new XaiAdapter({ options: () => resolveXaiOptions({}), modelAuth: auth(), fetch: request })
    await expect(adapter.listModels(XAI_OAUTH_PROVIDER)).rejects.toMatchObject({ code: 'AUTH' })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each([
    [new ModelAuthError('missing', 'NOT_AUTHENTICATED'), 'MISSING_CREDENTIAL'],
    [new ModelAuthError('denied', 'DENIED'), 'AUTH'],
    [new Error('unknown auth failure'), 'AUTH'],
  ] as const)('classifies authentication failure %#', async (failure, code) => {
    const adapter = new XaiAdapter({
      options: () => resolveXaiOptions({}),
      modelAuth: auth({ resolve: vi.fn(() => Promise.reject(failure)) }),
      fetch: () => Promise.resolve(catalogResponse()),
    })
    if (code === 'MISSING_CREDENTIAL') {
      await expect(adapter.listModels(XAI_OAUTH_PROVIDER)).resolves.not.toHaveLength(0)
    } else {
      await expect(adapter.listModels(XAI_OAUTH_PROVIDER)).rejects.toMatchObject({ code })
    }
  })

  it('preserves LLM auth failures and rejects malformed authorization headers', async () => {
    const original = new LlmError('already normalized', 'AUTH')
    const normalized = new XaiAdapter({
      options: () => resolveXaiOptions({}),
      modelAuth: auth({ resolve: vi.fn(() => Promise.reject(original)) }),
      fetch: () => Promise.resolve(catalogResponse()),
    })
    await expect(normalized.listModels(XAI_OAUTH_PROVIDER)).rejects.toBe(original)

    for (const headers of [{}, { authorization: '' }, { authorization: 'Basic token' }]) {
      const resolve = vi.fn()
        .mockResolvedValueOnce({ headers: { authorization: 'Bearer catalog' } })
        .mockResolvedValueOnce({ headers })
      const adapter = new XaiAdapter({
        options: () => resolveXaiOptions({}),
        modelAuth: auth({ resolve }),
        fetch: () => Promise.resolve(catalogResponse()),
      })
      await expect(collect(adapter.stream({
        provider: XAI_OAUTH_PROVIDER, model: 'grok-4.5', messages: [],
      }))).rejects.toMatchObject({ code: 'AUTH' })
    }
  })

  it('accepts a case-insensitive bearer header and reports refresh failures', async () => {
    const adapter = new XaiAdapter({
      options: () => resolveXaiOptions({}),
      modelAuth: auth({ resolve: vi.fn(() => Promise.resolve({ headers: { Authorization: 'Bearer access' } })) }),
      fetch: () => Promise.resolve(catalogResponse()),
    })
    await expect(adapter.listModels(XAI_OAUTH_PROVIDER)).resolves.toHaveLength(2)

    const refreshFailure = new XaiAdapter({
      options: () => resolveXaiOptions({}),
      modelAuth: auth({ refresh: vi.fn(() => Promise.reject(new ModelAuthError('refresh failed', 'DENIED'))) }),
      fetch: () => Promise.resolve(catalogResponse(401)),
    })
    await expect(refreshFailure.listModels(XAI_OAUTH_PROVIDER)).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('keeps concurrent catalog cancellation local to its caller', async () => {
    const first = Promise.withResolvers<Response>()
    const second = Promise.withResolvers<Response>()
    const request = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const adapter = new XaiAdapter({ options: () => resolveXaiOptions({}), modelAuth: auth(), fetch: request })
    const cancelled = new AbortController()
    const surviving = new AbortController()
    const cancelledResolution = adapter.resolveModel(XAI_OAUTH_PROVIDER, 'grok-4.5', cancelled.signal)
    const survivingResolution = adapter.resolveModel(XAI_OAUTH_PROVIDER, 'grok-4.5', surviving.signal)
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(2) })
    cancelled.abort()
    first.reject(new DOMException('aborted', 'AbortError'))
    second.resolve(catalogResponse())
    await expect(cancelledResolution).rejects.toThrow(/aborted/)
    await expect(survivingResolution).resolves.toMatchObject({ id: 'grok-4.5' })
  })

  it('does not hide non-credential or aborted resolution failures', async () => {
    const failure = new LlmError('catalog failed', 'SERVER')
    const failed = new XaiAdapter({
      options: () => resolveXaiOptions({}), modelAuth: auth(), fetch: () => Promise.reject(failure),
    })
    await expect(failed.resolveModel(XAI_OAUTH_PROVIDER, 'grok-4.5')).rejects.toBe(failure)

    const transportFailure = new Error('transport failed')
    const rawFailure = new XaiAdapter({
      options: () => resolveXaiOptions({}), modelAuth: auth(), fetch: () => Promise.reject(transportFailure),
    })
    await expect(rawFailure.resolveModel(XAI_OAUTH_PROVIDER, 'grok-4.5')).rejects.toBe(transportFailure)

    const controller = new AbortController()
    controller.abort()
    const signedOut = new XaiAdapter({
      options: () => resolveXaiOptions({}),
      modelAuth: auth({ resolve: vi.fn(() => Promise.reject(new ModelAuthError('missing', 'NOT_AUTHENTICATED'))) }),
    })
    await expect(signedOut.resolveModel(XAI_OAUTH_PROVIDER, 'grok-4.5', controller.signal)).rejects.toMatchObject({
      code: 'MISSING_CREDENTIAL',
    })
  })

  it('delegates streams after authenticated discovery', async () => {
    const adapter = new XaiAdapter({
      options: () => resolveXaiOptions({}), modelAuth: auth(), fetch: () => Promise.resolve(catalogResponse()),
    })
    await expect(collect(adapter.stream({
      provider: XAI_OAUTH_PROVIDER, model: 'missing-model', messages: [],
    }))).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
  })

  it('passes a valid bearer token to the Responses transport', async () => {
    const network = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      error: { message: 'expected transport stop' },
    }), { status: 401, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', network)
    const adapter = new XaiAdapter({
      options: () => resolveXaiOptions({}), modelAuth: auth(), fetch: () => Promise.resolve(catalogResponse()),
    })
    const chunks = await collect(adapter.stream({
      provider: XAI_OAUTH_PROVIDER, model: 'grok-4.5', messages: [],
    }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(network).toHaveBeenCalledOnce()
  })

  it('refuses image input without a durable attachment service', async () => {
    const adapter = new XaiAdapter({
      options: () => resolveXaiOptions({}), modelAuth: auth(), fetch: () => Promise.resolve(catalogResponse()),
    })
    await expect(collect(adapter.stream({
      provider: XAI_OAUTH_PROVIDER, model: 'grok-4.5',
      messages: [createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'image', attachment: IMAGE_REF }],
      })],
    }))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      message: expect.stringMatching(/durable attachment service/),
    })
  })

  it('loads durable images through the shared Responses transport', async () => {
    const readImage = vi.fn(() => Promise.resolve({ ref: IMAGE_REF, data: Uint8Array.of(1, 2, 3) }))
    const network = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({
      error: { message: 'expected transport stop' },
    }), { status: 401, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', network)
    const adapter = new XaiAdapter({
      options: () => resolveXaiOptions({}),
      modelAuth: auth(),
      fetch: () => Promise.resolve(catalogResponse()),
      resolveAttachments: () => ({ readImage }) as unknown as AttachmentStore,
    })
    const chunks = await collect(adapter.stream({
      provider: XAI_OAUTH_PROVIDER, model: 'grok-4.5',
      messages: [createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'image', attachment: IMAGE_REF }],
      })],
    }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(readImage).toHaveBeenCalledWith(IMAGE_REF)
    expect(network).toHaveBeenCalledOnce()
    const init = network.mock.calls[0]?.[1] as RequestInit
    if (typeof init.body !== 'string') throw new Error('xAI request body was not serialized JSON')
    expect(JSON.parse(init.body)).toEqual(expect.objectContaining({
      input: expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'input_image',
              image_url: 'data:image/png;base64,AQID',
            }),
          ]),
        }),
      ]),
    }))
  })
})
