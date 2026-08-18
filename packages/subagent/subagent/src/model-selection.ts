/** Shared persisted model-route profiles used by subagent delegation consumers. */

import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings namespace edited by the Web Subagents page. */
export const SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE = settingsNamespace('subagent-model-selection')

/** One deployment-described child model route. */
export interface SubagentModelProfile {
  /** Model-facing profile purpose. */
  readonly description: string
  /** Registered LLM provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /** Optional child-only system instruction applied to every delegation using this profile. */
  readonly instruction?: string
  /** Optional adapter-owned reasoning effort applied to every delegation using this profile. */
  readonly reasoningEffort?: string
}

/** One persisted profile layer, where null clears an inherited optional field. */
export interface SubagentModelProfileConfig {
  /** Model-facing profile purpose. */
  readonly description: string
  /** Registered LLM provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /** Child-only instruction, or null to clear the composition value. */
  readonly instruction?: string | null
  /** Adapter-owned effort, or null to clear the composition value. */
  readonly reasoningEffort?: string | null
}

/** Composition and persisted settings layers before reset markers are normalized. */
export interface SubagentModelSelectionConfig {
  /** Whether delegation tools expose direct provider/model arguments. */
  readonly allowDirectModelSelection: boolean
  /** Named provider/model routes exposed by compatible delegation tools. */
  readonly profiles: Readonly<Record<string, SubagentModelProfileConfig>>
}

/** Shared profile and direct-selection policy. */
export interface SubagentModelSelectionSettings {
  /** Whether delegation tools expose direct provider/model arguments. */
  readonly allowDirectModelSelection: boolean
  /** Named provider/model routes exposed by compatible delegation tools. */
  readonly profiles: Readonly<Record<string, SubagentModelProfile>>
}

/**
 * Reject semantic values the structural settings schema cannot express.
 * @param value - resolved composition or settings value to validate.
 */
export function validateSubagentModelSelectionSettings(value: SubagentModelSelectionConfig): void {
  for (const [name, profile] of Object.entries(value.profiles)) {
    if (name.trim().length === 0) throw new Error('subagent model profile name must not be empty')
    if (profile.description.trim().length === 0) {
      throw new Error(`subagent model profile "${name}" description must not be empty`)
    }
    if (profile.provider.trim().length === 0) {
      throw new Error(`subagent model profile "${name}" provider must not be empty`)
    }
    if (profile.model.trim().length === 0) {
      throw new Error(`subagent model profile "${name}" model must not be empty`)
    }
    if (typeof profile.instruction === 'string' && profile.instruction.trim().length === 0) {
      throw new Error(`subagent model profile "${name}" instruction must not be empty when present`)
    }
    if (typeof profile.reasoningEffort === 'string' && profile.reasoningEffort.trim().length === 0) {
      throw new Error(`subagent model profile "${name}" reasoningEffort must not be empty when present`)
    }
  }
}

/**
 * Detach one settings snapshot from the settings provider's live value.
 * @param value - current authoritative settings value.
 * @returns an owned profile map and scalar policy.
 */
export function snapshotSubagentModelSelectionSettings(
  value: SubagentModelSelectionConfig,
): SubagentModelSelectionSettings {
  return {
    allowDirectModelSelection: value.allowDirectModelSelection,
    profiles: Object.fromEntries(Object.entries(value.profiles).map(([name, profile]) => [name, {
      description: profile.description,
      provider: profile.provider,
      model: profile.model,
      ...typeof profile.instruction === 'string' ? { instruction: profile.instruction } : {},
      ...typeof profile.reasoningEffort === 'string' ? { reasoningEffort: profile.reasoningEffort } : {},
    }])),
  }
}
