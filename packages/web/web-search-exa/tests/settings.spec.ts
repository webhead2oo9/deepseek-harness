/** Live Exa settings affect the next provider operation without re-registration. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as exaPlugin from '@deepseek-ai/dsh-web-search-exa'
import { WEB_SEARCH_EXA_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-web-search-exa'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean { return true }

  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('web-search-exa settings section', () => {
  it('uses a committed endpoint and retrieval mode on the next search', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: 'exa' })
    const settingsFiber = ctx.plugin(MemorySettings)
    await settingsFiber.await()
    const pluginFiber = ctx.plugin(exaPlugin, { apiKey: 'exa-key', baseURL: 'https://entry.test' })
    await pluginFiber.await()

    await ctx.web.search({ query: 'first' })
    await ctx.settings.update(WEB_SEARCH_EXA_SETTINGS_NAMESPACE, { baseURL: 'https://stored.test', searchType: 'fast' })
    await ctx.web.search({ query: 'second' })

    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(url).toBe('https://stored.test/search')
    expect(JSON.parse(init.body as string)).toMatchObject({ type: 'fast' })

    await pluginFiber.dispose()
    await settingsFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('releases its settings namespace on teardown', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: 'exa' })
    const settingsFiber = ctx.plugin(MemorySettings)
    await settingsFiber.await()
    const pluginFiber = ctx.plugin(exaPlugin, { apiKey: 'exa-key' })
    await pluginFiber.await()

    expect(ctx.settings.describe().map(row => String(row.ns))).toContain('web-search-exa')
    await pluginFiber.dispose()
    expect(ctx.settings.describe().map(row => String(row.ns))).not.toContain('web-search-exa')

    await settingsFiber.dispose()
    await ctx.fiber.dispose()
  })
})
