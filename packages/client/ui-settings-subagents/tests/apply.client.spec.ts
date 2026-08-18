import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import { SubagentsSection } from '../src/client/SubagentsSection.tsx'
import type { SubagentsInjected } from '../src/client/SubagentsSection.tsx'

usePinnedBrowserLanguages('zh-CN')

async function bench() {
  const ctx = new Context(); await ctx.plugin(SlotRegistry).await(); ctx.provide('locale', new LocaleRuntime(ctx)); const remote = new TestRemote(ctx)
  const calls: string[] = []
  ctx.provide('connection', { api: {
    settings: { describe: () => { calls.push('describe'); return Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: { writable: true, hasDocument: true, namespaces: [{ ns: 'subagent-model-selection', value: { allowDirectModelSelection: false, profiles: {} }, user: {}, base: {}, schema: {}, secrets: [], revision: 1 }] } } }) }, mutate: () => Promise.reject(new Error('unused')) },
    llm: { models: () => { calls.push('models'); return Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: { groups: [], failures: [] } } }) } },
  } } as never)
  return { ctx, remote, calls, slots: ctx.get('slots') as SlotRegistry }
}

describe('browser apply', () => {
  it('declares only the services it uses', () => { expect(inject).toEqual(['slots', 'locale', 'connection', 'remote']) })
  it('waits for settings.section and registers localized id subagents', async () => {
    const { ctx, slots } = await bench(); await ctx.plugin({ inject: [...inject], apply }).await()
    slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
    const entry = slots.entries('settings.section')[0]!
    expect(entry.component).toBe(SubagentsSection); expect(entry.options).toMatchObject({ id: 'subagents', order: 30 }); expect(resolveSlotLabel(entry.options.label)).toBe('子代理')
  })
  it('refreshes an opened page on each required invalidation and disposes registrations', async () => {
    const { ctx, slots, remote, calls } = await bench(); slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
    const fiber = ctx.plugin({ inject: [...inject], apply }); await fiber.await()
    const face = slots.entries('settings.section')[0]!.inject as unknown as () => SubagentsInjected
    const injected = face()
    await injected.load(); expect(calls).toEqual(['describe', 'models'])
    expect(await injected.setAllowDirectModelSelection(true)).toBe(false)
    expect(await injected.saveProfile('x', { description: 'x', provider: 'p', model: 'm' })).toBe(false)
    expect(await injected.deleteProfile('x')).toBe(false)
    remote.$dispatch('settings/document-updated', ['other']); await Promise.resolve(); expect(calls).toHaveLength(2)
    remote.$dispatch('settings/document-updated', ['subagent-model-selection']); remote.$dispatch('llm/adapters-updated', []); ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(calls.length).toBeGreaterThanOrEqual(8) })
    await fiber.dispose(); expect(slots.entries('settings.section')).toHaveLength(0)
  })
})
