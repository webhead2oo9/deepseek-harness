import { describe, expect, it, vi } from 'vitest'
import { ModelAuthError } from '@deepseek-ai/dsh-model-auth'
import type { AuthEvent, AuthInteraction, OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'
import { parseXaiAuthRecord, XaiAuthDriver } from '../src/auth.ts'

const credential = (access = 'access'): OAuthCredential => ({
  type: 'oauth', access, refresh: 'refresh', expires: Date.now() + 60_000,
})

function oauth(login: (interaction: AuthInteraction) => Promise<OAuthCredential>): OAuthAuth {
  return {
    name: 'test',
    login,
    refresh: vi.fn((current: OAuthCredential) => Promise.resolve(credential(`${current.access}-refreshed`))),
    toAuth: vi.fn((current: OAuthCredential) => Promise.resolve({ apiKey: current.access })),
  }
}

describe('xAI OAuth driver', () => {
  it('publishes the device challenge before polling completes', async () => {
    const tokens = Promise.withResolvers<OAuthCredential>()
    const driver = new XaiAuthDriver(oauth((interaction) => {
      interaction.notify({
        type: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://auth.x.ai/device', expiresInSeconds: 600,
      })
      return tokens.promise
    }))
    const operation = await driver.startLogin('device', new AbortController().signal)
    expect(operation.challenge).toMatchObject({
      kind: 'device', verificationUrl: 'https://auth.x.ai/device', userCode: 'ABCD-EFGH',
    })
    tokens.resolve(credential())
    await expect(operation.completion).resolves.toMatchObject({ access: 'access' })
  })

  it('aborts polling and waits for cancellation to settle', async () => {
    let stopped = false
    const driver = new XaiAuthDriver(oauth(interaction => new Promise((_resolve, reject) => {
      interaction.notify({
        type: 'device_code', userCode: 'CODE', verificationUri: 'https://auth.x.ai/device', expiresInSeconds: 60,
      })
      interaction.signal?.addEventListener('abort', () => {
        stopped = true
        reject(new Error('Login cancelled'))
      }, { once: true })
    })))
    const operation = await driver.startLogin('device', new AbortController().signal)
    await operation.cancel()
    expect(stopped).toBe(true)
    await expect(operation.completion).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' })
  })

  it('refreshes expired records and returns the rotated credential', async () => {
    const implementation = oauth(() => Promise.resolve(credential()))
    const driver = new XaiAuthDriver(implementation)
    const expired = { ...credential('old'), expires: 1 }
    const resolution = await driver.resolve(expired, { forceRefresh: false })
    expect(resolution.authorization).toEqual({ headers: { authorization: 'Bearer old-refreshed' } })
    expect(resolution.record).toMatchObject({ access: 'old-refreshed' })
  })

  it('rejects malformed records and challenges', async () => {
    expect(() => parseXaiAuthRecord({ type: 'oauth', access: '', refresh: 'r', expires: 1 })).toThrow(/invalid/)
    const notify = (event: AuthEvent): Promise<OAuthCredential> => Promise.reject(new Error(event.type))
    const driver = new XaiAuthDriver(oauth((interaction) => {
      interaction.notify({ type: 'device_code', userCode: '', verificationUri: 'https://auth.x.ai', expiresInSeconds: 60 })
      return notify({ type: 'progress', message: 'unreachable' })
    }))
    await expect(driver.startLogin('device', new AbortController().signal)).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    })
  })

  it.each([
    null,
    [],
    {},
    { type: 'api_key', access: 'a', refresh: 'r', expires: 1 },
    { type: 'oauth', access: 1, refresh: 'r', expires: 1 },
    { type: 'oauth', access: '', refresh: 'r', expires: 1 },
    { type: 'oauth', access: 'a', refresh: 1, expires: 1 },
    { type: 'oauth', access: 'a', refresh: '', expires: 1 },
    { type: 'oauth', access: 'a', refresh: 'r', expires: 'later' },
    { type: 'oauth', access: 'a', refresh: 'r', expires: Number.POSITIVE_INFINITY },
    { type: 'oauth', access: 'a', refresh: 'r', expires: 0 },
  ])('rejects invalid durable credential %#', (record) => {
    expect(() => parseXaiAuthRecord(record)).toThrow(/invalid/)
  })

  it('preserves provider credential fields and exposes no account metadata', () => {
    const driver = new XaiAuthDriver(oauth(() => Promise.resolve(credential())))
    expect(parseXaiAuthRecord({ ...credential(), scope: 'openid' })).toMatchObject({ scope: 'openid' })
    expect(driver.inspect(credential())).toEqual({})
  })

  it('rejects unsupported methods and interactive prompts', async () => {
    const driver = new XaiAuthDriver(oauth(interaction => interaction.prompt({
      type: 'text', message: 'not supported',
    }).then(() => credential())))
    await expect(driver.startLogin('browser', new AbortController().signal)).rejects.toMatchObject({
      code: 'UNSUPPORTED_METHOD',
    })
    await expect(driver.startLogin('device', new AbortController().signal)).rejects.toMatchObject({
      code: 'INTERACTION_REQUIRED',
    })
  })

  it.each([
    { type: 'device_code', userCode: 'CODE', verificationUri: '', expiresInSeconds: 60 },
    { type: 'device_code', userCode: 'CODE', verificationUri: 'https://auth.x.ai' },
    { type: 'device_code', userCode: 'CODE', verificationUri: 'https://auth.x.ai', expiresInSeconds: Number.NaN },
    { type: 'device_code', userCode: 'CODE', verificationUri: 'https://auth.x.ai', expiresInSeconds: 0 },
  ] satisfies AuthEvent[])('rejects malformed device challenge %#', async (event) => {
    const driver = new XaiAuthDriver(oauth((interaction) => {
      interaction.notify({ type: 'progress', message: 'starting' })
      interaction.notify(event)
      return Promise.reject(new Error('stopped'))
    }))
    await expect(driver.startLogin('device', new AbortController().signal)).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    })
  })

  it('ignores challenge notifications after the first device code', async () => {
    const tokens = Promise.withResolvers<OAuthCredential>()
    const driver = new XaiAuthDriver(oauth((interaction) => {
      interaction.notify({ type: 'device_code', userCode: 'FIRST', verificationUri: 'https://auth.x.ai', expiresInSeconds: 60 })
      interaction.notify({ type: 'device_code', userCode: 'SECOND', verificationUri: 'https://auth.x.ai', expiresInSeconds: 60 })
      return tokens.promise
    }))
    const operation = await driver.startLogin('device', new AbortController().signal)
    expect(operation.challenge).toMatchObject({ userCode: 'FIRST' })
    tokens.resolve(credential())
    await operation.completion
  })

  it.each([
    [new Error('Login cancelled'), 'LOGIN_CANCELLED'],
    [new Error('provider denied login'), 'OAUTH_FAILED'],
    ['provider failed', 'OAUTH_FAILED'],
  ] as const)('classifies login failure %#', async (failure, code) => {
    const driver = new XaiAuthDriver(oauth(async () => { throw failure }))
    await expect(driver.startLogin('device', new AbortController().signal)).rejects.toMatchObject({ code })
  })

  it('passes through model-auth failures from login and refresh', async () => {
    const loginFailure = new ModelAuthError('denied', 'DENIED')
    const loginDriver = new XaiAuthDriver(oauth(() => Promise.reject(loginFailure)))
    await expect(loginDriver.startLogin('device', new AbortController().signal)).rejects.toBe(loginFailure)

    const implementation = oauth(() => Promise.resolve(credential()))
    const refreshFailure = new ModelAuthError('refresh denied', 'DENIED')
    implementation.refresh = vi.fn(() => Promise.reject(refreshFailure))
    const refreshDriver = new XaiAuthDriver(implementation)
    await expect(refreshDriver.resolve(credential(), { forceRefresh: true })).rejects.toBe(refreshFailure)
  })

  it('returns an unchanged record without refresh and supports forced refresh', async () => {
    const implementation = oauth(() => Promise.resolve(credential()))
    const driver = new XaiAuthDriver(implementation)
    await expect(driver.resolve(credential('current'), { forceRefresh: false })).resolves.toEqual({
      authorization: { headers: { authorization: 'Bearer current' } },
    })
    await expect(driver.resolve(credential('forced'), { forceRefresh: true })).resolves.toMatchObject({
      authorization: { headers: { authorization: 'Bearer forced-refreshed' } },
      record: { access: 'forced-refreshed' },
    })
  })

  it.each([undefined, ''] as const)('rejects an absent authorization token %#', async (apiKey) => {
    const implementation = oauth(() => Promise.resolve(credential()))
    implementation.toAuth = vi.fn(() => Promise.resolve(apiKey === undefined ? {} : { apiKey }))
    const driver = new XaiAuthDriver(implementation)
    await expect(driver.resolve(credential(), { forceRefresh: false })).rejects.toMatchObject({
      code: 'INVALID_RECORD',
    })
  })

  it('classifies authorization conversion failures', async () => {
    const implementation = oauth(() => Promise.resolve(credential()))
    implementation.toAuth = vi.fn(() => Promise.reject(new Error('conversion failed')))
    const driver = new XaiAuthDriver(implementation)
    await expect(driver.resolve(credential(), { forceRefresh: false })).rejects.toMatchObject({
      code: 'OAUTH_FAILED',
    })
  })
})
