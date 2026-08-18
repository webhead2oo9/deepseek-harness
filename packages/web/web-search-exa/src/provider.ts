/**
 * Exa-backed `WebSearchProvider`: resolves credentials per operation, calls
 * `POST /search` without following redirects, validates external JSON, and
 * maps Exa result metadata and highlights into the provider-neutral web result.
 *
 * @module @deepseek-ai/dsh-web-search-exa/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { ExaError, ExaResult, ExaSearchRequest, ExaSearchResponse, ExaSearchType } from './types.ts'

/** Stable id this provider registers under. */
export const EXA_PROVIDER_ID = 'exa'

/** Default Exa endpoint base; `/search` is appended. */
export const EXA_DEFAULT_BASE_URL = 'https://api.exa.ai'

/** Balanced Exa retrieval mode used unless configuration selects another. */
export const EXA_DEFAULT_SEARCH_TYPE: ExaSearchType = 'auto'

/** Exa moderation is enabled by default for the shipped provider. */
export const EXA_DEFAULT_MODERATION = true

/** Attribution header sent on every request. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved options for one Exa search operation. */
export interface ExaSearchProviderOptions {
  /** Literal key for configuration compatibility; prefer {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current credential for each operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named in a missing-key diagnostic. */
  apiKeyEnv?: string
  /** Endpoint base; `/search` is appended. */
  baseURL: string
  /** Standard Exa retrieval mode. */
  searchType: ExaSearchType
  /** Default result count when a request carries no `maxResults`. */
  numResults?: number
  /** Whether Exa filters unsafe results. */
  moderation: boolean
  /** Optional per-result highlight character budget. */
  highlightsMaxCharacters?: number
  /** Optional maximum cached-content age; `0` fetches fresh and `-1` is cache-only. */
  maxAgeHours?: number
}

/**
 * Map one validated Exa result to the provider-neutral source fields.
 * Results without highlights remain useful citations because the shared type
 * permits a URL and title without a snippet.
 * @param result - one validated Exa result.
 * @returns the normalized source.
 */
export function mapExaResult(result: ExaResult): WebSearchSource {
  const snippet = result.highlights?.find(highlight => highlight.trim().length > 0)
  return {
    url: result.url,
    ...typeof result.title === 'string' && result.title.length > 0 ? { title: result.title } : {},
    ...snippet !== undefined ? { snippet } : {},
    ...typeof result.publishedDate === 'string' && result.publishedDate.length > 0
      ? { publishedAt: result.publishedDate }
      : {},
  }
}

/**
 * Map a validated Exa envelope into the shared search result.
 * @param response - validated `POST /search` response.
 * @returns normalized sources; Exa supplies no generated answer in standard modes.
 */
export function mapExaResponse(response: ExaSearchResponse): WebSearchResult {
  return { sources: response.results.map(mapExaResult), truncated: false }
}

/** Exa-backed provider; settings are snapshotted once at operation entry. */
export class ExaSearchProvider implements WebSearchProvider {
  readonly id = EXA_PROVIDER_ID

  /** @param resolveOptions - current settings projected for the next operation. */
  constructor(private readonly resolveOptions: () => ExaSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && isSearchType(options.searchType)
      && (options.numResults === undefined || isIntegerInRange(options.numResults, 1, 100))
      && (options.highlightsMaxCharacters === undefined
        || isIntegerInRange(options.highlightsMaxCharacters, 1, 10_000))
      && (options.maxAgeHours === undefined || isIntegerInRange(options.maxAgeHours, -1, 720))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options, signal)
    throwIfSearchAborted(signal)
    const numResults = request.maxResults ?? options.numResults
    const contents: ExaSearchRequest['contents'] = {
      highlights: options.highlightsMaxCharacters === undefined
        ? true
        : { maxCharacters: options.highlightsMaxCharacters },
      ...options.maxAgeHours === undefined ? {} : { maxAgeHours: options.maxAgeHours },
    }
    const body: ExaSearchRequest = {
      query: request.query,
      type: options.searchType,
      moderation: options.moderation,
      contents,
      ...numResults === undefined ? {} : { numResults },
    }

    let response: Response
    try {
      response = await fetch(`${options.baseURL}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'x-api-key': apiKey,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(`Exa search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Exa API error (HTTP ${status})`
      try {
        const parsed = await response.json() as ExaError
        const detail = parsed.error ?? parsed.message
        if (typeof detail === 'string' && detail.length > 0) message = detail
      } catch (error: unknown) {
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      return mapExaResponse(parseExaResponse(await response.json()))
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      if (error instanceof WebError) throw error
      throw new WebError(`Exa returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', {
        cause: error,
      })
    }
  }

  /** Resolve one operation's credential without retaining it on the provider. */
  private async apiKey(options: ExaSearchProviderOptions, signal?: AbortSignal): Promise<string> {
    throwIfSearchAborted(signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(`Exa credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = options.apiKeyEnv ?? 'EXA_API_KEY'
    throw new WebError(
      `Exa search has no API key for "${ref}"; store it through the credentials service, export it in the launching environment, or set a literal "apiKey" in the web-search-exa config`,
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/** Validate the external response fields the mapper reads. */
function parseExaResponse(value: unknown): ExaSearchResponse {
  if (!isRecord(value) || !Array.isArray(value.results)) throw new TypeError('expected an object with results[]')
  return { results: value.results.map((entry, index) => parseExaResult(entry, index)) }
}

/** Validate one external result without retaining provider-private fields. */
function parseExaResult(value: unknown, index: number): ExaResult {
  if (!isRecord(value) || typeof value.url !== 'string' || value.url.length === 0) {
    throw new TypeError(`results[${index}].url must be a non-empty string`)
  }
  if (value.title !== undefined && value.title !== null && typeof value.title !== 'string') {
    throw new TypeError(`results[${index}].title must be a string`)
  }
  if (value.publishedDate !== undefined && value.publishedDate !== null && typeof value.publishedDate !== 'string') {
    throw new TypeError(`results[${index}].publishedDate must be a string`)
  }
  if (value.highlights !== undefined
    && (!Array.isArray(value.highlights) || value.highlights.some(item => typeof item !== 'string'))) {
    throw new TypeError(`results[${index}].highlights must be a string array`)
  }
  return {
    url: value.url,
    ...typeof value.title === 'string' ? { title: value.title } : {},
    ...typeof value.publishedDate === 'string' ? { publishedDate: value.publishedDate } : {},
    ...Array.isArray(value.highlights) ? { highlights: value.highlights as string[] } : {},
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSearchType(value: string): value is ExaSearchType {
  return value === 'auto' || value === 'fast' || value === 'instant'
}

function isIntegerInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(searchAborted(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(searchAborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
      },
    )
  })
}

function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('Exa search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
