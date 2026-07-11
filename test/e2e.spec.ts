import path from 'node:path'
import {
  type ElectronApplication,
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
let electronApp: ElectronApplication
let page: Page
let mainWin: JSHandle<BrowserWindow>
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
    electronApp = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: root,
      env: { ...process.env, NODE_ENV: 'development' },
    })
    page = await electronApp.firstWindow()

    mainWin = await electronApp.browserWindow(page)
    await mainWin.evaluate(async (win) => {
      win.webContents.executeJavaScript('console.log("Execute JavaScript with e2e testing.")')
    })
    page.on('pageerror', (error) => rendererErrors.push(error.message))
    page.on('console', (message) => {
      if (
        message.type() === 'error' &&
        /getSnapshot|Maximum update depth|uncaught error/i.test(message.text())
      ) {
        rendererErrors.push(message.text())
      }
    })
  })

  afterAll(async () => {
    if (page) {
      await page.screenshot({ path: 'test/screenshots/e2e.png' })
      await page.close()
    }
    if (electronApp) {
      await electronApp.close()
    }
  })

  describe('[electron-vite-react] e2e tests', async () => {
    test('startup', async () => {
      const title = await page.title()
      expect(title).eq('FusionKit')
    })

    test('audio pages render across languages and window sizes without white-screen regressions', async () => {
      const routes = [
        '/tools/audio/transcriber',
        '/tools/audio/speech-synthesis',
        '/tools/audio/realtime-captions',
        '/tools/audio/realtime-voice',
      ]
      const languages = ['zh', 'zh-Hant', 'en', 'ja']
      const windowSizes = [
        { width: 1280, height: 800 },
        { width: 786, height: 540 },
      ]

      for (const language of languages) {
        await page.evaluate((value) => localStorage.setItem('lang', value), language)
        await page.reload()
        await waitForFusionKitLoadingToExit(page)

        for (const size of windowSizes) {
          await mainWin.evaluate((win, nextSize) => {
            win.setSize(nextSize.width, nextSize.height)
          }, size)

          for (const route of routes) {
            await page.evaluate((nextRoute) => {
              window.location.hash = `#${nextRoute}`
            }, route)
            await page.waitForFunction(
              (nextRoute) => window.location.hash === `#${nextRoute}`,
              route,
            )
            await waitForFusionKitLoadingToExit(page)
            await page.locator('h1').waitFor({ state: 'visible' })

            const pageState = await page.evaluate(() => ({
              bodyTextLength: document.body.innerText.trim().length,
              hasHorizontalOverflow:
                document.documentElement.scrollWidth >
                document.documentElement.clientWidth + 1,
            }))
            expect(pageState.bodyTextLength).toBeGreaterThan(100)
            expect(pageState.hasHorizontalOverflow).toBe(false)
          }
        }
      }

      expect(rendererErrors).toEqual([])
    }, 120_000)

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

async function waitForFusionKitLoadingToExit(targetPage: Page): Promise<void> {
  await targetPage.waitForFunction(() => {
    return !document.querySelector('.app-loading-wrap') &&
      !document.querySelector('#app-loading-style')
  })
}
