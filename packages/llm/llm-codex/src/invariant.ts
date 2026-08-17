/** Package-owned invariant companion for the native Codex provider. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-codex'

/** Cordis companion plugin name. */
export const name = 'llm-codex-invariant'
/** Service required before package ownership registration. */
export const inject = ['invariants']

/**
 * No runtime invariant: adapter and auth-driver registrations are lifecycle
 * effects, and this package exposes no independent event sequence or mutable
 * data relation for a companion to verify.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
