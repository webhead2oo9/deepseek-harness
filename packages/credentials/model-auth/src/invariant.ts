/** Package-owned invariant companion for `@deepseek-ai/dsh-model-auth`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-model-auth'

/** Cordis companion plugin name. */
export const name = 'model-auth-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** A committed auth invalidation cannot outlive the service that owns it. */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('model-auth/updated', (provider) => {
    if (ctx.get('modelAuth') === undefined) {
      fail(`model-auth/updated for "${provider}" emitted without a live model-auth service`)
    }
  })
}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
