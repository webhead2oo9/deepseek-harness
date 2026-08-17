/** Register native ChatGPT Codex OAuth and Responses plugins. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { CodexAdapter } from './adapter.ts'
import {
  DEFAULT_CODEX_CONTEXT_WINDOW,
  DEFAULT_CODEX_MODEL_CACHE_TTL_MS,
  DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS,
} from './adapter.ts'
import type { CodexConnectionOptions } from './adapter.ts'
import { CodexAuthDriver, CODEX_PROVIDER } from './auth.ts'
import type { CodexOAuthOptions } from './oauth.ts'

export { CodexAdapter } from './adapter.ts'
export type { CodexAdapterOptions, CodexConnectionOptions } from './adapter.ts'
export { CodexAuthDriver, CODEX_PROVIDER } from './auth.ts'
export type { CodexAuthRecord } from './jwt.ts'
export type { CodexOAuthOptions } from './oauth.ts'
export { parseCodexReplayState, serializeCodexMessages, serializeCodexRequest } from './serialize.ts'
export type { CodexReplayState } from './serialize.ts'
export { translateCodex } from './translate.ts'
export type * from './types.ts'

export const name = 'llm-codex'
export const inject = ['llm', 'modelAuth']

/** Public OAuth client id used by the upstream Codex CLI. */
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
/** Default OpenAI OAuth issuer. */
export const OPENAI_AUTH_ISSUER = 'https://auth.openai.com'
/** Default ChatGPT Codex backend. */
export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
/** Default loopback callback ports, in bind order. */
export const DEFAULT_CODEX_CALLBACK_PORTS = [1455, 1457] as const
/** Default browser and device login lifetime. */
export const DEFAULT_CODEX_LOGIN_TIMEOUT_MS = 900_000
/** Default access-token proactive refresh window. */
export const DEFAULT_CODEX_REFRESH_WINDOW_MS = 300_000
/** Refresh interval for records whose access token has no expiry claim. */
export const DEFAULT_CODEX_REFRESH_INTERVAL_MS = 691_200_000
/** Codex protocol version advertised for server-side model compatibility filtering. */
export const DEFAULT_CODEX_CLIENT_VERSION = '0.147.0'

/** Plugin configuration for the native Codex provider. */
export interface Config {
  /** OpenAI OAuth issuer URL. */
  issuer?: string
  /** Public OAuth client id for the Codex application. */
  clientId?: string
  /** Client identifier sent with Codex backend requests. */
  originator?: string
  /** Loopback ports tried in order for browser login callbacks. */
  callbackPorts?: number[]
  /** Maximum browser-login lifetime in milliseconds. */
  loginTimeoutMs?: number
  /** Maximum device-login lifetime in milliseconds. */
  deviceTimeoutMs?: number
  /** Time before access-token expiry when proactive refresh begins. */
  refreshWindowMs?: number
  /** Refresh interval for access tokens without an expiry claim. */
  refreshIntervalMs?: number
  /** ChatGPT workspace ids accepted after login; empty accepts any workspace. */
  allowedWorkspaceIds?: string[]
  /** ChatGPT Codex Responses backend URL. */
  baseURL?: string
  /** Codex protocol compatibility version sent for model-catalog filtering. */
  clientVersion?: string
  /** Context-window fallback for models that omit it from discovery. */
  defaultContextWindow?: number
  /** Maximum silence between streaming response events in milliseconds. */
  streamIdleTimeoutMs?: number
  /** Lifetime of a successful model-discovery result in milliseconds. */
  modelCacheTtlMs?: number
  /** Retry policy for retryable Codex backend requests. */
  retryPolicy?: RetryPolicyConfig
}

/** Fully resolved native Codex plugin parameters. */
export interface ResolvedCodexOptions {
  /** OAuth driver parameters. */
  oauth: CodexOAuthOptions
  /** Responses adapter parameters. */
  connection: CodexConnectionOptions
}

export const Config: z<Config> = z.object({
  issuer: z.string().default(OPENAI_AUTH_ISSUER),
  clientId: z.string().default(CODEX_OAUTH_CLIENT_ID),
  originator: z.string().default('deepseek_harness'),
  callbackPorts: z.array(z.number().step(1).min(1).max(65_535)).default([...DEFAULT_CODEX_CALLBACK_PORTS]),
  loginTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CODEX_LOGIN_TIMEOUT_MS),
  deviceTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CODEX_LOGIN_TIMEOUT_MS),
  refreshWindowMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CODEX_REFRESH_WINDOW_MS),
  refreshIntervalMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CODEX_REFRESH_INTERVAL_MS),
  allowedWorkspaceIds: z.array(z.string()).default([]),
  baseURL: z.string().default(CHATGPT_CODEX_BASE_URL),
  clientVersion: z.string().default(DEFAULT_CODEX_CLIENT_VERSION),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CODEX_CONTEXT_WINDOW),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS),
  modelCacheTtlMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CODEX_MODEL_CACHE_TTL_MS),
  retryPolicy: RetryPolicySchema,
})

function normalizedHttpUrl(value: string, field: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new Error(`llm-codex: ${field} must be an absolute URL`, { cause: error })
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`llm-codex: ${field} must use HTTPS, except for a loopback test endpoint`)
  }
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new Error(`llm-codex: ${field} must not include credentials, a query, or a fragment`)
  }
  return url.toString().replace(/\/$/, '')
}

function timer(value: number | undefined, fallback: number, field: string, allowZero = false): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved)
    || (allowZero ? resolved < 0 : resolved <= 0)
    || resolved > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-codex: ${field} must be ${allowZero ? 'a non-negative' : 'a positive'} finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return resolved
}

/**
 * Validate, default, and detach native Codex plugin configuration.
 * @param config - raw plugin configuration.
 * @returns operation parameters for OAuth and Responses requests.
 */
export function resolveCodexOptions(config: Config): ResolvedCodexOptions {
  const callbackPorts = config.callbackPorts ?? [...DEFAULT_CODEX_CALLBACK_PORTS]
  if (callbackPorts.length === 0
    || callbackPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65_535)
    || new Set(callbackPorts).size !== callbackPorts.length) {
    throw new Error('llm-codex: callbackPorts must contain unique integers from 1 through 65535')
  }
  const allowedWorkspaceIds = config.allowedWorkspaceIds ?? []
  if (allowedWorkspaceIds.some(id => id.length === 0) || new Set(allowedWorkspaceIds).size !== allowedWorkspaceIds.length) {
    throw new Error('llm-codex: allowedWorkspaceIds must contain unique non-empty strings')
  }
  const clientId = config.clientId ?? CODEX_OAUTH_CLIENT_ID
  const originator = config.originator ?? 'deepseek_harness'
  const clientVersion = config.clientVersion ?? DEFAULT_CODEX_CLIENT_VERSION
  if (clientId.trim().length === 0) throw new Error('llm-codex: clientId must be non-empty')
  if (!/^[\x21-\x7e]+$/.test(originator)) throw new Error('llm-codex: originator must be a printable HTTP token')
  if (clientVersion.trim().length === 0) throw new Error('llm-codex: clientVersion must be non-empty')
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CODEX_CONTEXT_WINDOW
  if (!Number.isSafeInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error('llm-codex: defaultContextWindow must be a positive safe integer')
  }
  const retryPolicy: ResolvedRetryPolicy = resolveRetryPolicy(config.retryPolicy, 'llm-codex: retryPolicy')
  return {
    oauth: {
      issuer: normalizedHttpUrl(config.issuer ?? OPENAI_AUTH_ISSUER, 'issuer'),
      clientId,
      originator,
      callbackPorts: [...callbackPorts],
      loginTimeoutMs: timer(config.loginTimeoutMs, DEFAULT_CODEX_LOGIN_TIMEOUT_MS, 'loginTimeoutMs'),
      deviceTimeoutMs: timer(config.deviceTimeoutMs, DEFAULT_CODEX_LOGIN_TIMEOUT_MS, 'deviceTimeoutMs'),
      refreshWindowMs: timer(config.refreshWindowMs, DEFAULT_CODEX_REFRESH_WINDOW_MS, 'refreshWindowMs', true),
      refreshIntervalMs: timer(config.refreshIntervalMs, DEFAULT_CODEX_REFRESH_INTERVAL_MS, 'refreshIntervalMs'),
      allowedWorkspaceIds: [...allowedWorkspaceIds],
    },
    connection: {
      baseURL: normalizedHttpUrl(config.baseURL ?? CHATGPT_CODEX_BASE_URL, 'baseURL'),
      clientVersion,
      defaultContextWindow,
      streamIdleTimeoutMs: timer(config.streamIdleTimeoutMs, DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS, 'streamIdleTimeoutMs'),
      modelCacheTtlMs: timer(config.modelCacheTtlMs, DEFAULT_CODEX_MODEL_CACHE_TTL_MS, 'modelCacheTtlMs'),
      retryPolicy,
    },
  }
}

/**
 * Register the Codex auth driver and LLM route.
 * @param ctx - Cordis context carrying the LLM and model-auth services.
 * @param config - raw plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveCodexOptions(config)
  ctx.modelAuth.register(new CodexAuthDriver(resolved.oauth))
  ctx.llm.registerAdapter([CODEX_PROVIDER], new CodexAdapter({
    options: () => resolved.connection,
    modelAuth: ctx.modelAuth,
  }))
}
