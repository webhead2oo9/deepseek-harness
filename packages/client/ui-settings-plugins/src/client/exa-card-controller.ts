/** Exa search provider settings card controller. */

import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { SettingsScope, SettingsScopeSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  CardForm, booleanField, enumField, numberField, textField,
  type CardActions, type CardFieldState, type CardShell,
} from './card-form.ts'

/** Host settings namespace for the Exa provider. */
export const EXA_SEARCH_NS = 'web-search-exa'

const DEFAULT_API_KEY_REF = 'EXA_API_KEY'
const API_KEY_FIELD = 'apiKey'

/** Settings that the Exa card may write. */
export interface ExaSearchSettings {
  apiKeyEnv?: string
  baseURL?: string
  searchType?: 'auto' | 'fast' | 'instant'
  numResults?: number
  moderation?: boolean
  highlightsMaxCharacters?: number
  maxAgeHours?: number
}

interface CredentialState {
  ref: string
  configured: boolean
  writable: boolean
}

/** Rendered state for the Exa plugin card. */
export interface ExaSearchCardState extends CardShell {
  baseURL: CardFieldState
  searchType: CardFieldState
  numResults: CardFieldState
  moderation: CardFieldState
  highlightsMaxCharacters: CardFieldState
  maxAgeHours: CardFieldState
  apiKey: CardFieldState
  apiKeyConfigured: boolean
  apiKeyWritable: boolean
}

/** Face injected into the Exa card registration. */
export interface ExaSearchCardFace extends CardActions {
  hooks: { exaSearchCard: SnapshotStore<ExaSearchCardState> }
}

/** Bridge the Exa settings scope and credential domain to the Plugins card. */
export class ExaSearchCardController {
  private readonly form: CardForm<ExaSearchSettings>
  private readonly store: SnapshotStore<ExaSearchCardState>
  private credential: CredentialState = { ref: '', configured: false, writable: true }
  private credentialReadGeneration = 0

  /**
   * @param scope - bound Exa settings namespace.
   * @param api - credential RPC face.
   */
  constructor(
    private readonly scope: SettingsScope<ExaSearchSettings>,
    private readonly api: Pick<IApiClient, 'credentials'>,
  ) {
    this.form = new CardForm(
      scope,
      [
        textField('baseURL'),
        enumField('searchType', ['auto', 'fast', 'instant']),
        numberField('numResults'),
        booleanField('moderation'),
        numberField('highlightsMaxCharacters'),
        numberField('maxAgeHours'),
      ],
      [{ field: API_KEY_FIELD, write: text => this.writeKey(text) }],
    )
    this.store = this.form.bind(() => this.projection())
    scope.subscribe(() => { void this.readCredential() })
    void this.readCredential()
  }

  private projection(): ExaSearchCardState {
    return {
      ...this.form.shell(),
      baseURL: this.form.field('baseURL'),
      searchType: this.form.field('searchType'),
      numResults: this.form.field('numResults'),
      moderation: this.form.field('moderation'),
      highlightsMaxCharacters: this.form.field('highlightsMaxCharacters'),
      maxAgeHours: this.form.field('maxAgeHours'),
      apiKey: this.form.field(API_KEY_FIELD),
      apiKeyConfigured: this.credential.configured,
      apiKeyWritable: this.credential.writable,
    }
  }

  private async readCredential(): Promise<void> {
    const generation = ++this.credentialReadGeneration
    const ref = refOf(this.scope.getSnapshot())
    if (ref !== this.credential.ref) {
      this.credential = { ref, configured: false, writable: true }
      this.store.set(this.projection())
    }
    let response: Awaited<ReturnType<IApiClient['credentials']['describe']>>
    try {
      response = await this.api.credentials.describe({ refs: [ref] })
    } catch (_credentialReadFailure) {
      return
    }
    if (generation !== this.credentialReadGeneration
      || !response.result.ok
      || ref !== refOf(this.scope.getSnapshot())) return
    const view = response.result.value.credentials[ref]
    const next: CredentialState = {
      ref,
      configured: view?.configured ?? false,
      writable: view?.writable ?? true,
    }
    if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
    this.credential = next
    this.store.set(this.projection())
  }

  /**
   * Refresh the credential state when the Host reports this reference changed.
   * @param ref - credential reference reported by the Host.
   */
  refreshCredential(ref: string): void {
    if (ref === this.credential.ref) void this.readCredential()
  }

  /**
   * Return the card actions and rendered-state hook.
   * @returns the slot registration face.
   */
  inject(): ExaSearchCardFace {
    return { hooks: { exaSearchCard: this.store }, ...this.form.actions() }
  }

  private async writeKey(value: string): Promise<boolean> {
    try {
      await this.api.credentials.set({ ref: refOf(this.scope.getSnapshot()), value })
    } catch (_credentialWriteFailure) {
      // The following authoritative read determines whether the write landed.
    }
    await this.readCredential()
    return this.credential.configured
  }
}

function refOf(snapshot: SettingsScopeSnapshot<ExaSearchSettings>): string {
  const declared = snapshot.value?.apiKeyEnv
  return declared !== undefined && declared.length > 0 ? declared : DEFAULT_API_KEY_REF
}
