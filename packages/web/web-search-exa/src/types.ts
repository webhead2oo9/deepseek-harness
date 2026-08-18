/**
 * Wire types for Exa `POST /search`. These types cover only fields the
 * provider sends or retains; provider-private response fields stay outside the
 * normalized web result.
 *
 * @module @deepseek-ai/dsh-web-search-exa/types
 */

/** Standard retrieval modes that return ordinary search results. */
export type ExaSearchType = 'auto' | 'fast' | 'instant'

/** Request body sent to Exa's search endpoint. */
export interface ExaSearchRequest {
  /** Natural-language search query. */
  query: string
  /** Retrieval mode. */
  type: ExaSearchType
  /** Result count sent as a cost and latency optimization. */
  numResults?: number
  /** Ask Exa to filter unsafe results. */
  moderation: boolean
  /** Focused result excerpts and their freshness policy. */
  contents: {
    highlights: true | { maxCharacters: number }
    maxAgeHours?: number
  }
}

/** One entry of Exa's flat `results[]`. */
export interface ExaResult {
  url: string
  title?: string
  publishedDate?: string
  highlights?: string[]
}

/** Exa's search response envelope after external JSON validation. */
export interface ExaSearchResponse {
  results: ExaResult[]
}

/** Exa's error response envelope (best-effort; fields vary by failure). */
export interface ExaError {
  error?: string
  message?: string
  requestId?: string
}
