import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
const testResultsDir = path.join(root, 'test-results')
let electronApp: ElectronApplication
let page: Page
let mainWin: JSHandle<BrowserWindow>
let userDataDir: string | undefined
const rendererErrors: string[] = []
const audioPageTitles: Record<string, Record<string, string>> = {
  zh: {
    '/tools/audio/transcriber': '音频转文本',
    '/tools/audio/speech-synthesis': '文本转音频',
    '/tools/audio/realtime-captions': '实时字幕',
    '/tools/audio/realtime-voice': '双向语音',
  },
  'zh-Hant': {
    '/tools/audio/transcriber': '音訊轉文字',
    '/tools/audio/speech-synthesis': '文字轉音訊',
    '/tools/audio/realtime-captions': '即時字幕',
    '/tools/audio/realtime-voice': '雙向語音',
  },
  en: {
    '/tools/audio/transcriber': 'Audio to text',
    '/tools/audio/speech-synthesis': 'Text to audio',
    '/tools/audio/realtime-captions': 'Realtime captions',
    '/tools/audio/realtime-voice': 'Duplex voice',
  },
  ja: {
    '/tools/audio/transcriber': '音声をテキストへ',
    '/tools/audio/speech-synthesis': 'テキストを音声へ',
    '/tools/audio/realtime-captions': 'リアルタイム字幕',
    '/tools/audio/realtime-voice': '双方向音声',
  },
}
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
    page.on('pageerror', (error) => rendererErrors.push(error.message))
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
    })

    test('standalone audio settings support first MiMo setup, assignment undo, reassignment, and returnTo', async () => {
      const returnTo = '/tools/audio/speech-synthesis'
      const settingsHash = `#/setting?tab=audio&returnTo=${encodeURIComponent(returnTo)}`
      const profileName = 'FE-R01 MiMo E2E'

      await setWindowSize(mainWin, page, { width: 1280, height: 800 })
      await page.waitForLoadState('domcontentloaded')
      await page.evaluate((nextHash) => {
        localStorage.clear()
        localStorage.setItem('lang', 'en')
        window.location.hash = nextHash
      }, settingsHash)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForFusionKitLoadingToExit(page)
      await page.getByTestId('audio-api-settings').waitFor({ state: 'visible' })

      expect(await page.evaluate(() => {
        const [pathname, query = ''] = window.location.hash.slice(1).split('?')
        const search = new URLSearchParams(query)
        return {
          pathname,
          tab: search.get('tab'),
          returnTo: search.get('returnTo'),
        }
      })).toEqual({ pathname: '/setting', tab: 'audio', returnTo })
      expect(await readPersistedTextProfileCount(page)).toBe(0)
      expect(await page.getByTestId('setting-tab-audio').isVisible()).toBe(true)
      expect(await page.getByTestId('audio-api-add').isEnabled()).toBe(true)
      expect(await hasHorizontalOverflow(page)).toBe(false)

      await page.getByTestId('audio-api-add').click()
      await page.getByRole('dialog').waitFor({ state: 'visible' })
      await page.getByTestId('audio-provider-mimo').click()
      await page.getByTestId('audio-api-name').fill(profileName)
      await page.getByTestId('audio-api-base-url').fill(
        'https://api.xiaomimimo.com/v1',
      )
      await page.getByTestId('audio-api-key').fill('e2e-placeholder-key')
      await page.getByTestId('audio-api-save').click()

      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      await page.getByTestId('audio-auto-assignment').waitFor({ state: 'visible' })
      const autoAssignmentText = await page
        .getByTestId('audio-auto-assignment')
        .textContent()
      expect(autoAssignmentText).toContain('Audio to text')
      expect(autoAssignmentText).toContain('Text to audio')
      expect(autoAssignmentText).toContain('Realtime captions')
      expect(autoAssignmentText).not.toContain('Duplex voice')
      await waitForAudioSettings(page, (state) => {
        const profileId = state.profiles[0]?.id
        return Boolean(
          profileId &&
          state.profiles.length === 1 &&
          state.assignment.transcription === profileId &&
          state.assignment.speechSynthesis === profileId &&
          state.assignment.realtimeCaptions === profileId &&
          state.assignment.realtimeVoice === null,
        )
      })

      const created = await readPersistedAudioSettings(page)
      expect(created).not.toBeNull()
      expect(created?.profiles).toHaveLength(1)
      expect(created?.profiles[0]).toEqual({
        id: created?.profiles[0].id,
        name: profileName,
        providerPreset: 'mimo',
        speechModes: ['preset_voice', 'voice_clone', 'voice_design'],
      })
      expect(created?.assignment).toEqual({
        transcription: created?.profiles[0].id,
        speechSynthesis: created?.profiles[0].id,
        realtimeCaptions: created?.profiles[0].id,
        realtimeVoice: null,
      })

      for (const key of [
        'transcription',
        'speechSynthesis',
        'realtimeCaptions',
      ]) {
        const text = await page.getByTestId(`audio-assignment-${key}`).textContent()
        expect(text).toContain(profileName)
      }
      expect(
        await page.getByTestId('audio-assignment-realtimeVoice').textContent(),
      ).not.toContain(profileName)

      await page.screenshot({
        path: path.join(testResultsDir, 'fe-r01-audio-settings-1280x800.png'),
        animations: 'disabled',
      })

      await page.getByTestId('audio-auto-assignment-undo').click()
      await waitForAudioSettings(page, (state) =>
        state.assignment.transcription === null &&
        state.assignment.speechSynthesis === null &&
        state.assignment.realtimeCaptions === null &&
        state.assignment.realtimeVoice === null,
      )

      await page.getByTestId('audio-assignment-speechSynthesis').click()
      await page.getByRole('option', { name: new RegExp(profileName) }).click()
      await waitForAudioSettings(page, (state) => {
        const profileId = state.profiles[0]?.id
        return Boolean(
          profileId &&
          state.assignment.transcription === null &&
          state.assignment.speechSynthesis === profileId &&
          state.assignment.realtimeCaptions === null &&
          state.assignment.realtimeVoice === null,
        )
      })

      await setWindowSize(mainWin, page, { width: 786, height: 540 })
      await page.getByTestId('audio-api-edit').first().click()
      const editDialog = page.getByRole('dialog')
      await editDialog.waitFor({ state: 'visible' })
      await page.getByTestId('audio-api-save').waitFor({ state: 'visible' })
      await page.waitForTimeout(250)

      const narrowDialogState = await editDialog.evaluate((dialog) => {
        const dialogRect = dialog.getBoundingClientRect()
        const scrollViewport = dialog.querySelector<HTMLElement>(
          '[data-slot="scroll-area-viewport"]',
        )
        const saveButton = dialog.querySelector<HTMLElement>(
          '[data-testid="audio-api-save"]',
        )
        const saveRect = saveButton?.getBoundingClientRect()
        const saveHitTarget = saveRect
          ? document.elementFromPoint(
              saveRect.left + saveRect.width / 2,
              saveRect.top + saveRect.height / 2,
            )
          : null

        return {
          dialogWithinViewport:
            dialogRect.left >= -1 &&
            dialogRect.top >= -1 &&
            dialogRect.right <= window.innerWidth + 1 &&
            dialogRect.bottom <= window.innerHeight + 1,
          hasScrollableContent: Boolean(
            scrollViewport &&
            scrollViewport.scrollHeight > scrollViewport.clientHeight + 1,
          ),
          saveButtonVisible: Boolean(
            saveRect &&
            saveRect.width > 0 &&
            saveRect.height > 0 &&
            saveRect.top >= 0 &&
            saveRect.bottom <= window.innerHeight + 1,
          ),
          saveButtonReachable: Boolean(
            saveButton &&
            saveHitTarget &&
            saveButton.contains(saveHitTarget),
          ),
          scrollViewportHasHorizontalOverflow: Boolean(
            scrollViewport &&
            scrollViewport.scrollWidth > scrollViewport.clientWidth + 1,
          ),
          hasHorizontalOverflow:
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth + 1,
        }
      })
      expect(narrowDialogState).toEqual({
        dialogWithinViewport: true,
        hasScrollableContent: true,
        saveButtonVisible: true,
        saveButtonReachable: true,
        scrollViewportHasHorizontalOverflow: false,
        hasHorizontalOverflow: false,
      })

      await page.screenshot({
        path: path.join(testResultsDir, 'fe-r01-audio-dialog-786x540.png'),
        animations: 'disabled',
      })
      await page.keyboard.press('Escape')
      await editDialog.waitFor({ state: 'hidden' })

      await page.getByTestId('audio-api-edit').first().click()
      await editDialog.waitFor({ state: 'visible' })
      await page.getByTestId('audio-provider-custom_openai_compatible').click()
      expect(await page.getByTestId('audio-api-key').inputValue()).toBe('')
      await page.getByTestId('audio-api-base-url').fill(
        'https://audio.example.test/v1',
      )
      await page.getByTestId('audio-api-key').fill('custom-e2e-placeholder-key')
      await page.locator('#audio-route-transcription').click()
      await page.locator('#audio-route-model-transcription').fill('whisper-1')
      await page.getByTestId('audio-api-save-return').click()

      await page.waitForFunction(
        (nextRoute) => window.location.hash === `#${nextRoute}`,
        returnTo,
      )
      await waitForFusionKitLoadingToExit(page)
      await page.getByRole('heading', {
        level: 1,
        name: audioPageTitles.en[returnTo],
        exact: true,
      }).waitFor({ state: 'visible' })
      const clearedAssignmentToast = page
        .locator('[data-sonner-toast]')
        .filter({
          hasText:
            'Assignments that no longer match the updated routes were cleared',
        })
      await clearedAssignmentToast.waitFor({ state: 'visible' })
      expect(await clearedAssignmentToast.textContent()).toContain('Text to audio')

      const updated = await readPersistedAudioSettings(page)
      expect(updated?.profiles[0]?.providerPreset).toBe(
        'custom_openai_compatible',
      )
      expect(updated?.assignment).toEqual({
        transcription: null,
        speechSynthesis: null,
        realtimeCaptions: null,
        realtimeVoice: null,
      })
      expect(rendererErrors).toEqual([])
    }, 120_000)

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
            const targetTitle = audioPageTitles[language]?.[route]
            expect(targetTitle).toBeTruthy()
            await page.getByRole('heading', {
              level: 1,
              name: targetTitle,
              exact: true,
            }).waitFor({ state: 'visible' })
            expect(await page.locator('h1').count()).toBe(1)

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
  await targetPage.waitForFunction(() =>
    Boolean(document.querySelector('#root')?.firstElementChild),
  )
  await targetPage.waitForFunction(() => {
    return !document.querySelector('.app-loading-wrap') &&
      !document.querySelector('#app-loading-style')
  })
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

async function readPersistedTextProfileCount(targetPage: Page): Promise<number> {
  return await targetPage.evaluate(() => {
    const raw = localStorage.getItem('fusionkit-model')
    if (!raw) return 0
    try {
      const envelope = JSON.parse(raw) as { state?: { profiles?: unknown[] } }
      return Array.isArray(envelope.state?.profiles)
        ? envelope.state.profiles.length
        : 0
    } catch {
      return -1
    }
  })
}

interface PersistedAudioSettingsSnapshot {
  profiles: Array<{
    id: string
    name: string
    providerPreset: string
    speechModes: string[]
  }>
  assignment: Record<string, unknown>
}

async function readPersistedAudioSettings(
  targetPage: Page,
): Promise<PersistedAudioSettingsSnapshot | null> {
  return await targetPage.evaluate(() => {
    const raw = localStorage.getItem('fusionkit-audio-settings')
    if (!raw) return null
    try {
      const envelope = JSON.parse(raw) as {
        state?: {
          profiles?: Array<{
            id?: unknown
            name?: unknown
            providerPreset?: unknown
            routes?: { speechSynthesis?: Record<string, unknown> }
          }>
          assignment?: Record<string, unknown>
        }
      }
      const profiles = Array.isArray(envelope.state?.profiles)
        ? envelope.state.profiles.map((profile) => ({
            id: String(profile.id ?? ''),
            name: String(profile.name ?? ''),
            providerPreset: String(profile.providerPreset ?? ''),
            speechModes: Object.keys(profile.routes?.speechSynthesis ?? {}).sort(),
          }))
        : []
      const assignment = { ...envelope.state?.assignment }
      return { profiles, assignment }
    } catch {
      return null
    }
  })
}

async function waitForAudioSettings(
  targetPage: Page,
  predicate: (state: PersistedAudioSettingsSnapshot) => boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const state = await readPersistedAudioSettings(targetPage)
    if (state && predicate(state)) return
    await targetPage.waitForTimeout(50)
  }
  throw new Error('Timed out waiting for persisted audio settings state.')
}
