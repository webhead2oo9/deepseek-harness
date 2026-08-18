// Web e2e scenario: persisted subagent model profiles and direct-selection policy.
// Zero model calls: this exercises the real settings service, API, browser plugin,
// and settings file without mounting a replay adapter.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/subagent-model-profiles', import.meta.url))
const CONFIGURED_EXPECTED = join(SNAPSHOT_DIR, 'configured.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: subagent model profiles persist through settings', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('adds an opaque RunInfra route and enables direct model selection', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-model-profiles'))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: '子代理', exact: true }).click()
    await settings.getByRole('heading', { name: '子代理', exact: true }).waitFor({ timeout: 10_000 })

    await settings.getByRole('button', { name: '添加配置' }).click()
    const editor = page.getByRole('dialog', { name: '添加子代理配置' })
    await editor.getByLabel('名称', { exact: true }).fill('deep')
    await editor.getByLabel('描述', { exact: true }).fill('复杂分析与审查')
    await editor.getByLabel('提供商', { exact: true }).fill('runinfraprovider')
    await editor.getByLabel('模型', { exact: true }).fill('reasoning-model')
    await editor.getByLabel(/^推理强度（可选）/).fill('high')
    await editor.getByLabel(/^子代理系统指令（可选）/).fill('核对证据，并明确说明不确定性。')
    await editor.getByRole('button', { name: '保存' }).click()
    await editor.waitFor({ state: 'detached', timeout: 10_000 })
    await settings.getByText('runinfraprovider / reasoning-model').waitFor({ timeout: 10_000 })

    const direct = settings.getByRole('checkbox', { name: /允许直接选择模型/ })
    await direct.click()
    await expect.poll(() => direct.isChecked(), { timeout: 10_000 }).toBe(true)
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 10_000 })
      .toContain('runinfraprovider')
    const stored = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(stored).toContain('allowDirectModelSelection: true')
    expect(stored).toContain('reasoning-model')
    expect(stored).toContain('reasoningEffort: high')
    expect(stored).toContain('核对证据，并明确说明不确定性。')

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(CONFIGURED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)
})
