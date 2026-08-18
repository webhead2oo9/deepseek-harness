import { useEffect, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentProfile, SubagentsState } from './store.ts'
import type { SubagentsKey } from './locales.ts'
import css from './SubagentsSection.module.css'

/** Registration-side business face for the Subagents section. */
export interface SubagentsInjected {
  hooks: { subagents: SnapshotStore<SubagentsState> }
  load: () => Promise<void>
  setAllowDirectModelSelection: (value: boolean) => Promise<boolean>
  saveProfile: (name: string, profile: SubagentProfile, previousName?: string) => Promise<boolean>
  deleteProfile: (name: string) => Promise<boolean>
}

/** Full component props derived from the settings slot and locale registration. */
export type SubagentsSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.subagents'> & InjectFace<SubagentsInjected>

interface Draft {
  original?: string
  base?: boolean
  name: string
  description: string
  provider: string
  model: string
  instruction: string
  reasoningEffort: string
}
const blankDraft = (): Draft => ({
  name: '', description: '', provider: '', model: '', instruction: '', reasoningEffort: '',
})

/**
 * Render and edit subagent model-selection profiles.
 * @param props - settings slot runtime, locale, and injected Host operations.
 * @returns the complete Subagents settings section.
 */
export function SubagentsSection(props: SubagentsSectionProps): ReactNode {
  const state = props.useSubagents(snapshot => snapshot)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [validation, setValidation] = useState<SubagentsKey | null>(null)
  useEffect(() => { void props.load() }, [props.load])

  if (state.status === 'loading' || state.status === 'idle') return <p>{props.t('loading')}</p>
  if (state.status === 'unavailable') return null
  if (state.status === 'error') return <div><p role="alert">{`${props.t('error')} ${state.error ?? ''}`}</p><Button onClick={() => { void props.load() }}>{props.t('retry')}</Button></div>

  const profiles = Object.entries(state.value.profiles).sort(([a], [b]) => a.localeCompare(b))
  const providerSuggestions = [...new Map(
    state.suggestions.map(item => [item.provider, item.providerName] as const),
  ).entries()]
  const modelSuggestions = state.suggestions
    .filter(item => draft?.provider === '' || item.provider === draft?.provider)
  const selectedSuggestion = state.suggestions.find(item =>
    item.provider === draft?.provider && item.model === draft.model)
  const effortSuggestions = selectedSuggestion?.reasoningEfforts ?? []
  const openEdit = (name: string, profile: SubagentProfile): void => {
    setDraft({
      original: name,
      base: state.baseProfileNames.includes(name),
      name,
      ...profile,
      instruction: profile.instruction ?? '',
      reasoningEffort: profile.reasoningEffort ?? '',
    })
  }
  const save = async (): Promise<void> => {
    /* v8 ignore next -- the save action is rendered only while the draft modal is open. */
    if (draft === null) return
    if ([draft.name, draft.description, draft.provider, draft.model].some(value => value.trim().length === 0)) {
      setValidation('required'); return
    }
    if (draft.original !== draft.name && Object.hasOwn(state.value.profiles, draft.name)) {
      setValidation('duplicate'); return
    }
    const saved = await props.saveProfile(
      draft.name,
      {
        description: draft.description,
        provider: draft.provider,
        model: draft.model,
        ...draft.instruction.trim().length === 0
          ? draft.base === true ? { instruction: null } : {}
          : { instruction: draft.instruction },
        ...draft.reasoningEffort.trim().length === 0
          ? draft.base === true ? { reasoningEffort: null } : {}
          : { reasoningEffort: draft.reasoningEffort.trim() },
      },
      draft.original,
    )
    if (saved) { setDraft(null); setValidation(null) }
  }
  const disabled = !state.writable || state.status === 'saving'

  return <div className={css.section}>
    <h2>{props.t('title')}</h2>
    <p className={css.intro}>{props.t('intro')}</p>
    {!state.writable && <p className={css.notice}>{props.t('readOnly')}</p>}
    {state.error !== null && <p role="alert" className={css.error}>{state.error}</p>}
    <label className={css.toggle}>
      <input type="checkbox" checked={state.value.allowDirectModelSelection} disabled={disabled}
        onChange={(event) => { void props.setAllowDirectModelSelection(event.target.checked) }} />
      <span><strong>{props.t('directLabel')}</strong><small>{props.t('directHint')}</small></span>
    </label>
    <div className={css.heading}><h3>{props.t('profiles')}</h3><Button disabled={disabled} onClick={() => { setDraft(blankDraft()) }}>{props.t('add')}</Button></div>
    {profiles.length === 0 ? <p>{props.t('empty')}</p> : <ul className={css.list}>{profiles.map(([name, profile]) => {
      const base = state.baseProfileNames.includes(name)
      const overridden = base && state.userProfileNames.includes(name)
      return <li key={name} className={css.card}>
        <div className={css.summary}>
          <div className={css.profileTitle}>
            <h4>{name}</h4>
            {base && <small>{props.t(overridden ? 'customizedDefault' : 'deploymentDefault')}</small>}
          </div>
          <p>{profile.description}</p>
          <code>{profile.provider} / {profile.model}{typeof profile.reasoningEffort === 'string' ? ` · ${profile.reasoningEffort}` : ''}</code>
          {typeof profile.instruction === 'string' && <p className={css.instructionPreview}><strong>{props.t('instructionConfigured')}</strong> {profile.instruction}</p>}
        </div>
        <div className={css.actions}>
          <Button variant="outline" disabled={disabled} aria-label={`${props.t('edit')} ${name}`} onClick={() => { openEdit(name, profile) }}>{props.t('edit')}</Button>
          {overridden && <Button variant="outline" disabled={disabled} aria-label={`${props.t('reset')} ${name}`} onClick={() => { void props.deleteProfile(name) }}>{props.t('reset')}</Button>}
          {!base && <Button variant="outline" disabled={disabled} aria-label={`${props.t('delete')} ${name}`} onClick={() => { setPendingDelete(name) }}>{props.t('delete')}</Button>}
        </div>
      </li>
    })}</ul>}
    <Modal open={draft !== null} onClose={() => { setDraft(null); setValidation(null) }} title={draft?.original === undefined ? props.t('addTitle') : props.t('editTitle')} closeLabel={props.t('close')}
      footer={<><Button variant="outline" onClick={() => { setDraft(null); setValidation(null) }}>{props.t('cancel')}</Button><Button disabled={disabled} onClick={() => { void save() }}>{props.t('save')}</Button></>}>
      {draft !== null && <div className={css.fields}>
        {(['name', 'description', 'provider', 'model'] as const).map(field => <label key={field}><span>{props.t(field)}</span><input value={draft[field]} disabled={field === 'name' && draft.base === true} list={field === 'provider' ? 'subagent-providers' : field === 'model' ? 'subagent-models' : undefined} onChange={(event) => { setDraft({ ...draft, [field]: event.target.value }); setValidation(null) }} /></label>)}
        <label>
          <span>{props.t('reasoningEffort')}</span>
          <input
            value={draft.reasoningEffort}
            list="subagent-reasoning-efforts"
            onChange={(event) => { setDraft({ ...draft, reasoningEffort: event.target.value }); setValidation(null) }}
          />
          <small>{selectedSuggestion?.defaultReasoningEffort === undefined
            ? props.t('reasoningEffortHint')
            : `${props.t('reasoningEffortHint')} ${props.t('reasoningEffortDefault')} ${selectedSuggestion.defaultReasoningEffort}`}</small>
        </label>
        <label>
          <span>{props.t('instruction')}</span>
          <textarea
            value={draft.instruction}
            rows={5}
            onChange={(event) => {
              setDraft({ ...draft, instruction: event.target.value })
              setValidation(null)
            }}
          />
          <small>{props.t('instructionHint')}</small>
        </label>
        <datalist id="subagent-providers">{providerSuggestions.map(([id, name]) => <option key={id} value={id} label={name} />)}</datalist>
        <datalist id="subagent-models">{modelSuggestions.map(item => <option key={`${item.provider}:${item.model}`} value={item.model} label={`${item.providerName} · ${item.modelName}`} />)}</datalist>
        <datalist id="subagent-reasoning-efforts">{effortSuggestions.map(effort => <option key={effort.id} value={effort.id} label={effort.name} />)}</datalist>
        {validation !== null && <p role="alert" className={css.error}>{props.t(validation)}</p>}
      </div>}
    </Modal>
    <Modal open={pendingDelete !== null} onClose={() => { setPendingDelete(null) }} title={props.t('deleteTitle')} description={props.t('deleteDescription')} closeLabel={props.t('close')}
      footer={<><Button variant="outline" onClick={() => { setPendingDelete(null) }}>{props.t('cancel')}</Button><Button onClick={() => {
        /* v8 ignore next -- the confirm action is rendered only while a delete target exists. */
        if (pendingDelete === null) return
        void props.deleteProfile(pendingDelete).then((deleted) => { if (deleted) setPendingDelete(null) })
      }}>{props.t('delete')}</Button></>} />
  </div>
}
