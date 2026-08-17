/** Provider-neutral model authentication cards for the Models settings page. */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelAuthLoginMethod, ModelAuthProviderStatus } from '@deepseek-ai/dsh-model-auth/types'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Generated Remote methods used by the model-auth cards. */
export type ModelAuthRemote = ClientRemote['modelAuth']

async function remoteValue<T>(
  operation: Promise<{ ok: true; value: T } | { ok: false; error: { code: string; message: string } }>,
): Promise<T> {
  const result = await operation
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Browser-safe authentication snapshot. */
export interface ModelAuthState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  providers: readonly ModelAuthProviderStatus[]
  error?: string
}

/** Store for authentication status invalidated by forwarded Host events. */
export class ModelAuthStore {
  readonly store: SnapshotStore<ModelAuthState> = createSnapshotStore<ModelAuthState>({
    status: 'idle', providers: [],
  })
  private generation = 0

  /** @param remote - generated model-auth Remote namespace. */
  constructor(private readonly remote: ModelAuthRemote) {}

  /** @returns after the latest safe status list has replaced the snapshot. */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => { state.status = 'loading'; delete state.error })
    try {
      const providers = await remoteValue(this.remote.list())
      if (generation !== this.generation) return
      this.store.update((state) => { state.status = 'ready'; state.providers = providers; delete state.error })
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'error'
        state.error = errorMessage(error)
      })
    }
  }
}

/** Injected model-auth card dependencies. */
export interface ModelAuthCardsInjected {
  controller: ModelAuthStore
  useSnapshot: SnapshotSelectorHook<ModelAuthState>
  remote: ModelAuthRemote
  /** Whether this browser shares the Host machine that owns loopback callbacks. */
  isLoopback: boolean
  t: (key: keyof typeof en) => string
}

/**
 * Render safe provider authentication state and interactive login actions.
 * @param injected - store, generated Remote methods, and localized copy.
 * @returns model-auth cards, or null when no provider driver is installed.
 */
export function ModelAuthCards({ controller, useSnapshot, remote, isLoopback, t }: ModelAuthCardsInjected): ReactNode {
  const state = useSnapshot(snapshot => snapshot)
  const [busy, setBusy] = useState<string | undefined>()
  const [failure, setFailure] = useState<string | undefined>()
  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [controller, state.status])
  if (state.status === 'ready' && state.providers.length === 0) return null

  const begin = (provider: string, method: ModelAuthLoginMethod): void => {
    setBusy(`${provider}:${method}`)
    setFailure(undefined)
    void remoteValue(remote.beginLogin(provider, method)).then((next) => {
      if (next.kind === 'browser') window.open(next.authorizationUrl, '_blank', 'noopener,noreferrer')
      void controller.load()
    }, (error: unknown) => {
      setFailure(errorMessage(error))
    }).finally(() => { setBusy(undefined) })
  }

  const logout = (provider: ModelAuthProviderStatus): void => {
    if (!window.confirm(t('signOutConfirm').replace('{provider}', provider.displayName))) return
    setBusy(`${provider.provider}:logout`)
    setFailure(undefined)
    void remoteValue(remote.logout(provider.provider)).then(() => {
      return controller.load()
    }, (error: unknown) => {
      setFailure(errorMessage(error))
    }).finally(() => { setBusy(undefined) })
  }

  const cancel = (active: NonNullable<ModelAuthProviderStatus['challenge']>): void => {
    setBusy(`${active.provider}:cancel`)
    void remoteValue(remote.cancelLogin(active.attemptId)).then(() => {
      return controller.load()
    }, (error: unknown) => {
      setFailure(errorMessage(error))
    }).finally(() => { setBusy(undefined) })
  }

  return (
    <div className={styles['authSection']}>
      <h3 className={styles['authTitle']}>{t('accountAuthentication')}</h3>
      {state.status === 'error' ? <p className={styles['error']}>{state.error}</p> : null}
      {failure === undefined ? null : <p className={styles['error']} role="alert">{failure}</p>}
      <ul className={styles['rows']}>
        {state.providers.map((provider) => {
          const challenge = provider.state === 'signing-in' ? provider.challenge : undefined
          return <li key={provider.provider} className={styles['rowCard']}>
            <div className={styles['rowHead']}>
              <span className={styles['rowIdentity']}>
                <span className={styles['rowName']}>{provider.displayName}</span>
                <span className={provider.state === 'signed-in'
                  ? `${styles['credentialDot']} ${styles['credentialDotConfigured']}`
                  : `${styles['credentialDot']} ${styles['credentialDotMissing']}`}
                role="img"
                aria-label={provider.state === 'signed-in' ? t('signedIn') : t('signedOut')}
                />
              </span>
              <span className={styles['rowActions']}>
                {provider.state === 'signed-in'
                  ? (
                    <button type="button" className={styles['dangerButton']}
                      disabled={busy !== undefined} onClick={() => { logout(provider) }}>
                      {t('signOut')}
                    </button>
                  )
                  : provider.methods.filter(method => method !== 'browser' || isLoopback).map(method => (
                    <button key={method} type="button" className={styles['secondaryButton']}
                      disabled={busy !== undefined || provider.state === 'signing-in'}
                      onClick={() => { begin(provider.provider, method) }}>
                      {method === 'browser' ? t('signInBrowser') : t('signInDevice')}
                    </button>
                  ))}
              </span>
            </div>
            {provider.account === undefined
              ? null
              : <p className={styles['authAccount']}>{[provider.account.email, provider.account.plan].filter(Boolean).join(' · ')}</p>}
            {provider.error === undefined ? null : <p className={styles['error']}>{provider.error}</p>}
            {challenge === undefined
              ? null
              : (
                <div className={styles['authChallenge']}>
                  {challenge.kind === 'browser'
                    ? <a href={challenge.authorizationUrl} target="_blank" rel="noreferrer">{t('continueSignIn')}</a>
                    : (
                      <p>{t('deviceCode').replace('{code}', challenge.userCode)}{' '}
                        <a href={challenge.verificationUrl} target="_blank" rel="noreferrer">{t('continueSignIn')}</a>
                      </p>
                    )}
                  <button type="button" className={styles['secondaryButton']} disabled={busy !== undefined} onClick={() => { cancel(challenge) }}>
                    {t('cancelSignIn')}
                  </button>
                </div>
              )}
          </li>
        })}
      </ul>
    </div>
  )
}
