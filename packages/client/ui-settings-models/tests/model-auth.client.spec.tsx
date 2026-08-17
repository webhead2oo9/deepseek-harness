// @vitest-environment jsdom
/** Provider-neutral model authentication store and card behavior. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { ModelAuthProviderStatus } from '@deepseek-ai/dsh-model-auth/types'
import { ModelAuthCards, ModelAuthStore } from '../src/client/ModelAuthCards.tsx'
import type { ModelAuthRemote, ModelAuthState } from '../src/client/ModelAuthCards.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const signedOut: ModelAuthProviderStatus = {
  provider: 'openai-codex' as never,
  displayName: 'OpenAI Codex',
  methods: ['browser', 'device'],
  state: 'signed-out',
}

const deviceChallenge = {
  kind: 'device' as const,
  provider: signedOut.provider,
  attemptId: 'attempt-device' as never,
  verificationUrl: 'https://auth.example/device',
  userCode: 'ABCD-EFGH',
  expiresAt: '2030-01-01T00:00:00.000Z',
}

function success<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

function failure(message: string): { ok: false; error: { code: string; message: string; details: Record<string, never> } } {
  return { ok: false, error: { code: 'auth-failed', message, details: {} } }
}

function scriptedRemote(overrides: Partial<ModelAuthRemote> = {}): ModelAuthRemote {
  return {
    list: vi.fn(() => Promise.resolve(success([signedOut]))),
    beginLogin: vi.fn(() => Promise.resolve(success(deviceChallenge))),
    cancelLogin: vi.fn(() => Promise.resolve(success(undefined))),
    logout: vi.fn(() => Promise.resolve(success(undefined))),
    ...overrides,
  }
}

function mount(remote: ModelAuthRemote, state: ModelAuthState, isLoopback = true) {
  const controller = new ModelAuthStore(remote)
  controller.store.set(state)
  const view = render(<ModelAuthCards
    controller={controller}
    useSnapshot={bindSnapshotSelector(controller.store)}
    remote={remote}
    isLoopback={isLoopback}
    t={key => en[key]}
  />)
  return { controller, view }
}

describe('ModelAuthStore', () => {
  it('loads safe status and ignores a superseded response', async () => {
    let releaseFirst!: (value: { ok: true; value: readonly ModelAuthProviderStatus[] }) => void
    const first = new Promise<{ ok: true; value: readonly ModelAuthProviderStatus[] }>((resolve) => { releaseFirst = resolve })
    const signedIn = { ...signedOut, state: 'signed-in' as const }
    const list = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(success([signedIn]))
    const controller = new ModelAuthStore(scriptedRemote({ list }))

    const oldLoad = controller.load()
    await controller.load()
    releaseFirst(success([signedOut]))
    await oldLoad

    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', providers: [signedIn] })
  })

  it('publishes Remote and non-Error failures', async () => {
    const controller = new ModelAuthStore(scriptedRemote({
      list: vi.fn().mockRejectedValueOnce('offline').mockResolvedValueOnce(failure('expired')),
    }))

    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'offline' })
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'auth-failed: expired' })
  })

  it('ignores a rejected response after a newer load starts', async () => {
    let rejectFirst!: (reason: unknown) => void
    const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject })
    const list = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(success([signedOut]))
    const controller = new ModelAuthStore(scriptedRemote({ list }))

    const oldLoad = controller.load()
    await controller.load()
    rejectFirst(new Error('obsolete'))
    await oldLoad

    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', providers: [signedOut] })
  })
})

describe('ModelAuthCards', () => {
  it('loads on mount and disappears when no driver is registered', async () => {
    const remote = scriptedRemote({ list: vi.fn(() => Promise.resolve(success([]))) })
    mount(remote, { status: 'idle', providers: [] })
    await waitFor(() => { expect(remote.list).toHaveBeenCalledTimes(1) })
    await waitFor(() => { expect(document.body.textContent).toBe('') })
  })

  it('starts and cancels device login while hiding loopback login remotely', async () => {
    const signingIn = { ...signedOut, state: 'signing-in' as const, challenge: deviceChallenge }
    const remote = scriptedRemote({
      list: vi.fn()
        .mockResolvedValueOnce(success([signingIn]))
        .mockResolvedValueOnce(success([signedOut])),
    })
    mount(remote, { status: 'ready', providers: [signedOut] }, false)

    expect(screen.queryByRole('button', { name: en.signInBrowser })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.signInDevice }))
    await screen.findByText(/ABCD-EFGH/)
    expect(remote.beginLogin).toHaveBeenCalledWith(signedOut.provider, 'device')
    expect(screen.getByRole('link', { name: en.continueSignIn }).getAttribute('href')).toBe('https://auth.example/device')

    fireEvent.click(screen.getByRole('button', { name: en.cancelSignIn }))
    await waitFor(() => { expect(remote.cancelLogin).toHaveBeenCalledWith('attempt-device') })
    await waitFor(() => { expect(screen.queryByText(/ABCD-EFGH/)).toBeNull() })
  })

  it('restores a live challenge from Host status after remount', async () => {
    const signingIn = { ...signedOut, state: 'signing-in' as const, challenge: deviceChallenge }
    const remote = scriptedRemote({ list: vi.fn(() => Promise.resolve(success([signingIn]))) })
    const first = mount(remote, { status: 'idle', providers: [] }, false)
    await screen.findByText(/ABCD-EFGH/)
    first.view.unmount()

    mount(remote, first.controller.store.getSnapshot(), false)
    expect(screen.getByText(/ABCD-EFGH/)).toBeTruthy()
  })

  it('hides a stale challenge when Host status is terminal', () => {
    const failed = { ...signedOut, state: 'error' as const, error: 'timed out', challenge: deviceChallenge }
    mount(scriptedRemote(), { status: 'ready', providers: [failed] }, false)

    expect(screen.queryByText(/ABCD-EFGH/)).toBeNull()
    expect(screen.queryByRole('button', { name: en.cancelSignIn })).toBeNull()
  })

  it('opens browser login and renders a failed action', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const browserChallenge = {
      kind: 'browser' as const,
      provider: signedOut.provider,
      attemptId: 'attempt-browser' as never,
      authorizationUrl: 'https://auth.example/authorize',
    }
    const signingIn = { ...signedOut, state: 'signing-in' as const, challenge: browserChallenge }
    const remote = scriptedRemote({
      list: vi.fn(() => Promise.resolve(success([signingIn]))),
      beginLogin: vi.fn()
        .mockResolvedValueOnce(success(browserChallenge))
        .mockResolvedValueOnce(failure('try again')),
    })
    const { controller } = mount(remote, { status: 'ready', providers: [signedOut] })

    fireEvent.click(screen.getByRole('button', { name: en.signInBrowser }))
    await waitFor(() => { expect(open).toHaveBeenCalledWith('https://auth.example/authorize', '_blank', 'noopener,noreferrer') })
    expect(await screen.findByRole('link', { name: en.continueSignIn })).toBeTruthy()

    controller.store.set({ status: 'ready', providers: [signedOut] })
    const deviceButton = screen.getByRole('button', { name: en.signInDevice })
    await waitFor(() => { expect(deviceButton).toHaveProperty('disabled', false) })
    fireEvent.click(deviceButton)
    expect((await screen.findByRole('alert')).textContent).toContain('auth-failed: try again')
  })

  it('confirms logout and renders account and provider failures', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    const provider: ModelAuthProviderStatus = {
      ...signedOut,
      state: 'signed-in',
      account: { email: 'dev@example.com', plan: 'Plus' },
      error: 'Refresh is due',
    }
    const remote = scriptedRemote()
    mount(remote, { status: 'ready', providers: [provider] })

    expect(screen.getByText('dev@example.com · Plus')).toBeTruthy()
    expect(screen.getByText('Refresh is due')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.signOut }))
    expect(remote.logout).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.signOut }))
    await waitFor(() => { expect(remote.logout).toHaveBeenCalledWith(provider.provider) })
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('renders load, cancel, and logout failures without exposing records', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const signingIn = { ...signedOut, state: 'signing-in' as const }
    const remote = scriptedRemote({
      list: vi.fn(() => Promise.resolve(success([{
        ...signedOut, state: 'signing-in' as const, challenge: deviceChallenge,
      }]))),
      cancelLogin: vi.fn(() => Promise.resolve(failure('cancel refused'))),
      logout: vi.fn(() => Promise.resolve(failure('logout refused'))),
    })
    const first = mount(remote, { status: 'error', providers: [signingIn], error: 'status failed' })
    expect(screen.getByText('status failed')).toBeTruthy()
    expect(screen.getByRole('button', { name: en.signInDevice })).toHaveProperty('disabled', true)
    first.view.unmount()

    const cancelView = mount(remote, { status: 'ready', providers: [signedOut] }).view
    fireEvent.click(screen.getByRole('button', { name: en.signInDevice }))
    await screen.findByText(/ABCD-EFGH/)
    fireEvent.click(screen.getByRole('button', { name: en.cancelSignIn }))
    expect((await screen.findByRole('alert')).textContent).toContain('auth-failed: cancel refused')
    cancelView.unmount()

    mount(remote, { status: 'ready', providers: [{ ...signedOut, state: 'signed-in' }] })
    fireEvent.click(screen.getByRole('button', { name: en.signOut }))
    expect((await screen.findByRole('alert')).textContent).toContain('auth-failed: logout refused')
    expect(confirm).toHaveBeenCalled()
  })
})
