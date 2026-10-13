import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type ElectronApplication,
  type Locator,
  type Page,
  type JSHandle,
  _electron as electron,
} from 'playwright'
import type { BrowserWindow } from 'electron'
import {
  beforeAll,
  afterAll,
  describe,
  expect,
  test,
} from 'vitest'

const root = path.join(__dirname, '..')
const testResultsDir = path.join(root, 'test-results')
let electronApp: ElectronApplication
let page: Page
let mainWin: JSHandle<BrowserWindow>
let userDataDir: string | undefined
const rendererErrors: string[] = []
const shouldSkipElectronE2E =
  process.platform === 'linux' ||
  process.env.CODEX_SANDBOX === 'seatbelt' ||
  process.env.FUSIONKIT_SKIP_E2E === '1'

if (shouldSkipElectronE2E) {
  test('electron e2e is skipped in environments that cannot launch Electron', () => {
    expect(true).true
  })
} else {
  beforeAll(async () => {
    userDataDir = await mkdtemp(path.join(tmpdir(), 'fusionkit-e2e-'))
    await mkdir(testResultsDir, { recursive: true })
    electronApp = await electron.launch({
      args: ['.', '--no-sandbox', `--user-data-dir=${userDataDir}`],
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        VITE_DEV_SERVER_URL: '',
      },
    })
    page = await electronApp.firstWindow()

    mainWin = await electronApp.browserWindow(page)
    await mainWin.evaluate(async (win) => {
      win.webContents.executeJavaScript('console.log("Execute JavaScript with e2e testing.")')
    })
    page.on('pageerror', (error) =>
      rendererErrors.push(error.stack ?? error.message),
    )
    page.on('console', (message) => {
      if (
        message.type() === 'error' &&
        /getSnapshot|Maximum update depth|uncaught|an error occurred|error boundary/i.test(
          message.text(),
        )
      ) {
        rendererErrors.push(message.text())
      }
    })
  }, 30_000)

  afterAll(async () => {
    if (page && !page.isClosed()) {
      await page.screenshot({
        path: path.join(testResultsDir, 'e2e-final.png'),
        animations: 'disabled',
      }).catch(() => undefined)
      await page.close().catch(() => undefined)
    }
    try {
      if (electronApp) {
        await electronApp.close()
      }
    } finally {
      if (userDataDir) {
        await rm(userDataDir, { recursive: true, force: true })
      }
    }
  }, 30_000)

  describe('[electron-vite-react] e2e tests', async () => {
    test('startup', async () => {
      const title = await page.title()
      expect(title).eq('FusionKit')
      expect(
        await page.evaluate(() => ({
          legacyIpcOn: typeof window.ipcRenderer?.on,
          localSubtitleSubscribe: typeof window.localSubtitleApi?.onTaskEvent,
          subtitleTranslationAuthorize:
            typeof window.subtitleTranslationApi?.authorizeInputFile,
        })),
      ).toEqual({
        legacyIpcOn: 'function',
        localSubtitleSubscribe: 'function',
        subtitleTranslationAuthorize: 'function',
      })
    })

    test('subtitle radio groups use the shared SegmentedControl baseline', async () => {
      await setWindowSize(mainWin, page, { width: 1280, height: 800 })
      await page.evaluate(() => {
        localStorage.clear()
        localStorage.setItem('lang', 'en')
        localStorage.setItem('subtitle-translator-tour-done', '1')
        window.location.hash = '#/tools/subtitle/translator'
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForFusionKitLoadingToExit(page)
      const subtitleField = page.locator('#tour-output-mode')
      await subtitleField.waitFor({ state: 'visible' })
      await subtitleField.evaluate((element) => {
        element.scrollIntoView({ block: 'center' })
      })
      const subtitleGroup = subtitleField.locator('[data-slot="segmented-control"]')
      expect(await segmentedControlUsesSharedBaseline(subtitleGroup)).toBe(true)
      await page.screenshot({
        path: path.join(testResultsDir, 'fix-r07-subtitle-radio-baseline.png'),
        animations: 'disabled',
      })

      expect(await hasHorizontalOverflow(page)).toBe(false)
    }, 60_000)

    test('segmented indicators ignore unrelated configuration height changes', async () => {
      await setWindowSize(mainWin, page, { width: 1280, height: 800 })
      await page.evaluate(() => {
        localStorage.clear()
        localStorage.setItem('lang', 'zh')
        localStorage.setItem('subtitle-translator-tour-done', '1')
        window.location.hash = '#/tools/subtitle/translator'
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForFusionKitLoadingToExit(page)

      const sliceGroup = page.locator(
        '#tour-slice-mode [data-slot="segmented-control"]',
      )
      await sliceGroup.waitFor({ state: 'visible' })
      await sliceGroup.evaluate((element) => {
        element.scrollIntoView({ block: 'center' })
      })

      const selectionAnimationOffsets = await sliceGroup.evaluate(async (group) => {
        const customOption = group.querySelector<HTMLElement>(
          '[data-value="CUSTOM"]',
        )
        if (!customOption) throw new Error('Custom slice option is missing')

        customOption.click()
        const offsets: number[] = []
        for (let frameIndex = 0; frameIndex < 36; frameIndex++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const selected = group.querySelector<HTMLElement>(
            '[role="radio"][aria-checked="true"]',
          )
          const indicator = group.querySelector<HTMLElement>(
            '[data-slot="segmented-control-indicator"]',
          )
          if (!selected || !indicator) {
            offsets.push(Number.POSITIVE_INFINITY)
            continue
          }
          const selectedRect = selected.getBoundingClientRect()
          const indicatorRect = indicator.getBoundingClientRect()
          offsets.push(Math.abs(selectedRect.left - indicatorRect.left))
        }
        return offsets
      })
      expect(Math.max(...selectionAnimationOffsets.slice(0, 12))).toBeGreaterThan(1)
      await expect.poll(async () => {
        return await sliceGroup.evaluate((group) => {
          const selected = group.querySelector<HTMLElement>(
            '[role="radio"][aria-checked="true"]',
          )
          const indicator = group.querySelector<HTMLElement>(
            '[data-slot="segmented-control-indicator"]',
          )
          if (!selected || !indicator) return Number.POSITIVE_INFINITY
          return Math.abs(
            selected.getBoundingClientRect().left -
              indicator.getBoundingClientRect().left,
          )
        })
      }).toBeLessThanOrEqual(1)
      await page.locator('#tour-slice-mode input[type="number"]').waitFor({
        state: 'visible',
      })

      const alignmentSamples = await page.evaluate(async () => {
        const normalOption = document.querySelector<HTMLElement>(
          '#tour-slice-mode [data-value="NORMAL"]',
        )
        const stableGroups = [
          document.querySelector<HTMLElement>(
            '[role="radiogroup"][aria-label="输出位置"]',
          ),
          document.querySelector<HTMLElement>(
            '[role="radiogroup"][aria-label="重名处理"]',
          ),
        ]
        if (!normalOption || stableGroups.some((group) => !group)) {
          throw new Error('Subtitle segmented-control fixtures are missing')
        }

        normalOption.click()
        const samples: number[][] = []
        for (let frameIndex = 0; frameIndex < 18; frameIndex++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          samples.push(stableGroups.map((group) => {
            const selected = group!.querySelector<HTMLElement>(
              '[role="radio"][aria-checked="true"]',
            )
            const indicator = group!.querySelector<HTMLElement>(
              '[data-slot="segmented-control-indicator"]',
            )
            if (!selected || !indicator) return Number.POSITIVE_INFINITY
            const selectedRect = selected.getBoundingClientRect()
            const indicatorRect = indicator.getBoundingClientRect()
            return Math.max(
              Math.abs(selectedRect.top - indicatorRect.top),
              Math.abs(selectedRect.bottom - indicatorRect.bottom),
              Math.abs(selectedRect.left - indicatorRect.left),
              Math.abs(selectedRect.right - indicatorRect.right),
            )
          }))
        }
        return samples
      })

      expect(Math.max(...alignmentSamples.flat())).toBeLessThanOrEqual(1)
      await page.locator('#tour-slice-mode input[type="number"]').waitFor({
        state: 'hidden',
      })
      await page.screenshot({
        path: path.join(
          testResultsDir,
          'segmented-control-dynamic-height-alignment.png',
        ),
        animations: 'disabled',
      })
    }, 60_000)

    test('settings radio groups use the compact SegmentedControl without clipped labels', async () => {
      await setWindowSize(mainWin, page, { width: 786, height: 540 })
      await page.evaluate(() => {
        localStorage.clear()
        localStorage.setItem('lang', 'en')
        window.location.hash = '#/setting?tab=general'
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForFusionKitLoadingToExit(page)

      const assertVisibleSegmentedControls = async (expectedCount: number) => {
        const controls = page.locator('[data-slot="segmented-control"]')
        expect(await controls.count()).toBe(expectedCount)
        for (let index = 0; index < expectedCount; index++) {
          const control = controls.nth(index)
          await expect
            .poll(() => segmentedControlUsesSharedBaseline(control))
            .toBe(true)
          const diagnostics = await readSegmentedControlDiagnostics(control)
          expect(
            await segmentedControlUsesSharedBaseline(control),
            JSON.stringify(diagnostics),
          ).toBe(true)
        }
        expect(await hasHorizontalOverflow(page)).toBe(false)
      }

      await page.getByTestId('setting-tab-general').waitFor({ state: 'visible' })
      // Theme, language and the clickable-element pointer.
      await assertVisibleSegmentedControls(3)

      await page.getByTestId('setting-tab-proxy').click()
      await page.getByRole('radiogroup', { name: 'Proxy Mode' }).waitFor({
        state: 'visible',
      })
      await assertVisibleSegmentedControls(1)

      await page.getByTestId('setting-tab-model').click()
      await page.getByRole('button', { name: 'Add Profile' }).click()
      await page.getByRole('dialog').waitFor({ state: 'visible' })
      await assertVisibleSegmentedControls(2)
      await page.screenshot({
        path: path.join(testResultsDir, 'segmented-control-settings-786x540.png'),
        animations: 'disabled',
      })
      await page.getByRole('button', { name: 'Cancel' }).click()
    }, 60_000)

    test('tool catalog lists long text translation as the only experimental tool', async () => {
      await setWindowSize(mainWin, page, { width: 1280, height: 800 })
      await page.evaluate(() => {
        localStorage.clear()
        localStorage.setItem('lang', 'en')
        window.location.hash = '#/tools'
      })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForFusionKitLoadingToExit(page)
      const experimental = page.locator('section[aria-labelledby="experimental-tools-title"]')
      await experimental.waitFor({ state: 'visible' })
      expect(await experimental.locator('[data-tool-card]').evaluateAll(
        (cards) => cards.map((card) => card.getAttribute('data-tool-card')),
      )).toEqual(['textTranslator'])
      expect(await page.locator('a[href*="/tools/audio/"]').count()).toBe(0)
      expect(await hasHorizontalOverflow(page)).toBe(false)
      expect(rendererErrors).toEqual([])
    }, 60_000)

    // test('should be home page is load correctly', async () => {
    //   const h1 = await page.$('h1')
    //   const title = await h1?.textContent()
    //   expect(title).eq('Electron + Vite + React')
    // })

    // test('should be count button can click', async () => {
    //   const countButton = await page.$('button')
    //   await countButton?.click()
    //   const countValue = await countButton?.textContent()
    //   expect(countValue).eq('count is 1')
    // })
  })
}

async function waitForFusionKitLoadingToExit(
  targetPage: Page,
  timeout = 30_000,
): Promise<void> {
  await targetPage.waitForFunction(() =>
    Boolean(document.querySelector('#root')?.firstElementChild),
  undefined, { timeout })
  await targetPage.waitForFunction(() => {
    return !document.querySelector('.app-loading-wrap') &&
      !document.querySelector('#app-loading-style')
  }, undefined, { timeout })
}

async function setWindowSize(
  targetWindow: JSHandle<BrowserWindow>,
  targetPage: Page,
  size: { width: number; height: number },
): Promise<void> {
  await targetWindow.evaluate((win, nextSize) => {
    win.setSize(nextSize.width, nextSize.height)
  }, size)
  await targetPage.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

async function hasHorizontalOverflow(targetPage: Page): Promise<boolean> {
  return await targetPage.evaluate(() =>
    document.documentElement.scrollWidth >
    document.documentElement.clientWidth + 1,
  )
}

async function scrollTestTargetIntoView(
  targetPage: Page,
  testId: string,
  block: ScrollLogicalPosition,
): Promise<void> {
  await targetPage.getByTestId(testId).evaluate((element, targetBlock) => {
    element.scrollIntoView({ block: targetBlock })
  }, block)
  await targetPage.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

async function segmentedControlUsesSharedBaseline(
  group: Locator,
): Promise<boolean> {
  return await group.evaluate((root) => {
    const items = Array.from(root.querySelectorAll<HTMLElement>('[role="radio"]'))
    if (
      root.getAttribute('data-slot') !== 'segmented-control' ||
      root.getAttribute('data-size') !== 'sm' ||
      root.getAttribute('data-variant') !== 'floating' ||
      items.length < 2 ||
      items.some((item) =>
        item.getAttribute('data-slot') !== 'segmented-control-item'
      )
    ) {
      return false
    }

    const rects = items.map((item) => item.getBoundingClientRect())
    const connected = rects.slice(1).every((rect, index) =>
      Math.abs(rect.left - rects[index].right) <= 1,
    )
    return connected &&
      root.scrollWidth <= root.clientWidth + 1 &&
      items.every((item) => {
        const label = item.querySelector<HTMLElement>(
          '[data-slot="segmented-control-label"]',
        )
        return item.scrollWidth <= item.clientWidth + 1 &&
          Boolean(label && label.scrollWidth <= label.clientWidth + 1)
      }) &&
      rects.every((rect) => Math.abs(rect.height - 28) <= 1) &&
      items.every((item) => getComputedStyle(item).fontSize === '11px') &&
      items.filter((item) => item.tabIndex === 0).length === 1 &&
      items.filter((item) => item.getAttribute('aria-checked') === 'true').length === 1 &&
      Boolean(root.querySelector('[data-slot="segmented-control-indicator"]'))
  })
}

async function readSegmentedControlDiagnostics(group: Locator) {
  return await group.evaluate((root) => ({
    root: {
      slot: root.getAttribute('data-slot'),
      size: root.getAttribute('data-size'),
      variant: root.getAttribute('data-variant'),
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
    },
    items: Array.from(root.querySelectorAll<HTMLElement>('[role="radio"]')).map(
      (item) => {
        const label = item.querySelector<HTMLElement>(
          '[data-slot="segmented-control-label"]',
        )
        return {
          value: item.getAttribute('data-value'),
          state: item.getAttribute('data-state'),
          fontSize: getComputedStyle(item).fontSize,
          itemWidth: `${item.scrollWidth}/${item.clientWidth}`,
          labelWidth: label ? `${label.scrollWidth}/${label.clientWidth}` : null,
          height: item.getBoundingClientRect().height,
        }
      },
    ),
  }))
}
