/** Native ChatGPT Codex Responses adapter. */

import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { ModelAuthError } from '@deepseek-ai/dsh-model-auth'
import type { ModelAuth, ModelAuthorization } from '@deepseek-ai/dsh-model-auth'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { CODEX_PROVIDER } from './auth.ts'
import { serializeCodexRequest } from './serialize.ts'
import { parseCodexSse } from './sse.ts'
import { translateCodex } from './translate.ts'
import type { CodexCatalogModel, CodexModelsResponse } from './types.ts'

/** Default combined request and response context used when the catalog omits it. */
export const DEFAULT_CODEX_CONTEXT_WINDOW = 272_000
/** Default maximum provider idle interval while one stream read is outstanding. */
export const DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default interval for retaining the authenticated model catalog. */
export const DEFAULT_CODEX_MODEL_CACHE_TTL_MS = 300_000
const STREAM_IDLE_TIMEOUT_CODE = 'CODEX_STREAM_IDLE_TIMEOUT'

/** Validated request and catalog parameters for one adapter operation. */
export interface CodexConnectionOptions {
  /** ChatGPT Codex backend root; `/responses` and `/models` are appended. */
  baseURL: string
  /** Public client version sent to the Codex model catalog. */
  clientVersion: string
  /** Fallback context capacity when the catalog omits one. */
  defaultContextWindow: number
  /** Maximum provider idle interval for a stream read. */
  streamIdleTimeoutMs: number
  /** Duration for retaining a successful model catalog response. */
  modelCacheTtlMs: number
  /** Provider-owned model-request retry policy. */
  retryPolicy: ResolvedRetryPolicy
}

/** Construction hooks owned by the registering Codex plugin. */
export interface CodexAdapterOptions {
  /** Resolve current validated connection parameters once per operation. */
  options: () => CodexConnectionOptions
  /** Provider-neutral credential lifecycle service. */
  modelAuth: ModelAuth
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
}

interface CatalogCache {
  expiresAt: number
  models: CodexCatalogModel[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isReasoningLevel(value: unknown): value is { effort: string; description?: string } {
  return isObject(value) && typeof value.effort === 'string' && value.effort.length > 0
}

function parseCatalog(value: unknown): CodexCatalogModel[] {
  if (!isObject(value) || !Array.isArray(value.models)) {
    throw new LlmError('Codex model catalog returned an invalid envelope', 'MALFORMED_RESPONSE')
  }
  return value.models.map((entry, index) => {
    if (!isObject(entry) || typeof entry.slug !== 'string' || entry.slug.length === 0) {
      throw new LlmError(`Codex model catalog entry ${index} has no slug`, 'MALFORMED_RESPONSE')
    }
    const levels = entry.supported_reasoning_levels
    if (levels !== undefined && (!Array.isArray(levels) || !levels.every(isReasoningLevel))) {
      throw new LlmError(`Codex model catalog entry "${entry.slug}" has invalid reasoning levels`, 'MALFORMED_RESPONSE')
    }
    const parsedLevels = levels === undefined ? undefined : levels.filter(isReasoningLevel)
    return {
      slug: entry.slug,
      display_name: typeof entry.display_name === 'string' && entry.display_name.length > 0
        ? entry.display_name
        : entry.slug,
      ...typeof entry.description === 'string' ? { description: entry.description } : {},
      ...typeof entry.default_reasoning_level === 'string'
        ? { default_reasoning_level: entry.default_reasoning_level }
        : {},
      ...parsedLevels === undefined
        ? {}
        : {
          supported_reasoning_levels: parsedLevels.map(level => ({
            effort: level.effort,
            ...typeof level.description === 'string' ? { description: level.description } : {},
          })),
        },
      ...typeof entry.context_window === 'number' && Number.isSafeInteger(entry.context_window) && entry.context_window > 0
        ? { context_window: entry.context_window }
        : {},
      ...typeof entry.supported_in_api === 'boolean' ? { supported_in_api: entry.supported_in_api } : {},
      ...typeof entry.visibility === 'string' ? { visibility: entry.visibility } : {},
    }
  })
}

function modelInfo(provider: string, model: CodexCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.slug,
    name: model.display_name,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: ['text', 'image'],
  }
}

function authError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof ModelAuthError) {
    const missing = ['NOT_AUTHENTICATED', 'NO_PROVIDER'].includes(error.code)
    return new LlmError(error.message, missing ? 'MISSING_CREDENTIAL' : 'AUTH', { cause: error })
  }
  return new LlmError('Codex authentication failed', 'AUTH', { cause: error })
}

function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ProviderRequestId | undefined {
  const value = headers.get('x-request-id') ?? headers.get('request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

async function providerFailure(response: Response): Promise<LlmError> {
  let message = `Codex API error (HTTP ${response.status})`
  let providerCode: string | undefined
  try {
    const body = await response.json() as unknown
    if (isObject(body) && isObject(body.error)) {
      if (typeof body.error.message === 'string') message = body.error.message
      if (typeof body.error.code === 'string') providerCode = body.error.code
    }
  } catch {
    // The HTTP status remains authoritative when an intermediary returns malformed JSON.
  }
  const code = response.status === 401 || response.status === 403
    ? 'AUTH'
    : response.status === 429
      ? 'RATE_LIMIT'
      : response.status === 400
        ? 'INVALID_REQUEST'
        : response.status >= 500
          ? 'SERVER'
          : providerCode ?? `HTTP_${response.status}`
  const delay = retryAfterMs(response.headers.get('retry-after'))
  const id = requestId(response.headers)
  return new LlmError(message, code, {
    status: response.status,
    ...delay === undefined ? {} : { providerRetryAfterMs: delay },
    ...id === undefined ? {} : { requestId: id },
  })
}

/** Direct native Codex adapter backed by ChatGPT OAuth. */
export class CodexAdapter extends LlmAdapter {
  private catalogCache: CatalogCache | undefined

  constructor(private readonly config: CodexAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'OpenAI Codex' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.catalog()
    return models
      .filter(model => model.supported_in_api !== false
        && (model.visibility === undefined || model.visibility === 'list'))
      .map(model => modelInfo(provider, model))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    let configured: CodexCatalogModel | undefined
    try {
      configured = (await this.catalog(signal)).find(entry => entry.slug === model)
    } catch (error) {
      if (signal?.aborted) throw error
      if (!(error instanceof LlmError) || !['MISSING_CREDENTIAL', 'AUTH'].includes(error.code)) throw error
    }
    const efforts = configured?.supported_reasoning_levels?.map(level => ({
      id: ReasoningEffortId(level.effort),
      name: level.effort.charAt(0).toUpperCase() + level.effort.slice(1),
      ...level.description === undefined ? {} : { description: level.description },
    }))
    return {
      ...(configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const, 'image' as const] }
        : modelInfo(provider, configured)),
      context: { contextWindow: configured?.context_window ?? this.config.options().defaultContextWindow },
      ...efforts === undefined || efforts.length === 0
        ? {}
        : {
          reasoning: {
            efforts,
            ...configured?.default_reasoning_level === undefined
              ? {}
              : { defaultEffort: ReasoningEffortId(configured.default_reasoning_level) },
          },
        },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(options, watchdog.signal, connection, () => { watchdog.pulse() })
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`Codex stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) throw new LlmError('Codex request aborted by caller', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw new LlmError(`Codex API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('Codex stream consumer stopped')
      if (!exhausted) {
        try {
          await iterator.return()
        /* v8 ignore start -- aborting this owned async generator has no independent outcome after consumer cancellation */
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; return-time abort cannot add another outcome.
        }
        /* v8 ignore stop */
      }
    }
  }

  private async catalog(signal?: AbortSignal): Promise<CodexCatalogModel[]> {
    const connection = this.config.options()
    if (this.catalogCache !== undefined && this.catalogCache.expiresAt > Date.now()) {
      return structuredClone(this.catalogCache.models)
    }
    const response = await this.fetchAuthorized(
      `${connection.baseURL}/models?client_version=${encodeURIComponent(connection.clientVersion)}`,
      { method: 'GET', headers: { accept: 'application/json', ...attributionHeaders() }, ...signal === undefined ? {} : { signal } },
      signal,
    )
    if (!response.ok) throw await providerFailure(response)
    let body: CodexModelsResponse
    try {
      body = await response.json() as CodexModelsResponse
    } catch (error) {
      throw new LlmError('Codex model catalog returned invalid JSON', 'MALFORMED_RESPONSE', { cause: error })
    }
    const models = parseCatalog(body)
    this.catalogCache = { expiresAt: Date.now() + connection.modelCacheTtlMs, models }
    return structuredClone(models)
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: CodexConnectionOptions,
    onComment: () => void,
  ): AsyncGenerator<StreamChunk, void, void> {
    const containsImage = options.messages.some(message => contentHasImage(message.content))
    const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
    const payload = JSON.stringify(await serializeCodexRequest(options, attachments, signal))
    const response = await this.fetchAuthorized(`${connection.baseURL}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        ...attributionHeaders(),
        ...options.sessionId === undefined ? {} : { session_id: String(options.sessionId) },
      },
      body: payload,
      signal,
    }, signal)
    if (!response.ok) throw await providerFailure(response)
    if (response.body === null) throw new LlmError('Codex API returned no response body', 'EMPTY_RESPONSE')
    yield* translateCodex(parseCodexSse(response.body, onComment))
  }

  private async fetchAuthorized(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    let authorization: ModelAuthorization
    try {
      authorization = await this.config.modelAuth.resolve(CODEX_PROVIDER, signal)
    } catch (error) {
      throw authError(error)
    }
    let response = await this.fetchWithAuthorization(url, init, authorization)
    if (response.status !== 401) return response
    await response.body?.cancel()
    try {
      authorization = await this.config.modelAuth.refresh(CODEX_PROVIDER, signal)
    } catch (error) {
      throw authError(error)
    }
    response = await this.fetchWithAuthorization(url, init, authorization)
    return response
  }

  private async fetchWithAuthorization(
    url: string,
    init: RequestInit,
    authorization: ModelAuthorization,
  ): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers).entries()), ...authorization.headers },
      })
    } catch (error) {
      if (init.signal?.aborted) throw error
      throw new LlmError(`Codex API request to ${url} failed`, 'TRANSPORT', { cause: error })
    }
  }
}
