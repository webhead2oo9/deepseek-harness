/** Package invariant companion for the browser-only Subagents settings page. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-settings-subagents'

/** Cordis companion plugin name. */
export const name = 'client-ui-settings-subagents-invariant'
/** Service required to reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the Host half owns no event stream or mutable data. */
const install: InvariantInstaller = () => {}

/** Register this package's empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
