import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('Subagents locale dictionaries', () => {
  it('keep English and Chinese keys aligned', () => { expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort()); expect(en.nav).toBe('Subagents'); expect(zh.nav).toBe('子代理') })
})
