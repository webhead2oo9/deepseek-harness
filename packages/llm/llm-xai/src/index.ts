/** Register xAI subscription OAuth and Grok Responses plugins. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_XAI_CONTEXT_WINDOW,
  DEFAULT_XAI_MAX_TOKENS,
  DEFAULT_XAI_MODEL_CACHE_TTL_MS,
  DEFAULT_XAI_STREAM_IDLE_TIMEOUT_MS,
  XAI_API_BASE_URL,
  XaiAdapter,
} from './adapter.ts'
import type { XaiConnectionOptions } from './adapter.ts'
import { XAI_OAUTH_PROVIDER, XaiAuthDriver } from './auth.ts'

export {
  DEFAULT_XAI_CONTEXT_WINDOW,
  DEFAULT_XAI_MAX_TOKENS,
  DEFAULT_XAI_MODEL_CACHE_TTL_MS,
  DEFAULT_XAI_STREAM_IDLE_TIMEOUT_MS,
  XAI_API_BASE_URL,
  XaiAdapter,
} from './adapter.ts'
export type { XaiAdapterOptions, XaiConnectionOptions } from './adapter.ts'
export { parseXaiAuthRecord, XAI_OAUTH_PROVIDER, XaiAuthDriver } from './auth.ts'
export type { XaiAuthRecord } from './auth.ts'

export const name = 'llm-xai'
export const inject = ['llm', 'modelAuth']

/** xAI OAuth provider configuration. */
export interface Config {
  /** xAI API root. Production credentials may only be sent to x.ai hosts. */
  baseURL?: string
  /** Context capacity for discovered models without static metadata. */
  defaultContextWindow?: number
  /** Output capacity for discovered models without static metadata. */
  defaultMaxTokens?: number
  /** Maximum silence between streaming response events in milliseconds. */
  streamIdleTimeoutMs?: number
  /** Lifetime of a successful model-discovery result in milliseconds. */
  modelCacheTtlMs?: number
  /** Retry policy for retryable xAI model requests. */
  retryPolicy?: RetryPolicyConfig
}

/** Runtime schema for xAI OAuth provider configuration. */
export const Config: z<Config> = z.object({
  baseURL: z.string().default(XAI_API_BASE_URL),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_XAI_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_XAI_MAX_TOKENS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_XAI_STREAM_IDLE_TIMEOUT_MS),
  modelCacheTtlMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_XAI_MODEL_CACHE_TTL_MS),
  retryPolicy: RetryPolicySchema,
})

function normalizedBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new Error('llm-xai: baseURL must be an absolute URL', { cause: error })
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  const xai = url.hostname === 'x.ai' || url.hostname.endsWith('.x.ai')
  if ((!xai || url.protocol !== 'https:') && !(loopback && url.protocol === 'http:')) {
    throw new Error('llm-xai: baseURL must be an HTTPS x.ai endpoint, except for a loopback test endpoint')
  }
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new Error('llm-xai: baseURL must not include credentials, a query, or a fragment')
  }
  return url.toString().replace(/\/$/, '')
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`llm-xai: ${field} must be a positive safe integer`)
  }
  return resolved
}

function timer(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved <= 0 || resolved > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-xai: ${field} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return resolved
}

/**
 * Validate and default xAI provider configuration.
 * @param config - raw plugin configuration.
 * @returns immutable request and catalog parameters.
 */
export function resolveXaiOptions(config: Config): XaiConnectionOptions {
  const retryPolicy: ResolvedRetryPolicy = resolveRetryPolicy(config.retryPolicy, 'llm-xai: retryPolicy')
  return {
    baseURL: normalizedBaseUrl(config.baseURL ?? XAI_API_BASE_URL),
    defaultContextWindow: positiveInteger(config.defaultContextWindow, DEFAULT_XAI_CONTEXT_WINDOW, 'defaultContextWindow'),
    defaultMaxTokens: positiveInteger(config.defaultMaxTokens, DEFAULT_XAI_MAX_TOKENS, 'defaultMaxTokens'),
    streamIdleTimeoutMs: timer(config.streamIdleTimeoutMs, DEFAULT_XAI_STREAM_IDLE_TIMEOUT_MS, 'streamIdleTimeoutMs'),
    modelCacheTtlMs: timer(config.modelCacheTtlMs, DEFAULT_XAI_MODEL_CACHE_TTL_MS, 'modelCacheTtlMs'),
    retryPolicy,
  }
}

/**
 * Register the xAI auth driver and LLM route.
 * @param ctx - Cordis context carrying the LLM and model-auth services.
 * @param config - raw plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const options = resolveXaiOptions(config)
  ctx.modelAuth.register(new XaiAuthDriver())
  ctx.llm.registerAdapter([XAI_OAUTH_PROVIDER], new XaiAdapter({
    options: () => options,
    modelAuth: ctx.modelAuth,
    resolveAttachments: () => ctx.get('attachments'),
  }))
}
