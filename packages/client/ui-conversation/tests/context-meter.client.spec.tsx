// @vitest-environment jsdom
// ContextMeter (composer trailing control): occupancy ring gating, the
// click-open breakdown panel, and its close gestures.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn, zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/index.ts'
import { ContextMeter, type ContextMeterProps } from '../src/client/skeleton/ContextMeter.tsx'
import css from '../src/client/skeleton/ContextMeter.module.css'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

// Mirrors the real lookup chain (conversation namespace, then common).
const t = makeTranslate(zh, commonZh) as ContextMeterProps['t']
const tEn = makeTranslate(en, commonEn) as ContextMeterProps['t']

const BREAKDOWN = { systemTokens: 120, toolsTokens: 21_500, messageTokens: 477_000 }

const segmentClass = css.segment
const occupancyClass = css.occupancy
if (segmentClass === undefined) throw new Error('segment class missing from ContextMeter.module.css')
if (occupancyClass === undefined) throw new Error('occupancy class missing from ContextMeter.module.css')

/** Stub the projection seat: a key-addressed table of whole values. */
function projections(values: Record<string, unknown>): ContextMeterProps['useProjection'] {
  return (key: string) => values[key]
}

function meter(values: Record<string, unknown>, translate: ContextMeterProps['t'] = t) {
  return render(<ContextMeter useProjection={projections(values)} t={translate} />)
}

describe('ContextMeter', () => {
  it('renders nothing until both pressure and capacity are known', () => {
    expect(meter({}).container.textContent).toBe('')
    expect(meter({ contextPressure: { pressureTokens: 32_000 } }).container.textContent).toBe('')
    expect(meter({ contextPressure: { contextWindow: 128_000 } }).container.textContent).toBe('')
  })

  it('uses the model-resolved capacity instead of a fixed adapter fallback', () => {
    const view = meter({
      contextPressure: { pressureTokens: 250_000, contextWindow: 1_000_000 },
    })
    const trigger = view.getByRole('button', { name: '上下文已用 25%' })
    fireEvent.click(trigger)
    const panel = view.getByRole('dialog', { name: '上下文用量' })
    expect(panel.textContent).toContain('~250K / 1M')
    expect(panel.textContent).toContain('约剩余 750K')
  })

  it('shows the occupancy ring and opens the breakdown panel on click', () => {
    const view = meter({
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    })
    const trigger = view.getByRole('button', { name: '上下文已用 25%' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-controls')).toBeNull()
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
    fireEvent.click(trigger)
    const panel = view.getByRole('dialog', { name: '上下文用量' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id)
    expect(panel.textContent).toContain('~32K / 128K')
    expect(panel.textContent).toContain('约剩余 96K')
    expect(panel.textContent).toContain('25%')
    expect(panel.textContent).toContain('上下文已用')
    expect(panel.textContent).toContain('系统提示词~120')
    expect(panel.textContent).toContain('工具~21.5K')
    expect(panel.textContent).toContain('对话消息~477K')
    // The outer fill owns the occupancy bound; heuristic composition divides only that fill.
    const occupancy = panel.getElementsByClassName(occupancyClass)[0]
    expect(occupancy?.getAttribute('style')).toContain('width: 25%')
    expect(panel.getElementsByClassName(segmentClass)).toHaveLength(3)
    // Clicking the trigger again toggles the panel shut.
    fireEvent.click(trigger)
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('renders each locale headline verbatim', () => {
    const values = {
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    }
    const zhView = meter(values)
    fireEvent.click(zhView.getByRole('button', { name: '上下文已用 25%' }))
    expect(zhView.container.querySelector('[role="dialog"]')!.textContent)
      .toMatch(/^上下文已用 25%/)
    const enView = meter(values, tEn)
    fireEvent.click(enView.getByRole('button', { name: '25% of context used' }))
    const enPanel = enView.container.querySelector('[role="dialog"]')!
    expect(enPanel.textContent).toMatch(/^25% of context used/)
    expect(enPanel.textContent).toContain('~96K remaining')
  })

  it('draws no bar segment at zero occupancy', () => {
    const view = meter({
      contextPressure: { pressureTokens: 0, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    })
    fireEvent.click(view.getByRole('button', { name: '上下文已用 0%' }))
    const panel = view.container.querySelector('[role="dialog"]')!
    // `.segment` carries a min-width, so a zero-width part would still paint a
    // filled sliver over an empty context.
    expect(panel.getElementsByClassName(occupancyClass)).toHaveLength(0)
    expect(panel.getElementsByClassName(segmentClass)).toHaveLength(0)
    expect(panel.textContent).toContain('~0 / 128K')
    expect(panel.textContent).toContain('约剩余 128K')
  })

  it('clamps remaining capacity at zero when reported use exceeds the route capacity', () => {
    const view = meter({
      contextPressure: { pressureTokens: 150_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    })
    fireEvent.click(view.getByRole('button', { name: '上下文已用 100%' }))
    const panel = view.container.querySelector('[role="dialog"]')!
    expect(panel.textContent).toContain('约剩余 0')
    expect(panel.getElementsByClassName(occupancyClass)[0]?.getAttribute('style')).toContain('width: 100%')
  })

  it('reads the ring from the projected figure so a compaction shows at once', () => {
    // Same provider sample, a surface a compaction just shrank: the ring must
    // follow the projection rather than the sample it is anchored to.
    const view = meter({
      contextPressure: { pressureTokens: 32_000, projectedTokens: 3_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    })
    const trigger = view.getByRole('button', { name: '上下文已用 2%' })
    fireEvent.click(trigger)
    const panel = view.container.querySelector('[role="dialog"]')!
    expect(panel.textContent).toContain('~3K / 128K')
    expect(panel.textContent).toContain('约剩余 125K')
    expect(panel.getElementsByClassName(occupancyClass)[0]?.getAttribute('style')).toContain('width: 2%')
  })

  it('omits zero-valued composition parts inside the bounded fill', () => {
    const view = meter({
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextBreakdown: { systemTokens: 0, toolsTokens: 8_000, messageTokens: 24_000 },
    })
    fireEvent.click(view.getByRole('button', { name: '上下文已用 25%' }))
    const panel = view.container.querySelector('[role="dialog"]')!
    expect(panel.getElementsByClassName(occupancyClass)[0]?.getAttribute('style')).toContain('width: 25%')
    expect(panel.getElementsByClassName(segmentClass)).toHaveLength(2)
  })

  it('omits the composition rows while the contextBreakdown projection is absent', () => {
    const view = meter({ contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 } })
    fireEvent.click(view.getByRole('button', { name: '上下文已用 25%' }))
    const panel = view.container.querySelector('[role="dialog"]')!
    expect(panel.textContent).toContain('~32K / 128K')
    expect(panel.textContent).not.toContain('系统提示词')
    expect(panel.textContent).not.toContain('对话消息')
    // Without composition shares, the bounded fill falls back to one plain segment.
    expect(panel.getElementsByClassName(occupancyClass)[0]?.getAttribute('style')).toContain('width: 25%')
    expect(panel.getElementsByClassName(segmentClass)).toHaveLength(1)
  })

  it('closes when capacity disappears and stays closed when it returns', () => {
    let values: Record<string, unknown> = {
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    }
    const view = render(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    fireEvent.click(view.getByRole('button', { name: '上下文已用 25%' }))
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull()

    values = { contextPressure: { pressureTokens: 32_000 }, contextBreakdown: BREAKDOWN }
    view.rerender(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    expect(view.container.textContent).toBe('')

    values = {
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    }
    view.rerender(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    expect(view.getByRole('button', { name: '上下文已用 25%' }).getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('closes on outside pointerdown and Escape — but not inside clicks', () => {
    const values = {
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    }
    const view = render(
      <>
        <ContextMeter useProjection={projections(values)} t={t} />
        <button type="button">Outside test control</button>
      </>,
    )
    const trigger = view.getByRole('button', { name: '上下文已用 25%' })
    const outside = view.getByRole('button', { name: 'Outside test control' })
    const openPanel = () => {
      fireEvent.click(trigger)
      return view.container.querySelector('[role="dialog"]')!
    }
    // A pointerdown inside the panel keeps it open; outside closes it.
    const again = openPanel()
    fireEvent.pointerDown(again)
    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
    // Escape preserves focus within the meter, but never steals outside focus.
    trigger.focus()
    openPanel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    openPanel()
    outside.focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(outside)
  })
})
