/** Exa web-search configuration card. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SecretField, SelectField, ToggleField, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { ExaSearchCardFace } from './exa-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the Exa card. */
export type ExaSearchCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<ExaSearchCardFace>

/**
 * Render Exa search settings.
 * @param props - locale copy, form state, and form actions.
 * @returns the Exa card.
 */
export function ExaSearchCard(props: ExaSearchCardProps) {
  const { t } = props
  const state = props.useExaSearchCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="exaSearchTitle"
      descriptionKey="exaSearchDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <SecretField
        id="plugin-config-exa-search-key"
        label={t('exaSearchApiKey')}
        hint={t('exaSearchApiKeyHint')}
        disabled={!state.apiKeyWritable}
        text={state.apiKey.text}
        configured={state.apiKeyConfigured}
        stateLabel={state.apiKeyConfigured ? t('exaSearchApiKeySet') : t('exaSearchApiKeyUnset')}
        onEdit={(text) => { props.edit('apiKey', text) }}
      />
      <ValueField
        id="plugin-config-exa-search-endpoint"
        label={t('exaSearchBaseUrl')}
        hint={t('exaSearchBaseUrlHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.baseURL}
        onEdit={(text) => { props.edit('baseURL', text) }}
        onReset={() => { props.resetField('baseURL') }}
      />
      <SelectField
        id="plugin-config-exa-search-mode"
        label={t('exaSearchMode')}
        hint={t('exaSearchModeHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        options={[
          { value: 'auto', label: t('exaSearchModeAuto') },
          { value: 'fast', label: t('exaSearchModeFast') },
          { value: 'instant', label: t('exaSearchModeInstant') },
        ]}
        {...state.searchType}
        onEdit={(text) => { props.edit('searchType', text) }}
        onReset={() => { props.resetField('searchType') }}
      />
      <ValueField
        id="plugin-config-exa-search-results"
        label={t('exaSearchResults')}
        hint={t('exaSearchResultsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.numResults}
        onEdit={(text) => { props.edit('numResults', text) }}
        onReset={() => { props.resetField('numResults') }}
      />
      <ToggleField
        id="plugin-config-exa-search-moderation"
        label={t('exaSearchModeration')}
        hint={t('exaSearchModerationHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.moderation}
        onEdit={(text) => { props.edit('moderation', text) }}
        onReset={() => { props.resetField('moderation') }}
      />
      <ValueField
        id="plugin-config-exa-search-highlights"
        label={t('exaSearchHighlights')}
        hint={t('exaSearchHighlightsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.highlightsMaxCharacters}
        onEdit={(text) => { props.edit('highlightsMaxCharacters', text) }}
        onReset={() => { props.resetField('highlightsMaxCharacters') }}
      />
      <ValueField
        id="plugin-config-exa-search-freshness"
        label={t('exaSearchFreshness')}
        hint={t('exaSearchFreshnessHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.maxAgeHours}
        onEdit={(text) => { props.edit('maxAgeHours', text) }}
        onReset={() => { props.resetField('maxAgeHours') }}
      />
    </PluginCard>
  )
}
