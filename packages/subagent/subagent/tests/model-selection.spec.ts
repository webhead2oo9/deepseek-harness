/** Shared subagent model profiles layered over a real in-memory settings provider. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SubagentRuntime, {
  SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE,
  validateSubagentModelSelectionSettings,
} from '@deepseek-ai/dsh-subagent'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

const base = {
  allowDirectModelSelection: false,
  profiles: {
    fast: { description: 'Fast work', provider: 'base-provider', model: 'fast-model' },
  },
}

describe('subagent model selection settings', () => {
  it('layers persisted profiles over composition defaults and publishes detached snapshots', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(SubagentRuntime, base)
    const updated = vi.fn()
    ctx.on('subagent/model-selection-updated', updated)

    await ctx.settings.replace(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, {
      allowDirectModelSelection: true,
      profiles: {
        deep: {
          description: 'Deep work',
          provider: 'runinfraprovider',
          model: 'reasoning-model',
          instruction: 'Verify every claim.',
          reasoningEffort: 'high',
        },
      },
    })
    const selected = ctx.subagents.modelSelection()
    expect(selected).toEqual({
      allowDirectModelSelection: true,
      profiles: {
        fast: { description: 'Fast work', provider: 'base-provider', model: 'fast-model' },
        deep: {
          description: 'Deep work',
          provider: 'runinfraprovider',
          model: 'reasoning-model',
          instruction: 'Verify every claim.',
          reasoningEffort: 'high',
        },
      },
    })
    expect(updated).toHaveBeenCalled()
    ;(selected.profiles as Record<string, { model: string }>).deep!.model = 'mutated'
    expect(ctx.subagents.modelSelection().profiles['deep']?.model).toBe('reasoning-model')
    await ctx.fiber.dispose()
  })

  it('falls back to composition defaults when the settings provider detaches', async () => {
    const ctx = new Context()
    const settings = ctx.plugin(MemorySettings)
    await settings.await()
    await ctx.plugin(SubagentRuntime, base)
    await ctx.settings.replace(SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE, {
      allowDirectModelSelection: true,
    })
    expect(ctx.subagents.modelSelection().allowDirectModelSelection).toBe(true)
    await settings.dispose()
    expect(ctx.subagents.modelSelection()).toEqual(base)
    await ctx.fiber.dispose()
  })

  it('rejects empty profile names and fields with profile-specific diagnostics', () => {
    expect(() =>{  validateSubagentModelSelectionSettings({
      allowDirectModelSelection: false,
      profiles: { '': { description: 'x', provider: 'p', model: 'm' } },
    }) }).toThrow('profile name must not be empty')
    expect(() =>{  validateSubagentModelSelectionSettings({
      allowDirectModelSelection: false,
      profiles: { bad: { description: ' ', provider: 'p', model: 'm' } },
    }) }).toThrow('profile "bad" description must not be empty')
    expect(() =>{  validateSubagentModelSelectionSettings({
      allowDirectModelSelection: false,
      profiles: { bad: { description: 'x', provider: ' ', model: 'm' } },
    }) }).toThrow('profile "bad" provider must not be empty')
    expect(() =>{  validateSubagentModelSelectionSettings({
      allowDirectModelSelection: false,
      profiles: { bad: { description: 'x', provider: 'p', model: ' ' } },
    }) }).toThrow('profile "bad" model must not be empty')
    expect(() =>{  validateSubagentModelSelectionSettings({
      allowDirectModelSelection: false,
      profiles: { bad: { description: 'x', provider: 'p', model: 'm', instruction: ' ' } },
    }) }).toThrow('profile "bad" instruction must not be empty when present')
    expect(() =>{  validateSubagentModelSelectionSettings({
      allowDirectModelSelection: false,
      profiles: { bad: { description: 'x', provider: 'p', model: 'm', reasoningEffort: ' ' } },
    }) }).toThrow('profile "bad" reasoningEffort must not be empty when present')
  })
})
