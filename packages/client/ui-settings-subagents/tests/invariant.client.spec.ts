import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as invariant from '../src/invariant.ts'
import { apply } from '../src/index.ts'

describe('package companions', () => {
  it('registers the explained empty invariant', async () => { const ctx = new Context(); await ctx.plugin(InvariantRegistry, { enabled: true }); await expect(ctx.plugin(invariant).await()).resolves.toBeDefined() })
  it('has an empty Host apply', () => {
    expect(apply).not.toThrow()
  })
})
