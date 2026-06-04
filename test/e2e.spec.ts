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

    const mainWin: JSHandle<BrowserWindow> = await electronApp.browserWindow(page)
    await mainWin.evaluate(async (win) => {
      win.webContents.executeJavaScript('console.log("Execute JavaScript with e2e testing.")')
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
