/** xAI subscription OAuth driver backed by pi-ai's device-code implementation. */

import { ModelAuthError, modelAuthProviderId } from '@deepseek-ai/dsh-model-auth'
import type {
  ModelAuthDriver,
  ModelAuthLoginMethod,
  ModelAuthLoginOperation,
  ModelAuthResolution,
  ModelAuthResolveOptions,
} from '@deepseek-ai/dsh-model-auth'
import type { AuthEvent, OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'

/** Provider route and auth-driver id for xAI subscription access. */
export const XAI_OAUTH_PROVIDER = modelAuthProviderId('xai-oauth')

/** Durable xAI OAuth record stored by the model-auth service. */
export type XaiAuthRecord = OAuthCredential

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one durable xAI OAuth record.
 * @param value - untrusted value read from durable model-auth storage.
 * @returns the validated credential.
 */
export function parseXaiAuthRecord(value: unknown): XaiAuthRecord {
  if (!isObject(value)
    || value.type !== 'oauth'
    || typeof value.access !== 'string'
    || value.access.length === 0
    || typeof value.refresh !== 'string'
    || value.refresh.length === 0
    || typeof value.expires !== 'number'
    || !Number.isFinite(value.expires)
    || value.expires <= 0) {
    throw new ModelAuthError('stored xAI OAuth credential is invalid', 'INVALID_RECORD')
  }
  return {
    ...value,
    type: 'oauth',
    access: value.access,
    refresh: value.refresh,
    expires: value.expires,
  }
}

function authFailure(action: string, error: unknown): ModelAuthError {
  if (error instanceof ModelAuthError) return error
  const cancelled = error instanceof Error && error.message === 'Login cancelled'
  return new ModelAuthError(
    cancelled ? `xAI OAuth ${action} was cancelled` : `xAI OAuth ${action} failed`,
    cancelled ? 'LOGIN_CANCELLED' : 'OAUTH_FAILED',
    { cause: error },
  )
}

function deviceChallenge(event: AuthEvent): ModelAuthLoginOperation['challenge'] | undefined {
  if (event.type !== 'device_code') return undefined
  if (event.userCode.length === 0
    || event.verificationUri.length === 0
    || event.expiresInSeconds === undefined
    || !Number.isFinite(event.expiresInSeconds)
    || event.expiresInSeconds <= 0) {
    throw new ModelAuthError('xAI OAuth returned an invalid device challenge', 'MALFORMED_RESPONSE')
  }
  return {
    kind: 'device',
    verificationUrl: event.verificationUri,
    userCode: event.userCode,
    expiresAt: new Date(Date.now() + event.expiresInSeconds * 1_000).toISOString(),
  }
}

function upstreamOAuth(): OAuthAuth {
  const oauth = xaiProvider().auth.oauth
  if (oauth === undefined) throw new Error('llm-xai: pi-ai xAI provider has no OAuth implementation')
  return oauth
}

/** xAI OAuth device-code driver. */
export class XaiAuthDriver implements ModelAuthDriver {
  readonly id = XAI_OAUTH_PROVIDER
  readonly displayName = 'xAI (Grok)'
  readonly methods = ['device'] as const satisfies readonly ModelAuthLoginMethod[]

  constructor(private readonly oauth: OAuthAuth = upstreamOAuth()) {}

  async startLogin(method: ModelAuthLoginMethod, signal: AbortSignal): Promise<ModelAuthLoginOperation> {
    if (method !== 'device') {
      throw new ModelAuthError(`xAI OAuth does not support login method "${method}"`, 'UNSUPPORTED_METHOD')
    }
    const owned = new AbortController()
    const combined = AbortSignal.any([signal, owned.signal])
    let publishChallenge!: (challenge: ModelAuthLoginOperation['challenge']) => void
    let rejectChallenge!: (error: unknown) => void
    const ready = new Promise<ModelAuthLoginOperation['challenge']>((resolve, reject) => {
      publishChallenge = resolve
      rejectChallenge = reject
    })
    let announced = false
    const completion = this.oauth.login({
      signal: combined,
      prompt: () => Promise.reject(new ModelAuthError(
        'xAI OAuth requested an unsupported interactive prompt',
        'INTERACTION_REQUIRED',
      )),
      notify: (event) => {
        if (announced) return
        try {
          const challenge = deviceChallenge(event)
          if (challenge === undefined) return
          announced = true
          publishChallenge(challenge)
        } catch (error) {
          announced = true
          owned.abort(error)
          rejectChallenge(error)
        }
      },
    }).then(parseXaiAuthRecord, (error: unknown) => {
      throw authFailure('login', error)
    })
    void completion.catch((error: unknown) => {
      if (!announced) {
        announced = true
        rejectChallenge(error)
      }
    })
    const challenge = await ready
    return {
      challenge,
      completion,
      cancel: async (reason?: string) => {
        owned.abort(new Error(reason ?? 'xAI OAuth login cancelled'))
        try {
          await completion
        } catch (_cancelledLogin) {
          // Cancellation owns this completion and only needs its resources quiescent.
        }
      },
    }
  }

  inspect(record: unknown): Record<string, never> {
    parseXaiAuthRecord(record)
    return {}
  }

  async resolve(record: unknown, options: ModelAuthResolveOptions): Promise<ModelAuthResolution> {
    const current = parseXaiAuthRecord(record)
    let resolved = current
    if (options.forceRefresh || Date.now() >= current.expires) {
      try {
        resolved = parseXaiAuthRecord(await this.oauth.refresh(current, options.signal))
      } catch (error) {
        throw authFailure('refresh', error)
      }
    }
    let apiKey: string | undefined
    try {
      apiKey = (await this.oauth.toAuth(resolved)).apiKey
    } catch (error) {
      throw authFailure('authorization', error)
    }
    if (apiKey === undefined || apiKey.length === 0) {
      throw new ModelAuthError('xAI OAuth produced no access token', 'INVALID_RECORD')
    }
    return {
      authorization: { headers: { authorization: `Bearer ${apiKey}` } },
      ...resolved === current ? {} : { record: resolved },
    }
  }
}
