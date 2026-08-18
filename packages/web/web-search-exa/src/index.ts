/**
 * Register an Exa-backed provider in `ctx.web`. The plugin layers live settings
 * over its composition entry and resolves the configured credential for every
 * search, so key and settings changes reach the next operation without reload.
 *
 * @module @deepseek-ai/dsh-web-search-exa
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  ExaSearchProvider,
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_MODERATION,
  EXA_DEFAULT_SEARCH_TYPE,
} from './provider.ts'
import type { ExaSearchProviderOptions } from './provider.ts'
import type { ExaSearchType } from './types.ts'

export {
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_MODERATION,
  EXA_DEFAULT_SEARCH_TYPE,
  EXA_PROVIDER_ID,
  ExaSearchProvider,
} from './provider.ts'
export type { ExaSearchProviderOptions } from './provider.ts'
export type { ExaSearchType } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-exa'

/** The web capability this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'EXA_API_KEY'

/** Live plugin configuration served through the settings namespace. */
export interface Config {
  /** Literal Exa API key; prefer {@link apiKeyEnv}. */
  apiKey?: string
  /** Credential reference resolved for each search. */
  apiKeyEnv?: string
  /** Exa endpoint base; `/search` is appended. */
  baseURL?: string
  /** Standard Exa retrieval mode. */
  searchType?: ExaSearchType
  /** Default result count when the shared request carries no bound. */
  numResults?: number
  /** Whether Exa filters unsafe results. */
  moderation?: boolean
  /** Optional highlight character budget per result. */
  highlightsMaxCharacters?: number
  /** Optional cached-content age in hours; `0` fetches fresh and `-1` is cache-only. */
  maxAgeHours?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(EXA_DEFAULT_BASE_URL),
  searchType: z.union(['auto', 'fast', 'instant'] as const).default(EXA_DEFAULT_SEARCH_TYPE),
  numResults: z.number().step(1).min(1).max(100),
  moderation: z.boolean().default(EXA_DEFAULT_MODERATION),
  highlightsMaxCharacters: z.number().step(1).min(1).max(10_000),
  maxAgeHours: z.number().step(1).min(-1).max(720),
})

/** Settings namespace and Plugins-page card dispatch key. */
export const WEB_SEARCH_EXA_SETTINGS_NAMESPACE = settingsNamespace('web-search-exa')

function resolveOptions(ctx: Context, config: Config): ExaSearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL ?? EXA_DEFAULT_BASE_URL,
    searchType: config.searchType ?? EXA_DEFAULT_SEARCH_TYPE,
    ...config.numResults === undefined ? {} : { numResults: config.numResults },
    moderation: config.moderation ?? EXA_DEFAULT_MODERATION,
    ...config.highlightsMaxCharacters === undefined
      ? {}
      : { highlightsMaxCharacters: config.highlightsMaxCharacters },
    ...config.maxAgeHours === undefined ? {} : { maxAgeHours: config.maxAgeHours },
  }
}

/** Register the live settings section and Exa provider. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_EXA_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new ExaSearchProvider(() => resolveOptions(ctx, current())))
}
