/** Model-auth driver that binds Codex OAuth records to request authorization. */

import { modelAuthProviderId } from '@deepseek-ai/dsh-model-auth'
import type {
  ModelAuthDriver,
  ModelAuthLoginMethod,
  ModelAuthLoginOperation,
  ModelAuthResolution,
  ModelAuthResolveOptions,
} from '@deepseek-ai/dsh-model-auth'
import { codexAccount, parseCodexAuthRecord } from './jwt.ts'
import {
  assertAllowedWorkspace,
  refreshCodexRecord,
  shouldRefreshCodexRecord,
  startBrowserLogin,
  startDeviceLogin,
} from './oauth.ts'
import type { CodexOAuthOptions } from './oauth.ts'

/** Provider route and auth-driver id owned by this package. */
export const CODEX_PROVIDER = modelAuthProviderId('openai-codex')

/** Native ChatGPT Codex OAuth driver. */
export class CodexAuthDriver implements ModelAuthDriver {
  readonly id = CODEX_PROVIDER
  readonly displayName = 'OpenAI Codex'
  readonly methods = ['browser', 'device'] as const satisfies readonly ModelAuthLoginMethod[]

  constructor(private readonly options: CodexOAuthOptions) {}

  startLogin(method: ModelAuthLoginMethod, signal: AbortSignal): Promise<ModelAuthLoginOperation> {
    switch (method) {
      case 'browser': return startBrowserLogin(this.options, signal)
      case 'device': return startDeviceLogin(this.options, signal)
    }
  }

  inspect(record: unknown): ReturnType<typeof codexAccount> {
    return codexAccount(parseCodexAuthRecord(record))
  }

  async resolve(record: unknown, options: ModelAuthResolveOptions): Promise<ModelAuthResolution> {
    const current = parseCodexAuthRecord(record)
    assertAllowedWorkspace(this.options, current)
    const refreshed = options.forceRefresh || shouldRefreshCodexRecord(this.options, current)
      ? await refreshCodexRecord(this.options, current, options.signal)
      : current
    return {
      authorization: {
        headers: {
          authorization: `Bearer ${refreshed.accessToken}`,
          originator: this.options.originator,
          ...refreshed.accountId === undefined ? {} : { 'ChatGPT-Account-ID': refreshed.accountId },
          ...refreshed.fedRamp ? { 'x-openai-internal-codex-residency': 'us' } : {},
        },
      },
      ...refreshed === current ? {} : { record: refreshed },
    }
  }
}
