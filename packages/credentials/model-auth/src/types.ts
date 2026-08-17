/**
 * Browser-safe model-auth identifiers, status records, login challenges, and
 * event declarations. This module contains no Host credential values.
 * @module @deepseek-ai/dsh-model-auth/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Nominal identifier for one model-auth driver. */
export type ModelAuthProviderId = Branded<'ModelAuthProviderId'>

/** Nominal identifier for one live login attempt. */
export type ModelAuthLoginAttemptId = Branded<'ModelAuthLoginAttemptId'>

/** Interactive login mechanisms understood by the generic auth surfaces. */
export type ModelAuthLoginMethod = 'browser' | 'device'

/** Account facts safe to display outside the Host process. */
export interface ModelAuthAccount {
  /** Provider-issued account or workspace identifier, when available. */
  accountId?: string
  /** Account email, when the provider includes it in authentication claims. */
  email?: string
  /** Provider subscription or account tier, when available. */
  plan?: string
}

/** Current safe state of one registered auth provider. */
export interface ModelAuthProviderStatus {
  /** Registered provider id. */
  provider: ModelAuthProviderId
  /** Human-readable provider name. */
  displayName: string
  /** Login methods the driver currently offers. */
  methods: readonly ModelAuthLoginMethod[]
  /** Authentication lifecycle state. */
  state: 'signed-out' | 'signing-in' | 'signed-in' | 'error'
  /** Reloadable user action for the live login while `state` is `signing-in`. */
  challenge?: ModelAuthLoginChallenge
  /** Safe account facts while signed in. */
  account?: ModelAuthAccount
  /** User-facing failure from the most recent login or stored-record read. */
  error?: string
}

/** Browser callback challenge returned by a provider login attempt. */
export interface ModelAuthBrowserChallenge {
  kind: 'browser'
  provider: ModelAuthProviderId
  attemptId: ModelAuthLoginAttemptId
  authorizationUrl: string
}

/** Device-code challenge returned by a provider login attempt. */
export interface ModelAuthDeviceChallenge {
  kind: 'device'
  provider: ModelAuthProviderId
  attemptId: ModelAuthLoginAttemptId
  verificationUrl: string
  userCode: string
  expiresAt: string
}

/** User action required to complete a live provider login. */
export type ModelAuthLoginChallenge = ModelAuthBrowserChallenge | ModelAuthDeviceChallenge

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A provider registration, login lifecycle, stored account, or logout
     * changed. The payload contains only the provider id; consumers re-read
     * status and no credential value crosses the event.
     * @param provider - provider whose safe status changed.
     * @mode emit
     */
    'model-auth/updated'(provider: ModelAuthProviderId): void
  }
}
