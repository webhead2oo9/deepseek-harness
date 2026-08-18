/** Host-backed state controller for subagent model-selection settings. */
import type { IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Host settings namespace edited by this package. */
export const SUBAGENT_SETTINGS_NS = 'subagent-model-selection'

/** One named model-selection profile. */
export interface SubagentProfile {
  description: string
  provider: string
  model: string
  instruction?: string | null
  reasoningEffort?: string | null
}

/** Editable value stored under the Host namespace. */
export interface SubagentSettingsValue {
  allowDirectModelSelection: boolean
  profiles: Record<string, SubagentProfile>
}

/** One adapter-owned reasoning effort suggested for an exact model route. */
export interface ReasoningEffortSuggestion {
  id: string
  name: string
  description?: string
}

/** Advisory provider/model metadata reported by a live adapter. */
export interface ModelSuggestion {
  provider: string
  providerName: string
  model: string
  modelName: string
  modelDescription?: string
  reasoningEfforts: readonly ReasoningEffortSuggestion[]
  defaultReasoningEffort?: string
}

/** Settings-section snapshot. */
export interface SubagentsState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'unavailable' | 'error'
  error: string | null
  writable: boolean
  revision: number
  value: SubagentSettingsValue
  /** Profile keys supplied by composition rather than the writable user layer. */
  baseProfileNames: readonly string[]
  /** Profile keys explicitly present in the writable user layer. */
  userProfileNames: readonly string[]
  suggestions: readonly ModelSuggestion[]
}

const EMPTY: SubagentSettingsValue = { allowDirectModelSelection: false, profiles: {} }

/**
 * Parse the namespace value while preserving arbitrary profile keys and model strings.
 * @param value - resolved settings namespace value.
 * @returns validated editable subagent settings.
 */
export function readValue(value: unknown): SubagentSettingsValue {
  if (typeof value !== 'object' || value === null) throw new Error('subagent settings value is not an object')
  const raw = value as { allowDirectModelSelection?: unknown; profiles?: unknown }
  if (typeof raw.allowDirectModelSelection !== 'boolean' || typeof raw.profiles !== 'object' || raw.profiles === null) {
    throw new Error('subagent settings value is incomplete')
  }
  const profiles: [string, SubagentProfile][] = []
  for (const [name, candidate] of Object.entries(raw.profiles)) {
    if (typeof candidate !== 'object' || candidate === null) throw new Error(`subagent profile ${name} is invalid`)
    const profile = candidate as Partial<SubagentProfile>
    if (
      typeof profile.description !== 'string'
      || typeof profile.provider !== 'string'
      || typeof profile.model !== 'string'
      || (profile.instruction !== undefined && profile.instruction !== null && typeof profile.instruction !== 'string')
      || (profile.reasoningEffort !== undefined && profile.reasoningEffort !== null && typeof profile.reasoningEffort !== 'string')
    ) {
      throw new Error(`subagent profile ${name} is invalid`)
    }
    profiles.push([name, {
      description: profile.description,
      provider: profile.provider,
      model: profile.model,
      ...profile.instruction === undefined ? {} : { instruction: profile.instruction },
      ...profile.reasoningEffort === undefined ? {} : { reasoningEffort: profile.reasoningEffort },
    }])
  }
  return { allowDirectModelSelection: raw.allowDirectModelSelection, profiles: Object.fromEntries(profiles) }
}

/** Read profile keys from one settings layer without requiring a complete resolved section. */
function profileNames(layer: unknown): string[] {
  if (typeof layer !== 'object' || layer === null) return []
  const profiles = (layer as { profiles?: unknown }).profiles
  return typeof profiles === 'object' && profiles !== null ? Object.keys(profiles) : []
}

/** Controller joining settings descriptors with advisory model suggestions. */
export class SubagentsController {
  /** Snapshot consumed through the injected selector hook. */
  readonly store: SnapshotStore<SubagentsState> = createSnapshotStore({
    status: 'idle', error: null, writable: false, revision: 0, value: EMPTY,
    baseProfileNames: [], userProfileNames: [], suggestions: [],
  })
  private generation = 0
  private view: SettingsNamespaceView | undefined

  /** @param api - Settings and LLM wire domains. */
  constructor(private readonly api: Pick<IApiClient, 'settings' | 'llm'>) {}

  /**
   * Load the namespace and live model catalog; latest request wins.
   * @returns fulfillment after the current load publishes or becomes stale.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => { state.status = 'loading'; state.error = null })
    try {
      const [settings, models] = await Promise.all([this.api.settings.describe({}), this.api.llm.models({})])
      if (!settings.result.ok) throw new Error(settings.result.error.message)
      if (generation !== this.generation) return
      const view = settings.result.value.namespaces.find(entry => entry.ns === SUBAGENT_SETTINGS_NS)
      if (view === undefined) {
        this.view = undefined
        this.store.update((state) => { state.status = 'unavailable'; state.writable = false; state.suggestions = [] })
        return
      }
      this.view = view
      const suggestions = models.result.ok
        ? models.result.value.groups.flatMap(group =>
          group.models.map(model => ({
            provider: group.id,
            providerName: group.name,
            model: model.id,
            modelName: model.name,
            ...model.description === undefined ? {} : { modelDescription: model.description },
            reasoningEfforts: model.reasoning?.efforts.map(effort => ({
              id: effort.id,
              name: effort.name,
              ...effort.description === undefined ? {} : { description: effort.description },
            })) ?? [],
            ...model.reasoning?.defaultEffort === undefined
              ? {}
              : { defaultReasoningEffort: model.reasoning.defaultEffort },
          })))
        : []
      this.store.set({
        status: 'ready',
        error: models.result.ok ? null : models.result.error.message,
        writable: settings.result.value.writable,
        revision: view.revision,
        value: readValue(view.value),
        baseProfileNames: profileNames(view.base),
        userProfileNames: profileNames(view.user),
        suggestions,
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((state) => { state.status = 'error'; state.error = error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Persist direct-selection policy with optimistic revision checking.
   * @param value - whether direct provider/model arguments are enabled.
   * @returns whether the Host committed the mutation.
   */
  async setAllowDirectModelSelection(value: boolean): Promise<boolean> {
    return this.mutate([{ op: 'set', path: ['allowDirectModelSelection'], value }])
  }

  /**
   * Add or replace a profile, optionally removing its previous name.
   * @param name - destination profile name.
   * @param profile - complete provider/model profile.
   * @param previousName - old key removed atomically during a rename.
   * @returns whether the Host committed the mutation.
   */
  async saveProfile(name: string, profile: SubagentProfile, previousName?: string): Promise<boolean> {
    const ops: Array<{ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }> = []
    if (previousName !== undefined && previousName !== name) ops.push({ op: 'unset', path: ['profiles', previousName] })
    ops.push({ op: 'set', path: ['profiles', name], value: profile })
    return this.mutate(ops)
  }

  /**
   * Delete one profile by name.
   * @param name - profile key to remove.
   * @returns whether the Host committed the mutation.
   */
  async deleteProfile(name: string): Promise<boolean> {
    return this.mutate([{ op: 'unset', path: ['profiles', name] }])
  }

  /** Prevent in-flight responses from publishing after disposal. */
  dispose(): void { this.generation += 1; this.view = undefined }

  private async mutate(ops: Array<{ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }>): Promise<boolean> {
    const view = this.view
    const before = this.store.getSnapshot()
    if (view === undefined || !before.writable || before.status === 'saving') return false
    const generation = ++this.generation
    this.store.update((state) => { state.status = 'saving'; state.error = null })
    try {
      const response = await this.api.settings.mutate({ ns: SUBAGENT_SETTINGS_NS, ops, expectedRevision: view.revision })
      if (generation !== this.generation) return response.result.ok
      if (!response.result.ok) throw new Error(response.result.error.message)
      const accepted = response.result.value
      this.view = accepted
      this.store.update((state) => {
        state.status = 'ready'; state.error = null; state.revision = accepted.revision
        state.value = readValue(accepted.value)
        state.baseProfileNames = profileNames(accepted.base)
        state.userProfileNames = profileNames(accepted.user)
      })
      return true
    } catch (error) {
      if (generation !== this.generation) return false
      this.store.update((state) => { state.status = 'ready'; state.error = error instanceof Error ? error.message : String(error) })
      return false
    }
  }
}

/**
 * Refetch only after the page has opened once.
 * @param controller - Subagents page controller to refresh.
 */
export function refreshIfLoaded(controller: SubagentsController): void {
  if (controller.store.getSnapshot().status !== 'idle') void controller.load()
}
