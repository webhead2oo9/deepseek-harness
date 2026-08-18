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
export function validateSubagentModelSelectionSettings(value: SubagentModelSelectionSettings): void {
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
    if (profile.instruction !== undefined && profile.instruction.trim().length === 0) {
      throw new Error(`subagent model profile "${name}" instruction must not be empty when present`)
    }
    if (profile.reasoningEffort !== undefined && profile.reasoningEffort.trim().length === 0) {
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
  value: SubagentModelSelectionSettings,
): SubagentModelSelectionSettings {
  return {
    allowDirectModelSelection: value.allowDirectModelSelection,
    profiles: Object.fromEntries(Object.entries(value.profiles).map(([name, profile]) => [name, {
      description: profile.description,
      provider: profile.provider,
      model: profile.model,
      ...profile.instruction === undefined ? {} : { instruction: profile.instruction },
      ...profile.reasoningEffort === undefined ? {} : { reasoningEffort: profile.reasoningEffort },
    }])),
  }
}
