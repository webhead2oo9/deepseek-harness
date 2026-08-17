/** Package-owned invariant companion for the xAI OAuth provider. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-xai'

/** Cordis companion plugin name. */
export const name = 'llm-xai-invariant'
/** Service required before package ownership registration. */
export const inject = ['invariants']

/** No runtime invariant: both registrations are lifecycle-owned effects. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
