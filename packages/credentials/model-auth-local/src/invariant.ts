/** Package-owned invariant companion for `@deepseek-ai/dsh-model-auth-local`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-model-auth-local'

/** Cordis companion plugin name. */
export const name = 'model-auth-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the Service Definition companion owns event lifetime;
 * driver registration, persistence, refresh serialization, and teardown are
 * asynchronous operations pinned by this provider's tests.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
