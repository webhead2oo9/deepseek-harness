import { describe, expect, it } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { SUBAGENT_SETTINGS_NS, SubagentsController, readValue, refreshIfLoaded } from '../src/client/store.ts'
import type { SubagentSettingsValue } from '../src/client/store.ts'

const initial = { allowDirectModelSelection: false, profiles: { fast: { description: 'Quick work', provider: 'deepseek', model: 'chat' } } }

function api(options: { writable?: boolean; namespace?: boolean; fail?: string; base?: unknown } = {}) {
  const value: SubagentSettingsValue = structuredClone(initial)
  let revision = 4
  const writes: unknown[] = []
  const client = {
    settings: {
      describe: () => Promise.resolve(options.fail === 'describe'
        ? { rpcId: 'r', result: { ok: false as const, error: { code: 'internal', message: 'describe failed', details: {} } } }
        : { rpcId: 'r', result: { ok: true as const, value: { writable: options.writable !== false, hasDocument: true, namespaces: options.namespace === false ? [] : [{ ns: SUBAGENT_SETTINGS_NS, value, user: value, base: options.base === undefined ? {} : options.base, schema: {}, secrets: [], revision }] } } }),
      mutate: (request: { expectedRevision: number; ops: Array<{ op: string; path: string[]; value?: unknown }> }) => {
        writes.push(request)
        if (options.fail === 'mutate') return Promise.resolve({ rpcId: 'r', result: { ok: false as const, error: { code: 'conflict', message: 'mutate failed', details: {} } } })
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- non-Error rejection normalization is the scenario.
        if (options.fail === 'mutate-string') return Promise.reject('string failure')
        for (const op of request.ops) {
          if (op.path[0] === 'allowDirectModelSelection') value.allowDirectModelSelection = op.value as boolean
          if (op.path[0] === 'profiles' && op.path[1] !== undefined) {
            if (op.op === 'unset') Reflect.deleteProperty(value.profiles, op.path[1])
            else (value.profiles as Record<string, unknown>)[op.path[1]] = op.value
          }
        }
        revision += 1
        return Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: { ns: SUBAGENT_SETTINGS_NS, value, user: value, base: options.base === undefined ? {} : options.base, schema: {}, secrets: [], revision } } })
      },
    },
    llm: {
      models: () => Promise.resolve(options.fail === 'models'
        ? {
          rpcId: 'r',
          result: { ok: false as const, error: { code: 'internal', message: 'models failed', details: {} } },
        }
        : {
          rpcId: 'r',
          result: {
            ok: true as const,
            value: {
              groups: [{
                id: 'deepseek',
                name: 'DeepSeek',
                models: [{
                  id: 'chat',
                  name: 'Chat',
                  description: 'General model',
                  reasoning: {
                    efforts: [
                      { id: 'high', name: 'High', description: 'More reasoning' },
                      { id: 'low', name: 'Low' },
                    ],
                    defaultEffort: 'high',
                  },
                }],
              }],
              failures: [],
            },
          },
        }),
    },
  } as unknown as IApiClient
  return { client, writes, value: () => value }
}

describe('SubagentsController', () => {
  it('loads the literal namespace and advisory model suggestions', async () => {
    const fixture = api(); const controller = new SubagentsController(fixture.client)
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', writable: true, revision: 4, value: initial,
      userProfileNames: ['fast'],
      suggestions: [{
        provider: 'deepseek', providerName: 'DeepSeek', model: 'chat', modelName: 'Chat',
        modelDescription: 'General model',
        reasoningEfforts: [
          { id: 'high', name: 'High', description: 'More reasoning' },
          { id: 'low', name: 'Low' },
        ],
        defaultReasoningEffort: 'high',
      }],
    })
  })
  it('keeps sparse catalog models as route suggestions without invented metadata', async () => {
    const fixture = api()
    const client = {
      ...fixture.client,
      llm: {
        models: () => Promise.resolve({
          rpcId: 'r',
          result: {
            ok: true as const,
            value: {
              groups: [{ id: 'private', name: 'Private', models: [{ id: 'future', name: 'Future' }] }],
              failures: [],
            },
          },
        }),
      },
    } as unknown as IApiClient
    const controller = new SubagentsController(client)
    await controller.load()
    expect(controller.store.getSnapshot().suggestions).toEqual([{
      provider: 'private', providerName: 'Private', model: 'future', modelName: 'Future',
      reasoningEfforts: [],
    }])
  })
  it('identifies composition-owned profiles without requiring a complete base layer', async () => {
    const base = new SubagentsController(api({ base: { profiles: { fast: initial.profiles.fast } } }).client)
    await base.load(); expect(base.store.getSnapshot().baseProfileNames).toEqual(['fast'])
    for (const layer of [null, 'bad', { profiles: null }, { profiles: 'bad' }]) {
      const controller = new SubagentsController(api({ base: layer }).client)
      await controller.load(); expect(controller.store.getSnapshot().baseProfileNames).toEqual([])
    }
  })
  it('keeps manual editing available when advisory model discovery fails', async () => {
    const controller = new SubagentsController(api({ fail: 'models' }).client)
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', error: 'models failed', suggestions: [], writable: true })
  })
  it('writes revision-aware path mutations for toggles, rename, and delete', async () => {
    const fixture = api(); const controller = new SubagentsController(fixture.client); await controller.load()
    await controller.setAllowDirectModelSelection(true)
    await controller.saveProfile('careful', { description: 'Review', provider: 'manual', model: 'custom' }, 'fast')
    await controller.saveProfile('careful', { description: 'Updated review', provider: 'manual', model: 'custom' }, 'careful')
    await controller.deleteProfile('careful')
    expect(fixture.writes).toEqual([
      { expectedRevision: 4, ops: [{ op: 'set', path: ['allowDirectModelSelection'], value: true }], ns: SUBAGENT_SETTINGS_NS },
      { expectedRevision: 5, ops: [{ op: 'unset', path: ['profiles', 'fast'] }, { op: 'set', path: ['profiles', 'careful'], value: { description: 'Review', provider: 'manual', model: 'custom' } }], ns: SUBAGENT_SETTINGS_NS },
      { expectedRevision: 6, ops: [{ op: 'set', path: ['profiles', 'careful'], value: { description: 'Updated review', provider: 'manual', model: 'custom' } }], ns: SUBAGENT_SETTINGS_NS },
      { expectedRevision: 7, ops: [{ op: 'unset', path: ['profiles', 'careful'] }], ns: SUBAGENT_SETTINGS_NS },
    ])
  })
  it('keeps read-only values visible and refuses writes', async () => {
    const fixture = api({ writable: false }); const controller = new SubagentsController(fixture.client); await controller.load(); await controller.deleteProfile('fast')
    expect(controller.store.getSnapshot().value).toEqual(initial); expect(fixture.writes).toEqual([])
  })
  it('reports unavailable and failed descriptors', async () => {
    const missing = new SubagentsController(api({ namespace: false }).client); await missing.load(); expect(missing.store.getSnapshot().status).toBe('unavailable')
    const failed = new SubagentsController(api({ fail: 'describe' }).client); await failed.load(); expect(failed.store.getSnapshot()).toMatchObject({ status: 'error', error: 'describe failed' })
  })
  it('validates profile fields without restricting their string contents', () => {
    expect(readValue({
      allowDirectModelSelection: true,
      profiles: {
        x: {
          description: 'd',
          provider: 'private/provider',
          model: 'future:model',
          instruction: 'Line one.\nLine two.',
          reasoningEffort: 'max',
        },
      },
    }).profiles.x).toEqual({
      description: 'd',
      provider: 'private/provider',
      model: 'future:model',
      instruction: 'Line one.\nLine two.',
      reasoningEffort: 'max',
    })
    expect(readValue({
      allowDirectModelSelection: false,
      profiles: { reset: { description: 'reset', provider: 'p', model: 'm', instruction: null, reasoningEffort: null } },
    }).profiles.reset).toEqual({
      description: 'reset', provider: 'p', model: 'm', instruction: null, reasoningEffort: null,
    })
    const prototypeName = readValue(JSON.parse('{"allowDirectModelSelection":false,"profiles":{"__proto__":{"description":"d","provider":"p","model":"m"}}}'))
    expect(Object.hasOwn(prototypeName.profiles, '__proto__')).toBe(true)
    for (const invalid of [null, 'bad']) expect(() => readValue(invalid)).toThrow('not an object')
    for (const invalid of [
      { profiles: {} },
      { allowDirectModelSelection: 'yes', profiles: {} },
      { allowDirectModelSelection: false, profiles: 'bad' },
      { allowDirectModelSelection: false, profiles: null },
    ]) expect(() => readValue(invalid)).toThrow('incomplete')
    for (const candidate of [null, 'bad', {}, { description: 1, provider: 'p', model: 'm' }, { description: 'd', provider: 1, model: 'm' }, { description: 'd', provider: 'p', model: 1 }, { description: 'd', provider: 'p', model: 'm', instruction: 1 }, { description: 'd', provider: 'p', model: 'm', reasoningEffort: 1 }]) {
      expect(() => readValue({ allowDirectModelSelection: false, profiles: { bad: candidate } })).toThrow('profile bad is invalid')
    }
  })
  it('keeps mutation failures visible and returns false for unavailable or busy writes', async () => {
    const unloaded = new SubagentsController(api().client)
    expect(await unloaded.deleteProfile('x')).toBe(false)
    const conflict = new SubagentsController(api({ fail: 'mutate' }).client); await conflict.load()
    expect(await conflict.setAllowDirectModelSelection(true)).toBe(false)
    expect(conflict.store.getSnapshot()).toMatchObject({ status: 'ready', error: 'mutate failed' })
    const thrown = new SubagentsController(api({ fail: 'mutate-string' }).client); await thrown.load()
    expect(await thrown.deleteProfile('fast')).toBe(false)
    expect(thrown.store.getSnapshot().error).toBe('string failure')
  })
  it('drops stale load and mutation settlements after disposal', async () => {
    const describe = Promise.withResolvers<Awaited<ReturnType<IApiClient['settings']['describe']>>>()
    const mutate = Promise.withResolvers<Awaited<ReturnType<IApiClient['settings']['mutate']>>>()
    const fixture = api()
    const client = {
      ...fixture.client,
      settings: { ...fixture.client.settings, describe: () => describe.promise, mutate: () => mutate.promise },
    } as IApiClient
    const loading = new SubagentsController(client); const load = loading.load(); loading.dispose()
    describe.resolve(await fixture.client.settings.describe({})); await load
    expect(loading.store.getSnapshot().status).toBe('loading')

    const writing = new SubagentsController(fixture.client); await writing.load()
    const deferredClient = { ...fixture.client, settings: { ...fixture.client.settings, mutate: () => mutate.promise } } as IApiClient
    const deferred = new SubagentsController(deferredClient); await deferred.load()
    const write = deferred.deleteProfile('fast'); const busy = deferred.deleteProfile('fast'); expect(await busy).toBe(false); deferred.dispose()
    mutate.resolve(await fixture.client.settings.mutate({
      ns: SUBAGENT_SETTINGS_NS,
      ops: [],
      expectedRevision: 4,
    }))
    expect(await write).toBe(true)
    writing.dispose()
  })
  it('contains string failures and stale rejected operations after disposal', async () => {
    const fixture = api()
    const stringClient = {
      ...fixture.client,
      settings: {
        ...fixture.client.settings,
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- non-Error rejection normalization is the scenario.
        describe: () => Promise.reject('load string'),
      },
    } as IApiClient
    const failed = new SubagentsController(stringClient); await failed.load()
    expect(failed.store.getSnapshot()).toMatchObject({ status: 'error', error: 'load string' })

    const describe = Promise.withResolvers<Awaited<ReturnType<IApiClient['settings']['describe']>>>()
    const staleLoadClient = { ...fixture.client, settings: { ...fixture.client.settings, describe: () => describe.promise } } as IApiClient
    const staleLoad = new SubagentsController(staleLoadClient); const loading = staleLoad.load(); staleLoad.dispose(); describe.reject(new Error('late load')); await loading
    expect(staleLoad.store.getSnapshot().status).toBe('loading')

    const mutate = Promise.withResolvers<Awaited<ReturnType<IApiClient['settings']['mutate']>>>()
    const staleWriteClient = { ...fixture.client, settings: { ...fixture.client.settings, mutate: () => mutate.promise } } as IApiClient
    const staleWrite = new SubagentsController(staleWriteClient); await staleWrite.load(); const writing = staleWrite.deleteProfile('fast'); staleWrite.dispose(); mutate.reject(new Error('late write'))
    expect(await writing).toBe(false)
  })
  it('refreshes only a controller that has loaded and disposes stale reads', async () => {
    const fixture = api(); const controller = new SubagentsController(fixture.client); refreshIfLoaded(controller); expect(controller.store.getSnapshot().status).toBe('idle')
    await controller.load(); refreshIfLoaded(controller); controller.dispose(); await Promise.resolve(); expect(controller.store.getSnapshot().status).toBe('loading')
  })
})
