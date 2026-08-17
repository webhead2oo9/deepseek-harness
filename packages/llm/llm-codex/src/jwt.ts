/** JWT claim extraction and strict durable-record validation for Codex OAuth. */

import { ModelAuthError } from '@deepseek-ai/dsh-model-auth'
import type { ModelAuthAccount } from '@deepseek-ai/dsh-model-auth'

/** Native Codex OAuth record format. */
export const CODEX_AUTH_RECORD_VERSION = 0

/** Opaque record persisted by the model-auth provider. */
export interface CodexAuthRecord {
  version: typeof CODEX_AUTH_RECORD_VERSION
  idToken: string
  accessToken: string
  refreshToken: string
  refreshedAt: string
  accessTokenExpiresAt?: string
  accountId?: string
  email?: string
  plan?: string
  fedRamp: boolean
}

interface JwtClaims {
  exp?: unknown
  email?: unknown
  'https://api.openai.com/profile'?: unknown
  'https://api.openai.com/auth'?: unknown
}

/** Whether a value is a non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decode a JWT payload without treating its unverified claims as authorization.
 * @param token - provider-issued JWT string.
 * @returns decoded unverified claims used only for routing and display.
 */
export function decodeJwtClaims(token: string): JwtClaims {
  const parts = token.split('.')
  const payload = parts[1]
  if (parts.length !== 3 || payload === undefined || parts.some(part => part.length === 0)) {
    throw new ModelAuthError('OpenAI returned an invalid JWT', 'INVALID_TOKEN')
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
    if (!isObject(parsed)) throw new Error('payload is not an object')
    return parsed
  } catch (error) {
    throw new ModelAuthError('OpenAI returned an invalid JWT payload', 'INVALID_TOKEN', { cause: error })
  }
}

/** Parse a finite JWT expiration as an ISO instant. */
function expirationOf(token: string): string | undefined {
  const exp = decodeJwtClaims(token).exp
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined
  const date = new Date(exp * 1_000)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** Extract display-safe ChatGPT account fields from an ID token. */
function accountOf(idToken: string): Omit<CodexAuthRecord, 'version' | 'idToken' | 'accessToken' | 'refreshToken' | 'refreshedAt' | 'accessTokenExpiresAt'> {
  const claims = decodeJwtClaims(idToken)
  const profile = isObject(claims['https://api.openai.com/profile'])
    ? claims['https://api.openai.com/profile']
    : undefined
  const auth = isObject(claims['https://api.openai.com/auth'])
    ? claims['https://api.openai.com/auth']
    : undefined
  const email = typeof claims.email === 'string'
    ? claims.email
    : typeof profile?.email === 'string'
      ? profile.email
      : undefined
  const accountId = typeof auth?.chatgpt_account_id === 'string'
    ? auth.chatgpt_account_id
    : undefined
  const plan = typeof auth?.chatgpt_plan_type === 'string'
    ? auth.chatgpt_plan_type
    : undefined
  return {
    ...accountId === undefined ? {} : { accountId },
    ...email === undefined ? {} : { email },
    ...plan === undefined ? {} : { plan },
    fedRamp: auth?.chatgpt_account_is_fedramp === true,
  }
}

/**
 * Build a complete next record from an authorization or refresh exchange.
 * @param tokens - complete durable OAuth token set.
 * @returns validated record with extracted safe account facts.
 */
export function createCodexAuthRecord(tokens: {
  idToken: string
  accessToken: string
  refreshToken: string
}): CodexAuthRecord {
  if (tokens.idToken.length === 0 || tokens.accessToken.length === 0 || tokens.refreshToken.length === 0) {
    throw new ModelAuthError('OpenAI returned an incomplete OAuth token response', 'INVALID_TOKEN_RESPONSE')
  }
  const account = accountOf(tokens.idToken)
  const accessTokenExpiresAt = expirationOf(tokens.accessToken)
  return {
    version: CODEX_AUTH_RECORD_VERSION,
    idToken: tokens.idToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    refreshedAt: new Date().toISOString(),
    ...accessTokenExpiresAt === undefined ? {} : { accessTokenExpiresAt },
    ...account,
  }
}

/**
 * Apply a refresh response whose token fields may rotate independently.
 * @param current - validated durable record before refresh.
 * @param tokens - token fields returned by the refresh exchange.
 * @returns complete replacement record.
 */
export function refreshedCodexAuthRecord(
  current: CodexAuthRecord,
  tokens: { idToken?: string; accessToken?: string; refreshToken?: string },
): CodexAuthRecord {
  return createCodexAuthRecord({
    idToken: tokens.idToken ?? current.idToken,
    accessToken: tokens.accessToken ?? current.accessToken,
    refreshToken: tokens.refreshToken ?? current.refreshToken,
  })
}

/**
 * Validate one opaque durable record before any token reaches a request.
 * @param value - driver-owned value read from durable storage.
 * @returns detached validated record.
 */
export function parseCodexAuthRecord(value: unknown): CodexAuthRecord {
  if (!isObject(value)) throw new ModelAuthError('stored Codex authentication is invalid', 'INVALID_RECORD')
  const requiredStrings = ['idToken', 'accessToken', 'refreshToken', 'refreshedAt'] as const
  if (value.version !== CODEX_AUTH_RECORD_VERSION
    || requiredStrings.some(key => typeof value[key] !== 'string' || value[key].length === 0)
    || typeof value.fedRamp !== 'boolean') {
    throw new ModelAuthError('stored Codex authentication is invalid', 'INVALID_RECORD')
  }
  for (const key of ['accessTokenExpiresAt', 'accountId', 'email', 'plan'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length === 0)) {
      throw new ModelAuthError('stored Codex authentication is invalid', 'INVALID_RECORD')
    }
  }
  const refreshedAt = new Date(value.refreshedAt as string)
  if (Number.isNaN(refreshedAt.getTime())) {
    throw new ModelAuthError('stored Codex authentication has an invalid refresh time', 'INVALID_RECORD')
  }
  if (value.accessTokenExpiresAt !== undefined
    && Number.isNaN(new Date(value.accessTokenExpiresAt as string).getTime())) {
    throw new ModelAuthError('stored Codex authentication has an invalid expiration', 'INVALID_RECORD')
  }
  return {
    version: CODEX_AUTH_RECORD_VERSION,
    idToken: value.idToken as string,
    accessToken: value.accessToken as string,
    refreshToken: value.refreshToken as string,
    refreshedAt: value.refreshedAt as string,
    ...value.accessTokenExpiresAt === undefined
      ? {}
      : { accessTokenExpiresAt: value.accessTokenExpiresAt as string },
    ...value.accountId === undefined ? {} : { accountId: value.accountId as string },
    ...value.email === undefined ? {} : { email: value.email as string },
    ...value.plan === undefined ? {} : { plan: value.plan as string },
    fedRamp: value.fedRamp,
  }
}

/**
 * Project one validated record into display-safe status.
 * @param record - validated durable Codex record.
 * @returns account facts safe for Remote APIs and UIs.
 */
export function codexAccount(record: CodexAuthRecord): ModelAuthAccount {
  return {
    ...record.accountId === undefined ? {} : { accountId: record.accountId },
    ...record.email === undefined ? {} : { email: record.email },
    ...record.plan === undefined ? {} : { plan: record.plan },
  }
}
