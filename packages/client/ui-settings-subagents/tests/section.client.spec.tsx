// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubagentsSection } from '../src/client/SubagentsSection.tsx'
import type { SubagentsSectionProps } from '../src/client/SubagentsSection.tsx'
import { en } from '../src/client/locales.ts'
import type { SubagentsState } from '../src/client/store.ts'

afterEach(cleanup)

const ready: SubagentsState = { status: 'ready', error: null, writable: true, revision: 2,
  value: { allowDirectModelSelection: false, profiles: { fast: { description: 'Quick work', provider: 'deepseek', model: 'chat' } } },
  baseProfileNames: [], userProfileNames: [], suggestions: [{
    provider: 'deepseek', providerName: 'DeepSeek', model: 'chat', modelName: 'Chat',
    reasoningEfforts: [{ id: 'high', name: 'High' }], defaultReasoningEffort: 'high',
  }] }

function props(state: SubagentsState, overrides: Record<string, unknown> = {}): SubagentsSectionProps {
  return { useSubagents: (selector: (value: SubagentsState) => unknown) => selector(state), t: (key: keyof typeof en) => en[key],
    load: vi.fn().mockResolvedValue(true), setAllowDirectModelSelection: vi.fn().mockResolvedValue(true),
    saveProfile: vi.fn().mockResolvedValue(true), deleteProfile: vi.fn().mockResolvedValue(true), close: vi.fn(),
    useSessions: vi.fn(), useWorkspaces: vi.fn(), ...overrides } as unknown as SubagentsSectionProps
}

describe('SubagentsSection', () => {
  it('renders profiles and toggles direct selection', () => {
    const setAllowDirectModelSelection = vi.fn().mockResolvedValue(true)
    render(<SubagentsSection {...props(ready, { setAllowDirectModelSelection })} />)
    expect(screen.getByRole('heading', { name: 'fast' })).toBeTruthy(); expect(screen.getByText('deepseek / chat')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Edit fast' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete fast' })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox')); expect(setAllowDirectModelSelection).toHaveBeenCalledWith(true)
  })
  it('shows a compact preview for configured child instructions', () => {
    const state: SubagentsState = {
      ...ready,
      value: {
        ...ready.value,
        profiles: {
          fast: {
            description: 'Quick work',
            provider: 'deepseek',
            model: 'chat',
            instruction: 'Inspect evidence before reporting.',
            reasoningEffort: 'high',
          },
        },
      },
    }
    render(<SubagentsSection {...props(state)} />)
    expect(screen.getByText('Inspect evidence before reporting.', { exact: false })).toBeTruthy()
    expect(screen.getByText('deepseek / chat · high')).toBeTruthy()
  })
  it('accepts arbitrary manual provider and model strings when adding', () => {
    const saveProfile = vi.fn().mockResolvedValue(true)
    render(<SubagentsSection {...props(ready, { saveProfile })} />); fireEvent.click(screen.getByText('Add profile'))
    const fields = ['Name', 'Description', 'Provider', 'Model'] as const
    ;['custom', 'Private route', 'my/provider', 'future:model'].forEach((value, index) => { fireEvent.change(screen.getByLabelText(fields[index]!), { target: { value } }) })
    fireEvent.change(screen.getByLabelText(/Reasoning effort/), { target: { value: 'max' } })
    fireEvent.change(screen.getByRole('textbox', { name: /Child system instruction/ }), {
      target: { value: 'Inspect evidence.\nReport uncertainty.' },
    })
    fireEvent.click(screen.getByText('Save'))
    expect(saveProfile).toHaveBeenCalledWith('custom', {
      description: 'Private route',
      provider: 'my/provider',
      model: 'future:model',
      instruction: 'Inspect evidence.\nReport uncertainty.',
      reasoningEffort: 'max',
    }, undefined)
  })
  it('suggests exact-model reasoning efforts and catalog defaults', () => {
    render(<SubagentsSection {...props(ready)} />)
    fireEvent.click(screen.getByText('Add profile'))
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'deepseek' } })
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'chat' } })
    expect(screen.getByText(/Catalog default: high/)).toBeTruthy()
    expect(document.querySelector('#subagent-reasoning-efforts option')?.getAttribute('value')).toBe('high')
  })
  it('validates required fields and disables editing when read-only', () => {
    const { rerender } = render(<SubagentsSection {...props(ready)} />); fireEvent.click(screen.getByText('Add profile')); fireEvent.click(screen.getByText('Save')); expect(screen.getByRole('alert').textContent).toBe('Complete every field.')
    rerender(<SubagentsSection {...props({ ...ready, writable: false })} />); expect(screen.getByText('This settings provider is read-only.')).toBeTruthy(); expect(screen.getByText('Add profile').closest('button')?.disabled).toBe(true)
  })
  it('edits and deletes an existing profile', async () => {
    const saveProfile = vi.fn().mockResolvedValue(true); const deleteProfile = vi.fn().mockResolvedValue(true)
    render(<SubagentsSection {...props(ready, { saveProfile, deleteProfile })} />)
    fireEvent.click(screen.getByText('Edit')); const inputs = screen.getAllByRole('textbox'); fireEvent.change(inputs[0]!, { target: { value: 'renamed' } }); fireEvent.click(screen.getByText('Save'))
    expect(saveProfile).toHaveBeenCalledWith('renamed', expect.objectContaining({ provider: 'deepseek', model: 'chat' }), 'fast')
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Edit subagent profile' })).toBeNull() })
    fireEvent.click(screen.getByText('Delete')); fireEvent.click(screen.getAllByText('Delete').at(-1)!); expect(deleteProfile).toHaveBeenCalledWith('fast')
  })
  it('renders loading, unavailable, error, empty, and saving states', () => {
    const load = vi.fn().mockResolvedValue(undefined)
    const { container, rerender } = render(<SubagentsSection {...props({ ...ready, status: 'loading' }, { load })} />)
    expect(screen.getByText('Loading subagent settings…')).toBeTruthy()
    rerender(<SubagentsSection {...props({ ...ready, status: 'idle' }, { load })} />)
    expect(screen.getByText('Loading subagent settings…')).toBeTruthy()
    rerender(<SubagentsSection {...props({ ...ready, status: 'unavailable' }, { load })} />)
    expect(container.textContent).toBe('')
    rerender(<SubagentsSection {...props({ ...ready, status: 'error', error: null }, { load })} />)
    fireEvent.click(screen.getByText('Retry')); expect(load).toHaveBeenCalled()
    rerender(<SubagentsSection {...props({ ...ready, value: { allowDirectModelSelection: false, profiles: {} }, error: 'catalog failed' })} />)
    expect(screen.getByText('No profiles yet.')).toBeTruthy(); expect(screen.getByRole('alert').textContent).toBe('catalog failed')
    rerender(<SubagentsSection {...props({ ...ready, status: 'saving' })} />)
    expect(screen.getByText('Add profile').closest('button')?.disabled).toBe(true)
  })
  it('keeps failed saves and deletes open and validates duplicate renames', async () => {
    const state: SubagentsState = { ...ready, value: { ...ready.value, profiles: {
      fast: ready.value.profiles.fast!, slow: { description: 'Slow', provider: 'p', model: 'm' },
    } } }
    const saveProfile = vi.fn().mockResolvedValue(false)
    const deleteProfile = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    render(<SubagentsSection {...props(state, { saveProfile, deleteProfile })} />)
    fireEvent.click(screen.getAllByText('Edit')[0]!); fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'slow' } }); fireEvent.click(screen.getByText('Save'))
    expect(screen.getByRole('alert').textContent).toBe('A profile with this name already exists.')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'renamed' } }); fireEvent.click(screen.getByText('Save'))
    await waitFor(() => { expect(saveProfile).toHaveBeenCalled() }); expect(screen.getByRole('dialog', { name: 'Edit subagent profile' })).toBeTruthy()
    fireEvent.click(screen.getByText('Cancel')); expect(screen.queryByRole('dialog', { name: 'Edit subagent profile' })).toBeNull()
    fireEvent.click(screen.getAllByText('Delete')[0]!); fireEvent.click(screen.getAllByText('Delete').at(-1)!)
    await waitFor(() => { expect(deleteProfile).toHaveBeenCalledTimes(1) }); expect(screen.getByRole('dialog', { name: 'Delete this profile?' })).toBeTruthy()
    fireEvent.click(screen.getAllByText('Delete').at(-1)!); await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Delete this profile?' })).toBeNull() })
  })
  it('marks composition profiles and prevents renaming or deleting them', () => {
    render(<SubagentsSection {...props({ ...ready, baseProfileNames: ['fast'] })} />)
    expect(screen.getByText('Deployment default')).toBeTruthy()
    expect(screen.queryByText('Delete')).toBeNull()
    fireEvent.click(screen.getByText('Edit'))
    expect(screen.getByLabelText('Name').hasAttribute('disabled')).toBe(true)
  })
  it('persists reset markers when optional deployment defaults are cleared', () => {
    const saveProfile = vi.fn().mockResolvedValue(true)
    const state: SubagentsState = {
      ...ready,
      baseProfileNames: ['fast'],
      value: { ...ready.value, profiles: { fast: {
        ...ready.value.profiles.fast!,
        instruction: 'Inspect every claim.',
        reasoningEffort: 'high',
      } } },
    }
    render(<SubagentsSection {...props(state, { saveProfile })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit fast' }))
    fireEvent.change(screen.getByLabelText(/Reasoning effort/), { target: { value: '' } })
    fireEvent.change(screen.getByRole('textbox', { name: /Child system instruction/ }), { target: { value: '' } })
    fireEvent.click(screen.getByText('Save'))
    expect(saveProfile).toHaveBeenCalledWith('fast', {
      description: 'Quick work',
      provider: 'deepseek',
      model: 'chat',
      instruction: null,
      reasoningEffort: null,
    }, 'fast')
  })
  it('marks and resets a customized deployment default', () => {
    const deleteProfile = vi.fn().mockResolvedValue(true)
    render(<SubagentsSection {...props({
      ...ready, baseProfileNames: ['fast'], userProfileNames: ['fast'],
    }, { deleteProfile })} />)
    expect(screen.getByText('Customized default')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reset fast' }))
    expect(deleteProfile).toHaveBeenCalledWith('fast')
  })
  it('closes add and delete dialogs through their close controls', () => {
    render(<SubagentsSection {...props(ready)} />)
    fireEvent.click(screen.getByText('Add profile')); fireEvent.click(screen.getByRole('button', { name: 'Close' })); expect(screen.queryByRole('dialog', { name: 'Add subagent profile' })).toBeNull()
    fireEvent.click(screen.getByText('Delete')); fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(screen.queryByRole('dialog', { name: 'Delete this profile?' })).toBeNull()
    fireEvent.click(screen.getByText('Delete')); fireEvent.click(screen.getByRole('button', { name: 'Close' })); expect(screen.queryByRole('dialog', { name: 'Delete this profile?' })).toBeNull()
  })
})
