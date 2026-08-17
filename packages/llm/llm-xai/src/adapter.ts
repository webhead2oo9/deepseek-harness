/** Authenticated xAI model discovery with pi-ai Responses transport. */

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { PiAiAdapter, resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiModelProfile, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { ModelAuthError } from '@deepseek-ai/dsh-model-auth'
import type { ModelAuth, ModelAuthorization } from '@deepseek-ai/dsh-model-auth'
import { XAI_OAUTH_PROVIDER } from './auth.ts'

/** Default xAI API root. */
export const XAI_API_BASE_URL = 'https://api.x.ai/v1'
/** Default context capacity for a discovered model without catalog metadata. */
export const DEFAULT_XAI_CONTEXT_WINDOW = 262_144
/** Default output capacity for a discovered model without catalog metadata. */
export const DEFAULT_XAI_MAX_TOKENS = 32_768
/** Default maximum provider idle interval for one streaming read. */
export const DEFAULT_XAI_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default lifetime of an authenticated xAI model catalog. */
export const DEFAULT_XAI_MODEL_CACHE_TTL_MS = 300_000

/** Validated xAI API and model parameters. */
export interface XaiConnectionOptions {
  /** xAI API root; `/language-models` is appended for discovery. */
  baseURL: string
  /** Fallback context capacity for an unknown discovered model. */
  defaultContextWindow: number
  /** Fallback output capacity for an unknown discovered model. */
  defaultMaxTokens: number
  /** Maximum provider idle interval for one streaming read. */
  streamIdleTimeoutMs: number
  /** Lifetime of a successful authenticated model catalog. */
  modelCacheTtlMs: number
  /** Provider-owned request retry policy. */
  retryPolicy: ResolvedRetryPolicy
}

/** Construction hooks owned by the xAI plugin. */
export interface XaiAdapterOptions {
  /** Current validated connection parameters. */
  options: () => XaiConnectionOptions
  /** Provider-neutral OAuth lifecycle service. */
  modelAuth: ModelAuth
  /** HTTP implementation, injectable for deterministic tests. */
  fetch?: typeof fetch
}

interface CatalogCache {
  expiresAt: number
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
}

interface XaiCatalogModel {
  id: string
  aliases: string[]
  inputModalities: Array<'text' | 'image'>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCatalog(value: unknown): XaiCatalogModel[] {
  if (!isObject(value) || !Array.isArray(value.models)) {
    throw new LlmError('xAI model catalog returned an invalid envelope', 'MALFORMED_RESPONSE')
  }
  return value.models.map((entry, index) => {
    if (!isObject(entry) || typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new LlmError(`xAI model catalog entry ${index} has no id`, 'MALFORMED_RESPONSE')
    }
    const aliases = entry.aliases === undefined
      ? []
      : Array.isArray(entry.aliases) && entry.aliases.every(alias => typeof alias === 'string')
        ? entry.aliases
        : undefined
    const input = entry.input_modalities
    if (aliases === undefined || !Array.isArray(input) || !input.every(value => typeof value === 'string')) {
      throw new LlmError(`xAI model catalog entry "${entry.id}" has invalid metadata`, 'MALFORMED_RESPONSE')
    }
    const inputModalities = input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
    if (!inputModalities.includes('text')) {
      throw new LlmError(`xAI language model "${entry.id}" does not accept text`, 'MALFORMED_RESPONSE')
    }
    return { id: entry.id, aliases, inputModalities }
  })
}

function displayName(model: XaiCatalogModel): string {
  const alias = model.aliases.find(value => value !== model.id && !/^grok-[\d.]+-\d{4}$/.test(value))
  return alias ?? model.id
}

function reasoningEfforts(model: Model<Api>): Exclude<PiAiModelProfile['reasoningEfforts'], undefined> {
  return Object.fromEntries(getSupportedThinkingLevels(model).map(level => [
    level,
    /* v8 ignore next -- pi-ai omits disabled `off` levels from this supported-level list */
    level === 'off' ? null : model.thinkingLevelMap?.[level] ?? level,
  ]))
}

function modelProfile(
  model: XaiCatalogModel,
  known: ReadonlyMap<string, Model<Api>>,
  options: XaiConnectionOptions,
): PiAiModelProfile {
  const metadata = known.get(model.id)
  return {
    id: model.id,
    name: displayName(model),
    contextWindow: metadata?.contextWindow ?? options.defaultContextWindow,
    maxTokens: metadata?.maxTokens ?? options.defaultMaxTokens,
    input: [...model.inputModalities],
    reasoningEfforts: metadata?.reasoning === true ? reasoningEfforts(metadata) : false,
  }
}

function profilesFor(models: readonly XaiCatalogModel[], options: XaiConnectionOptions): ReadonlyMap<string, ResolvedPiAiProviderProfile> {
  const known = new Map(xaiProvider().getModels().map(model => [model.id, model]))
  const resolved = resolveProfiles({
    [XAI_OAUTH_PROVIDER]: {
      displayName: 'xAI (Grok)',
      api: 'openai-responses',
      baseURL: options.baseURL,
      models: models.map(model => modelProfile(model, known, options)),
      defaultContextWindow: options.defaultContextWindow,
      defaultMaxTokens: options.defaultMaxTokens,
      streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    },
  })
  const profile = resolved.get(XAI_OAUTH_PROVIDER)
  /* v8 ignore next -- resolveProfiles preserves every validated provider key supplied above */
  if (profile === undefined) throw new Error('llm-xai: resolved profile is missing')
  return new Map([[XAI_OAUTH_PROVIDER, { ...profile, retryPolicy: options.retryPolicy }]])
}

function seedCatalog(): XaiCatalogModel[] {
  const responses = xaiProvider().getModels().filter(model => model.api === 'openai-responses')
  return responses.map(model => ({ id: model.id, aliases: [], inputModalities: [...model.input] }))
}

function authFailure(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof ModelAuthError) {
    const missing = ['NOT_AUTHENTICATED', 'NO_PROVIDER'].includes(error.code)
    return new LlmError(error.message, missing ? 'MISSING_CREDENTIAL' : 'AUTH', { cause: error })
  }
  return new LlmError('xAI authentication failed', 'AUTH', { cause: error })
}

function bearer(authorization: ModelAuthorization): string {
  const value = Object.entries(authorization.headers)
    .find(([name]) => name.toLowerCase() === 'authorization')?.[1]
  const match = value?.match(/^Bearer (.+)$/)
  if (match?.[1] === undefined) {
    throw new LlmError('xAI authentication produced no bearer token', 'AUTH')
  }
  return match[1]
}

/** xAI subscription adapter with an authenticated language-model catalog. */
export class XaiAdapter extends LlmAdapter {
  private cache: CatalogCache
  private readonly delegate: PiAiAdapter
  private readonly request: typeof fetch

  constructor(private readonly config: XaiAdapterOptions) {
    super()
    this.request = config.fetch ?? fetch
    this.cache = { expiresAt: 0, profiles: profilesFor(seedCatalog(), config.options()) }
    this.delegate = new PiAiAdapter({
      profiles: () => this.cache.profiles,
      resolveApiKey: async () => {
        try {
          return bearer(await this.config.modelAuth.resolve(XAI_OAUTH_PROVIDER))
        } catch (error) {
          throw authFailure(error)
        }
      },
    })
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return this.delegate.providerInfo(provider)
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.delegate.providerRetryPolicy(provider)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    try {
      await this.catalog()
    } catch (error) {
      if (!(error instanceof LlmError) || error.code !== 'MISSING_CREDENTIAL') throw error
    }
    return this.delegate.listModels(provider)
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    try {
      await this.catalog(signal)
    } catch (error) {
      if (signal?.aborted || !(error instanceof LlmError) || error.code !== 'MISSING_CREDENTIAL') throw error
    }
    return this.delegate.resolveModel(provider, model, signal)
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.catalog(options.signal)
    yield* this.delegate.stream(options)
  }

  private catalog(signal?: AbortSignal): Promise<ReadonlyMap<string, ResolvedPiAiProviderProfile>> {
    if (Date.now() < this.cache.expiresAt) return Promise.resolve(this.cache.profiles)
    return this.fetchCatalog(signal)
  }

  private async fetchCatalog(signal?: AbortSignal): Promise<ReadonlyMap<string, ResolvedPiAiProviderProfile>> {
    let authorization: ModelAuthorization
    try {
      authorization = await this.config.modelAuth.resolve(XAI_OAUTH_PROVIDER, signal)
    } catch (error) {
      throw authFailure(error)
    }
    let response = await this.request(`${this.config.options().baseURL}/language-models`, {
      headers: authorization.headers,
      ...signal === undefined ? {} : { signal },
    })
    if (response.status === 401) {
      await response.body?.cancel()
      try {
        authorization = await this.config.modelAuth.refresh(XAI_OAUTH_PROVIDER, signal)
      } catch (error) {
        throw authFailure(error)
      }
      response = await this.request(`${this.config.options().baseURL}/language-models`, {
        headers: authorization.headers,
        ...signal === undefined ? {} : { signal },
      })
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new LlmError(`xAI model catalog request failed (HTTP ${response.status})`,
        response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 429 ? 'RATE_LIMIT' : 'SERVER',
        { status: response.status })
    }
    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      throw new LlmError('xAI model catalog returned invalid JSON', 'MALFORMED_RESPONSE', { cause: error })
    }
    const options = this.config.options()
    const profiles = profilesFor(parseCatalog(body), options)
    this.cache = { profiles, expiresAt: Date.now() + options.modelCacheTtlMs }
    return profiles
  }
}
