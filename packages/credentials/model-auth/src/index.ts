/**
 * Service Definition for model-provider authentication (`ctx.modelAuth`).
 * Auth drivers own provider protocols and opaque durable records; the service
 * owns registration, login lifecycle, persistence, refresh serialization, and
 * safe status. Credential values remain Host-only.
 * @module @deepseek-ai/dsh-model-auth
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ModelAuthAccount,
  ModelAuthLoginAttemptId,
  ModelAuthLoginChallenge,
  ModelAuthLoginMethod,
  ModelAuthProviderId,
  ModelAuthProviderStatus,
} from './types.ts'

export type {
  ModelAuthAccount,
  ModelAuthLoginAttemptId,
  ModelAuthLoginChallenge,
  ModelAuthLoginMethod,
  ModelAuthProviderId,
  ModelAuthProviderStatus,
} from './types.ts'

const PROVIDER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Validate and brand one auth-provider id.
 * @param value - candidate lowercase provider key.
 * @returns the validated nominal id.
 */
export function modelAuthProviderId(value: string): ModelAuthProviderId {
  if (!PROVIDER_ID_PATTERN.test(value)) {
    throw new TypeError(`model auth provider id "${value}" must match ${String(PROVIDER_ID_PATTERN)}`)
  }
  return value as ModelAuthProviderId
}

/**
 * Brand a process-generated login-attempt id.
 * @param value - non-empty process-generated identifier.
 * @returns the nominal login-attempt id.
 */
export function modelAuthLoginAttemptId(value: string): ModelAuthLoginAttemptId {
  if (value.length === 0) throw new TypeError('model auth login attempt id must be non-empty')
  return value as ModelAuthLoginAttemptId
}

/** Stable model-auth failure with a machine-routing code. */
export class ModelAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ModelAuthError'
  }
}

/** Host-only authorization facts returned to a provider adapter. */
export interface ModelAuthorization {
  /** HTTP headers, including secret values, for one provider operation. */
  headers: Readonly<Record<string, string>>
}

/** Driver-owned challenge before the service attaches provider and attempt ids. */
export type ModelAuthDriverChallenge =
  | { kind: 'browser'; authorizationUrl: string }
  | { kind: 'device'; verificationUrl: string; userCode: string; expiresAt: string }

/** One live provider login operation. */
export interface ModelAuthLoginOperation {
  /** Safe user action needed to continue the login. */
  challenge: ModelAuthDriverChallenge
  /** Opaque durable record produced after successful login. */
  completion: Promise<unknown>
  /** Request cancellation and settle only after provider resources close. */
  cancel(reason?: string): Promise<void>
}

/** Result of resolving and optionally refreshing one stored provider record. */
export interface ModelAuthResolution {
  /** Host-only request authorization. */
  authorization: ModelAuthorization
  /** Replacement durable record when refresh rotated or extended credentials. */
  record?: unknown
}

/** Context supplied for one provider authorization resolution. */
export interface ModelAuthResolveOptions {
  /** Force refresh even when the current credential has not reached its refresh window. */
  forceRefresh: boolean
  /** Caller cancellation, propagated through refresh I/O. */
  signal?: AbortSignal
}

/** Provider plugin contribution to the model-auth registry. */
export interface ModelAuthDriver {
  /** Stable registry id, normally shared with the LLM provider route. */
  id: ModelAuthProviderId
  /** Human-readable provider name. */
  displayName: string
  /** Login mechanisms implemented by this driver. */
  methods: readonly ModelAuthLoginMethod[]
  /** Start one interactive login and return only after its resources are ready. */
  startLogin(method: ModelAuthLoginMethod, signal: AbortSignal): Promise<ModelAuthLoginOperation>
  /** Validate an opaque durable record and derive safe account facts. */
  inspect(record: unknown): ModelAuthAccount
  /** Validate, refresh when required, and resolve request authorization. */
  resolve(record: unknown, options: ModelAuthResolveOptions): Promise<ModelAuthResolution>
  /** Provider-side logout or revocation before local deletion, when supported. */
  logout?(record: unknown, signal?: AbortSignal): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelAuth: ModelAuth
  }
}

/** Provider-neutral model authentication service. */
export abstract class ModelAuth extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'modelAuth')
  }

  /**
   * Register one provider driver for the contributing plugin's lifetime.
   * @param driver - provider protocol implementation.
   * @returns effect disposer that unregisters the driver after its work settles.
   */
  abstract register(driver: ModelAuthDriver): () => void

  /**
   * Whether a driver is currently registered under this id.
   * @param provider - provider registry id.
   * @returns whether that driver is live.
   */
  abstract hasProvider(provider: ModelAuthProviderId): boolean

  /**
   * List registered providers without exposing credential values.
   * @returns safe status and any live login challenge in registration order.
   */
  abstract list(): Promise<ModelAuthProviderStatus[]>

  /**
   * Read safe status for one registered provider.
   * @param provider - provider registry id.
   * @returns current browser-safe lifecycle, live challenge, and account facts.
   */
  abstract status(provider: ModelAuthProviderId): Promise<ModelAuthProviderStatus>

  /**
   * Start a login after provider resources are ready.
   * @param provider - provider registry id.
   * @param method - registered browser or device mechanism.
   * @returns the safe user action needed to continue.
   */
  abstract beginLogin(
    provider: ModelAuthProviderId,
    method: ModelAuthLoginMethod,
  ): Promise<ModelAuthLoginChallenge>

  /**
   * Cancel one live login and wait for its provider resources to close.
   * @param attemptId - live attempt returned by {@link beginLogin}.
   */
  abstract cancelLogin(attemptId: ModelAuthLoginAttemptId): Promise<void>

  /**
   * Resolve current request authorization, refreshing inside the provider operation when required.
   * @param provider - provider registry id.
   * @param signal - caller cancellation for refresh I/O.
   * @returns Host-only request authorization headers.
   */
  abstract resolve(provider: ModelAuthProviderId, signal?: AbortSignal): Promise<ModelAuthorization>

  /**
   * Force a refresh and return the resulting request authorization.
   * @param provider - provider registry id.
   * @param signal - caller cancellation for refresh I/O.
   * @returns Host-only request authorization headers.
   */
  abstract refresh(provider: ModelAuthProviderId, signal?: AbortSignal): Promise<ModelAuthorization>

  /**
   * Complete provider logout and remove the local durable record.
   * @param provider - provider registry id.
   * @param signal - caller cancellation for provider logout I/O.
   */
  abstract logout(provider: ModelAuthProviderId, signal?: AbortSignal): Promise<void>

  /**
   * List browser-safe authentication state through the generated Remote API.
   * @returns safe status for every registered provider.
   */
  @Remote('list')
  remoteList(): Promise<ModelAuthProviderStatus[]> {
    return this.list()
  }

  /**
   * Begin an interactive provider login through the generated Remote API.
   * @param provider - untrusted wire provider id.
   * @param method - requested browser or device mechanism.
   * @returns the safe user action needed to continue.
   */
  @Remote('beginLogin')
  remoteBeginLogin(provider: string, method: ModelAuthLoginMethod): Promise<ModelAuthLoginChallenge> {
    return this.beginLogin(modelAuthProviderId(provider), method)
  }

  /**
   * Cancel a live login through the generated Remote API.
   * @param attemptId - untrusted wire login-attempt id.
   * @returns after provider resources close.
   */
  @Remote('cancelLogin')
  remoteCancelLogin(attemptId: string): Promise<void> {
    return this.cancelLogin(modelAuthLoginAttemptId(attemptId))
  }

  /**
   * Remove one provider's stored authentication through the generated Remote API.
   * @param provider - untrusted wire provider id.
   * @param signal - request cancellation propagated into provider logout.
   * @returns after provider logout and local deletion commit.
   */
  @Remote('logout')
  remoteLogout(provider: string, signal: AbortSignal): Promise<void> {
    return this.logout(modelAuthProviderId(provider), signal)
  }

  /** Emit a value-free status invalidation after the underlying change commits. */
  protected notifyUpdated(provider: ModelAuthProviderId): void {
    let invariantFailure: unknown
    const args = ['model-auth/updated', provider]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...values: unknown[]) => unknown>) {
      try {
        const returned = listener(provider)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).catch((error: unknown) => {
            this.warnListenerFailure(provider, error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnListenerFailure(provider, error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }

  /** Contain one observer failure without changing the committed auth operation. */
  private warnListenerFailure(provider: ModelAuthProviderId, error: unknown): void {
    this.ctx.logger.warn('model-auth: a model-auth/updated listener for "%s" failed', provider)
    this.ctx.logger.warn(error)
  }
}

export default ModelAuth
