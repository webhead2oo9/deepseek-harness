/** Browser plugin registering the Subagents settings section. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { SubagentsSection, type SubagentsInjected } from './SubagentsSection.tsx'
import { en, zh, type SubagentsKey } from './locales.ts'
import { SUBAGENT_SETTINGS_NS, SubagentsController, refreshIfLoaded } from './store.ts'

export type { SubagentsInjected, SubagentsSectionProps } from './SubagentsSection.tsx'
export type { ModelSuggestion, SubagentProfile, SubagentSettingsValue, SubagentsState } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.subagents': SubagentsKey }
}

/** Required browser services. */
export const inject = ['slots', 'locale', 'connection', 'remote']

/**
 * Register localized Subagents settings and pushed invalidations.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const ns = 'settings.subagents'
  ctx.effect(() => ctx.locale.register(ns, { zh, en }), 'ui-settings-subagents: copy dictionaries')
  const api = (ctx.get('connection') as ConnectionHandle).api
  const controller = new SubagentsController(api)
  ctx.effect(() => {
    const refresh = (): void => { refreshIfLoaded(controller) }
    const disposers = [
      ctx.remote.$on('settings/document-updated', (changed) => { if (changed === SUBAGENT_SETTINGS_NS) refresh() }),
      ctx.remote.$on('llm/adapters-updated', refresh),
      ctx.on('connection/reset', refresh),
    ]
    return () => { controller.dispose(); for (const dispose of disposers) dispose() }
  }, 'ui-settings-subagents: pushed invalidations')
  const t = ctx.locale.bind(ns) as (key: SubagentsKey) => string
  const injected = (): SubagentsInjected => ({
    hooks: { subagents: controller.store }, load: () => controller.load(),
    setAllowDirectModelSelection: value => controller.setAllowDirectModelSelection(value),
    saveProfile: (name, profile, previousName) => controller.saveProfile(name, profile, previousName),
    deleteProfile: name => controller.deleteProfile(name),
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'subagents', order: 30, label: () => t('nav'), locale: ns, inject: injected,
  }, SubagentsSection))
}
