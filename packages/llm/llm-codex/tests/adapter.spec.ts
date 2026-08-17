import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ModelAuth } from '@deepseek-ai/dsh-model-auth'
import { ModelAuthError } from '@deepseek-ai/dsh-model-auth'
import { CodexAdapter } from '../src/adapter.ts'

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of iterable) values.push(value)
  return values
}

async function capturedError(operation: Promise<unknown>): Promise<LlmError> {
  try {
    await operation
  } catch (error) {
    if (error instanceof LlmError) return error
    throw error
  }
  throw new Error('operation unexpectedly succeeded')
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    baseURL: 'https://codex.example',
    clientVersion: 'test',
    defaultContextWindow: 100_000,
    streamIdleTimeoutMs: 10_000,
    modelCacheTtlMs: 10_000,
    retryPolicy: resolveRetryPolicy(undefined, 'test'),
    ...overrides,
  }
}

function auth() {
  return {
    resolve: vi.fn(() => Promise.resolve({ headers: { authorization: 'Bearer first', 'ChatGPT-Account-ID': 'account' } })),
    refresh: vi.fn(() => Promise.resolve({ headers: { authorization: 'Bearer second', 'ChatGPT-Account-ID': 'account' } })),
  }
}

function adapter(overrides: Record<string, unknown> = {}, modelAuth = auth()): CodexAdapter {
  return new CodexAdapter({ options: () => options(overrides), modelAuth: modelAuth as unknown as ModelAuth })
}

function catalogResponse(models: unknown): Response {
  return new Response(JSON.stringify({ models }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function streamResponse(done = true): Response {
  const frames = [
    { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'hello' },
    { type: 'response.output_item.done', item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
    { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 1 } } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '')
  return new Response(`: pulse\n\n${frames}`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('CodexAdapter', () => {
  it('sends native Responses requests with model-auth headers', async () => {
    const modelAuth = auth()
    const fetchMock = vi.fn(() => Promise.resolve(streamResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new CodexAdapter({ options, modelAuth: modelAuth as unknown as ModelAuth })
    const chunks = await collect(adapter.stream({
      provider: 'openai-codex', model: 'gpt-5-codex', messages: [], system: 'work',
    }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://codex.example/responses')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer first')
    expect(new Headers(init.headers).get('chatgpt-account-id')).toBe('account')
    if (typeof init.body !== 'string') throw new Error('Codex request body was not serialized JSON')
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'gpt-5-codex', instructions: 'work', stream: true, store: false,
    })
  })

  it('forces one serialized refresh after an unauthorized response', async () => {
    const modelAuth = auth()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(streamResponse())
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new CodexAdapter({ options, modelAuth: modelAuth as unknown as ModelAuth })
    await collect(adapter.stream({ provider: 'openai-codex', model: 'x', messages: [] }))
    expect(modelAuth.refresh).toHaveBeenCalledOnce()
    expect(new Headers((fetchMock.mock.calls[1]![1] as RequestInit).headers).get('authorization')).toBe('Bearer second')
  })

  it('finishes on response.completed without a DONE sentinel', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(streamResponse(false))))
    const chunks = await collect(adapter().stream({ provider: 'openai-codex', model: 'x', messages: [] }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('discovers, caches, and resolves model capabilities', async () => {
    const modelAuth = auth()
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      models: [{
        slug: 'gpt-5-codex', display_name: 'GPT-5 Codex', description: 'Coding model',
        context_window: 200_000, default_reasoning_level: 'high',
        supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high', description: 'More reasoning' }],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new CodexAdapter({ options, modelAuth: modelAuth as unknown as ModelAuth })
    expect(await adapter.listModels('openai-codex')).toEqual([{
      provider: 'openai-codex', id: 'gpt-5-codex', name: 'GPT-5 Codex',
      description: 'Coding model', inputModalities: ['text'],
    }])
    expect(await adapter.resolveModel('openai-codex', 'gpt-5-codex')).toMatchObject({
      context: { contextWindow: 200_000 },
      reasoning: { defaultEffort: 'high', efforts: [{ id: 'medium' }, { id: 'high' }] },
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('reports provider identity and retry policy', () => {
    const instance = adapter()
    expect(instance.providerInfo('openai-codex')).toEqual({ id: 'openai-codex', name: 'OpenAI Codex' })
    expect(instance.providerRetryPolicy('openai-codex')).toEqual(options().retryPolicy)
  })

  it('normalizes catalog optionals and lists only picker-visible supported models', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(catalogResponse([
      { slug: 'minimal' },
      {
        slug: 'full', display_name: '', description: 1, default_reasoning_level: 2,
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high', description: 1 }],
        context_window: 1.5, supported_in_api: true, visibility: 'list',
      },
      { slug: 'unsupported', supported_in_api: false },
      { slug: 'hidden', visibility: 'hide' },
      { slug: 'absent', visibility: 'none' },
      { slug: 'unknown', visibility: 'future' },
    ]))))
    const instance = adapter()
    expect(await instance.listModels('route')).toEqual([
      { provider: 'route', id: 'minimal', name: 'minimal', inputModalities: ['text'] },
      { provider: 'route', id: 'full', name: 'full', inputModalities: ['text'] },
    ])
    expect(await instance.resolveModel('route', 'minimal')).toEqual({
      provider: 'route', id: 'minimal', name: 'minimal', inputModalities: ['text'], context: { contextWindow: 100_000 },
    })
    expect(await instance.resolveModel('route', 'full')).toMatchObject({
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
    })
  })

  it.each([
    [null, /invalid envelope/],
    [{ models: {} }, /invalid envelope/],
    [{ models: [null] }, /has no slug/],
    [{ models: [{ slug: '' }] }, /has no slug/],
    [{ models: [{ slug: 'x', supported_reasoning_levels: {} }] }, /invalid reasoning levels/],
    [{ models: [{ slug: 'x', supported_reasoning_levels: [null] }] }, /invalid reasoning levels/],
    [{ models: [{ slug: 'x', supported_reasoning_levels: [{ effort: '' }] }] }, /invalid reasoning levels/],
  ])('rejects malformed catalog %#', async (body, expected) => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))))
    await expect(adapter().listModels('route')).rejects.toThrow(expected)
  })

  it('rejects malformed catalog JSON and refreshes an expired cache', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('bad json', { status: 200 }))
      .mockResolvedValueOnce(catalogResponse([{ slug: 'first' }]))
      .mockResolvedValueOnce(catalogResponse([{ slug: 'second' }]))
    vi.stubGlobal('fetch', fetchMock)
    const instance = adapter({ modelCacheTtlMs: 1 })
    await expect(instance.listModels('route')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect(await instance.listModels('route')).toMatchObject([{ id: 'first' }])
    vi.setSystemTime(1_002)
    expect(await instance.listModels('route')).toMatchObject([{ id: 'second' }])
  })

  it('falls back on missing authentication but rethrows cancellation and other catalog failures', async () => {
    const missing = auth()
    missing.resolve.mockRejectedValue(new ModelAuthError('sign in', 'NOT_AUTHENTICATED'))
    await expect(adapter({}, missing).resolveModel('route', 'unknown')).resolves.toEqual({
      provider: 'route', id: 'unknown', name: 'unknown', inputModalities: ['text'], context: { contextWindow: 100_000 },
    })
    const noProvider = auth()
    noProvider.resolve.mockRejectedValue(new ModelAuthError('missing', 'NO_PROVIDER'))
    await expect(adapter({}, noProvider).resolveModel('route', 'unknown')).resolves.toMatchObject({ id: 'unknown' })
    const authFailure = auth()
    authFailure.resolve.mockRejectedValue(new ModelAuthError('expired', 'AUTH_EXPIRED'))
    await expect(adapter({}, authFailure).resolveModel('route', 'unknown')).resolves.toMatchObject({ id: 'unknown' })

    const aborted = new AbortController()
    aborted.abort()
    await expect(adapter({}, missing).resolveModel('route', 'unknown', aborted.signal)).rejects.toBeDefined()
    const malformed = auth()
    malformed.resolve.mockRejectedValue(new LlmError('bad', 'MALFORMED_RESPONSE'))
    await expect(adapter({}, malformed).resolveModel('route', 'unknown')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    const unknown = auth()
    unknown.resolve.mockRejectedValue('unknown auth')
    await expect(adapter({}, unknown).listModels('route')).rejects.toMatchObject({ code: 'AUTH' })
    const llm = auth()
    llm.resolve.mockRejectedValue(new LlmError('already mapped', 'AUTH'))
    await expect(adapter({}, llm).listModels('route')).rejects.toMatchObject({ code: 'AUTH', message: 'already mapped' })
  })

  it.each([
    [403, {}, 'AUTH'],
    [429, {}, 'RATE_LIMIT'],
    [400, {}, 'INVALID_REQUEST'],
    [500, {}, 'SERVER'],
    [418, { error: { message: 'teapot', code: 'TEAPOT' } }, 'TEAPOT'],
    [409, {}, 'HTTP_409'],
  ])('maps HTTP %i to %s provider failures', async (status, body, code) => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), {
      status,
      headers: status === 429
        ? { 'retry-after': '2', 'x-request-id': 'request-1' }
        : status === 409 ? { 'request-id': 'request-2' } : {},
    }))))
    const error = await capturedError(adapter().listModels('route'))
    expect(error).toMatchObject({ code, failure: { status } })
    if (status === 429) expect(error.failure).toMatchObject({ providerRetryAfterMs: 2_000, requestId: 'request-1' })
    if (status === 409) expect(error.failure).toMatchObject({ requestId: 'request-2' })
  })

  it('handles retry dates, invalid headers, malformed error bodies, and a repeated 401', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    const authService = auth()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('not json', {
        status: 401,
        headers: { 'retry-after': new Date('2030-01-01T00:00:01Z').toUTCString(), 'x-request-id': '' },
      }))
      .mockResolvedValueOnce(new Response('{}', { status: 409, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 409, headers: { 'retry-after': 'not-a-date' } }))
    vi.stubGlobal('fetch', fetchMock)
    const instance = adapter({}, authService)
    const first = await capturedError(instance.listModels('route'))
    expect(first).toMatchObject({ code: 'AUTH', failure: { providerRetryAfterMs: 1_000 } })
    expect(authService.refresh).toHaveBeenCalledOnce()
    await expect(instance.listModels('route')).rejects.toMatchObject({ code: 'HTTP_409' })
    await expect(instance.listModels('route')).rejects.toMatchObject({ code: 'HTTP_409' })
  })

  it('uses fallback error fields and rejects non-success streaming responses', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 1, code: 1 } }), { status: 422 }))
      .mockResolvedValueOnce(new Response('{}', { status: 403 })))
    await expect(adapter().listModels('route')).rejects.toMatchObject({ code: 'HTTP_422', message: /HTTP 422/ })
    await expect(collect(adapter().stream({ provider: 'openai-codex', model: 'x', messages: [] })))
      .rejects.toMatchObject({ code: 'AUTH' })
  })

  it('maps refresh failures after a 401', async () => {
    const authService = auth()
    authService.refresh.mockRejectedValueOnce(new ModelAuthError('refresh denied', 'AUTH_EXPIRED'))
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 401 }))))
    await expect(adapter({}, authService).listModels('route')).rejects.toMatchObject({ code: 'AUTH', message: 'refresh denied' })
  })

  it('rejects empty response bodies and includes session attribution', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response(null, { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    await expect(collect(adapter().stream({
      provider: 'openai-codex', model: 'x', messages: [], sessionId: 'session-1' as never,
    }))).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
    const headers = new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers)
    expect(headers.get('session_id')).toBe('session-1')
  })

  it('maps caller abort and request transport failures', async () => {
    const caller = new AbortController()
    caller.abort()
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('aborted fetch'))))
    await expect(collect(adapter().stream({ provider: 'openai-codex', model: 'x', messages: [], signal: caller.signal })))
      .rejects.toMatchObject({ code: 'ABORTED' })

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    await expect(collect(adapter().stream({ provider: 'openai-codex', model: 'x', messages: [] })))
      .rejects.toMatchObject({ code: 'TRANSPORT' })

  })

  it('maps response-stream transport failures', async () => {
    const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('broken body')) } })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(broken, { status: 200 }))))
    await expect(collect(adapter().stream({ provider: 'openai-codex', model: 'x', messages: [] })))
      .rejects.toMatchObject({ code: 'TRANSPORT' })

  })

  it('maps provider idle timeout failures', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('request aborted'))
      }, { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const iterator = adapter({ streamIdleTimeoutMs: 5 }).stream({
      provider: 'openai-codex', model: 'x', messages: [],
    })[Symbol.asyncIterator]()
    const next = iterator.next()
    for (let index = 0; index < 10 && fetchMock.mock.calls.length === 0; index += 1) await Promise.resolve()
    expect(fetchMock).toHaveBeenCalled()
    const outcome = expect(next).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(5)
    await outcome
  })

  it('closes the provider iterator when the consumer stops early', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(streamResponse())))
    const iterator = adapter().stream({ provider: 'openai-codex', model: 'x', messages: [] })[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    await iterator.return!()
  })
})
