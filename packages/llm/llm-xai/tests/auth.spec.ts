import { describe, expect, it, vi } from 'vitest'
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
    await expect(driver.resolve(expired, { forceRefresh: false })).resolves.toEqual({
      authorization: { headers: { authorization: 'Bearer old-refreshed' } },
      record: expect.objectContaining({ access: 'old-refreshed' }),
    })
    expect(implementation.refresh).toHaveBeenCalledOnce()
  })

  it('rejects malformed records and challenges', async () => {
    expect(() => parseXaiAuthRecord({ type: 'oauth', access: '', refresh: 'r', expires: 1 })).toThrow(/invalid/)
    const notify = (event: AuthEvent): Promise<OAuthCredential> => Promise.reject(event)
    const driver = new XaiAuthDriver(oauth((interaction) => {
      interaction.notify({ type: 'device_code', userCode: '', verificationUri: 'https://auth.x.ai', expiresInSeconds: 60 })
      return notify({ type: 'progress', message: 'unreachable' })
    }))
    await expect(driver.startLogin('device', new AbortController().signal)).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    })
  })
})
