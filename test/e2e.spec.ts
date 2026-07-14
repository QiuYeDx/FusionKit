import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import {
  createMimoSpeechBody,
  createMimoStreamingSpeechEvents,
  createOpenAISpeechBuffer,
  startFakeAudioApiServer,
  type FakeAudioApiServer,
} from './audio/fakeAudioApiServer'

const root = path.join(__dirname, '..')
const testResultsDir = path.join(root, 'test-results')
let electronApp: ElectronApplication
let page: Page
let mainWin: JSHandle<BrowserWindow>
let userDataDir: string | undefined
let fakeAudioApiServer: FakeAudioApiServer | undefined
let voiceSamplePath: string | undefined
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
    fakeAudioApiServer = await startFakeAudioApiServer()
    voiceSamplePath = path.join(userDataDir, 'fe-r02-voice-sample.wav')
    await writeFile(
      voiceSamplePath,
      createOpenAISpeechBuffer('fe-r02-voice-sample'),
    )
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
      await fakeAudioApiServer?.close().catch(() => undefined)
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

    test('route-aware speech synthesis renders only usable fields and reauthorizes voice clone files', async () => {
      const server = fakeAudioApiServer
      const samplePath = voiceSamplePath
      if (!server || !samplePath) {
        throw new Error('FE-R02 E2E fixtures were not initialized')
      }

      await setWindowSize(mainWin, page, { width: 1280, height: 800 })
      await seedSpeechAudioSettings(page, 'none', server.baseUrl)
      expect(await page.getByTestId('speech-config-cta').isVisible()).toBe(true)
      expect(await page.getByTestId('speech-mode-group').count()).toBe(0)
      expect(await page.getByTestId('speech-generate').count()).toBe(0)
      await page.getByTestId('speech-config-cta').click()
      await page.waitForFunction(() =>
        window.location.hash ===
          '#/setting?tab=audio&returnTo=%2Ftools%2Faudio%2Fspeech-synthesis',
      )

      await seedSpeechAudioSettings(page, 'openai', server.baseUrl)
      expect(await page.getByTestId('speech-mode-group').count()).toBe(0)
      expect(await page.getByTestId('speech-field-voice').isVisible()).toBe(true)
      expect(
        await page.getByTestId('speech-field-instructions').isVisible(),
      ).toBe(true)
      expect(await page.getByTestId('speech-field-speed').isVisible()).toBe(true)
      expect(
        await page
          .getByTestId('speech-output-format')
          .locator('[data-slot="select-trigger"]')
          .count(),
      ).toBe(1)
      expect(
        await page.getByTestId('speech-field-style-instruction').count(),
      ).toBe(0)
      expect(
        await page.getByTestId('speech-field-voice-design-prompt').count(),
      ).toBe(0)
      expect(await page.getByTestId('speech-field-voice-sample').count()).toBe(0)
      expect(await page.getByTestId('speech-stream').count()).toBe(0)

      await page.locator('#speech-input').fill('OpenAI route input')
      expect(await page.getByTestId('speech-generate').isEnabled()).toBe(true)
      const openAiRequestCount = server.requests.length
      server.enqueueRoute('openai_speech', {
        headers: { 'Content-Type': 'audio/mpeg' },
        rawBody: Buffer.concat([
          Buffer.from('ID3', 'ascii'),
          Buffer.from('fe-r02-openai-result', 'utf8'),
        ]),
      })
      await page.getByTestId('speech-generate').click()
      await waitForFakeAudioRequestCount(server, openAiRequestCount + 1)
      await waitForSpeechGenerateReady(page)
      expect(server.requests[openAiRequestCount]).toMatchObject({
        route: 'openai_speech',
        body: {
          model: 'gpt-4o-mini-tts',
          input: 'OpenAI route input',
          voice: 'alloy',
        },
      })

      await seedSpeechAudioSettings(page, 'mimo', server.baseUrl)
      await page.getByTestId('speech-mode-group').waitFor({ state: 'visible' })
      expect(await page.getByTestId('speech-field-voice').isVisible()).toBe(true)
      expect(
        await page.getByTestId('speech-field-style-instruction').isVisible(),
      ).toBe(true)
      expect(
        await page.getByTestId('speech-field-voice-design-prompt').count(),
      ).toBe(0)
      expect(await page.getByTestId('speech-field-voice-sample').count()).toBe(0)
      expect(await page.getByTestId('speech-field-instructions').count()).toBe(0)
      expect(await page.getByTestId('speech-field-speed').count()).toBe(0)
      expect(await page.getByTestId('speech-stream').isVisible()).toBe(true)
      expect(
        await page
          .getByTestId('speech-output-format')
          .locator('[data-slot="select-trigger"]')
          .count(),
      ).toBe(0)

      await page.locator('#speech-input').fill('Preset draft')
      await page.getByTestId('speech-mode-voice_design').click()
      await page.waitForFunction(() =>
        document.activeElement?.id === 'speech-voice-design-prompt',
      )
      expect(await page.getByTestId('speech-field-voice').count()).toBe(0)
      expect(
        await page.getByTestId('speech-field-style-instruction').count(),
      ).toBe(0)
      expect(
        await page.getByTestId('speech-field-voice-design-prompt').isVisible(),
      ).toBe(true)
      expect(await page.getByTestId('speech-field-voice-sample').count()).toBe(0)
      expect(await page.locator('#speech-input').inputValue()).toBe('')
      await page.locator('#speech-input').fill('Design draft')
      await page.locator('#speech-voice-design-prompt').fill('Bright, clear voice')

      await page.getByTestId('speech-mode-voice_design').focus()
      await page.keyboard.press('ArrowRight')
      await page.waitForFunction(() =>
        document.activeElement?.getAttribute('data-testid') ===
          'speech-mode-voice_clone',
      )
      expect(
        await page.getByTestId('speech-mode-voice_clone').getAttribute('tabindex'),
      ).toBe('0')
      expect(await page.getByTestId('speech-field-voice').count()).toBe(0)
      expect(
        await page.getByTestId('speech-field-style-instruction').isVisible(),
      ).toBe(true)
      expect(
        await page.getByTestId('speech-field-voice-design-prompt').count(),
      ).toBe(0)
      expect(
        await page.getByTestId('speech-field-voice-sample').isVisible(),
      ).toBe(true)
      await page.locator('#speech-input').fill('Clone draft')

      await page
        .getByTestId('speech-voice-sample-input')
        .setInputFiles(samplePath)
      await page
        .getByTestId('speech-voice-sample-selected')
        .waitFor({ state: 'visible' })
      expect(await page.getByTestId('speech-generate').isEnabled()).toBe(true)
      const persistedSpeechState = await page.evaluate(
        () => localStorage.getItem('fusionkit-speech-synthesizer') ?? '',
      )
      expect(persistedSpeechState).not.toContain('fe-r02-voice-sample.wav')
      expect(persistedSpeechState).not.toContain('fileToken')
      expect(persistedSpeechState).not.toContain('filePath')

      const cloneResponseBody = createMimoSpeechBody({
        audioBase64: createOpenAISpeechBuffer('fe-r02-clone-result').toString(
          'base64',
        ),
        model: 'mimo-v2.5-tts-voiceclone',
      })
      const requestCountBefore = server.requests.length

      server.enqueueRoute('mimo_chat_completions', { body: cloneResponseBody })
      await page.getByTestId('speech-generate').evaluate((button) => {
        const generate = button as HTMLButtonElement
        generate.click()
        generate.click()
      })
      await waitForFakeAudioRequestCount(server, requestCountBefore + 1)
      await waitForSpeechGenerateReady(page)
      await page.waitForTimeout(100)
      expect(server.requests).toHaveLength(requestCountBefore + 1)
      expect(
        await page.getByTestId('speech-voice-sample-selected').isVisible(),
      ).toBe(true)

      await setSpeechStreaming(page, true)
      server.enqueueRoute('mimo_chat_completions', {
        sseEvents: createMimoStreamingSpeechEvents({
          audioBase64Chunks: [Buffer.from([0, 0, 1, 0]).toString('base64')],
          model: 'mimo-v2.5-tts-voiceclone',
        }),
      })
      await page.getByTestId('speech-generate').click()
      await waitForFakeAudioRequestCount(server, requestCountBefore + 2)
      await waitForSpeechGenerateReady(page)
      await page.getByTestId('speech-field-voice-sample').evaluate((element) => {
        element.scrollIntoView({ block: 'center' })
      })
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }))
      expect(await speechVoiceSampleDropZoneFits(page)).toBe(true)
      await page.screenshot({
        path: path.join(testResultsDir, 'fe-r02-speech-clone-1280x800.png'),
        animations: 'disabled',
      })

      const modeCases = [
        { mode: 'preset_voice', model: 'mimo-v2.5-tts' },
        { mode: 'voice_design', model: 'mimo-v2.5-tts-voicedesign' },
      ] as const
      let expectedRequestCount = requestCountBefore + 2
      for (const modeCase of modeCases) {
        await page.getByTestId(`speech-mode-${modeCase.mode}`).click()
        await setSpeechStreaming(page, false)
        server.enqueueRoute('mimo_chat_completions', {
          body: createMimoSpeechBody({
            audioBase64: createOpenAISpeechBuffer(
              `fe-r02-${modeCase.mode}-result`,
            ).toString('base64'),
            model: modeCase.model,
          }),
        })
        await page.getByTestId('speech-generate').click()
        expectedRequestCount += 1
        await waitForFakeAudioRequestCount(server, expectedRequestCount)
        await waitForSpeechGenerateReady(page)

        await setSpeechStreaming(page, true)
        server.enqueueRoute('mimo_chat_completions', {
          sseEvents: createMimoStreamingSpeechEvents({
            audioBase64Chunks: [Buffer.from([0, 0, 2, 0]).toString('base64')],
            model: modeCase.model,
          }),
        })
        await page.getByTestId('speech-generate').click()
        expectedRequestCount += 1
        await waitForFakeAudioRequestCount(server, expectedRequestCount)
        await waitForSpeechGenerateReady(page)
      }

      expect(
        server.requests
          .slice(requestCountBefore)
          .map((request) => ({
            route: request.route,
            model: request.body?.model,
            stream: request.body?.stream === true,
          })),
      ).toEqual([
        {
          route: 'mimo_chat_completions',
          model: 'mimo-v2.5-tts-voiceclone',
          stream: false,
        },
        {
          route: 'mimo_chat_completions',
          model: 'mimo-v2.5-tts-voiceclone',
          stream: true,
        },
        {
          route: 'mimo_chat_completions',
          model: 'mimo-v2.5-tts',
          stream: false,
        },
        {
          route: 'mimo_chat_completions',
          model: 'mimo-v2.5-tts',
          stream: true,
        },
        {
          route: 'mimo_chat_completions',
          model: 'mimo-v2.5-tts-voicedesign',
          stream: false,
        },
        {
          route: 'mimo_chat_completions',
          model: 'mimo-v2.5-tts-voicedesign',
          stream: true,
        },
      ])

      await setSpeechStreaming(page, false)

      expect(
        server.requests
          .slice(requestCountBefore)
          .every((request) => request.route === 'mimo_chat_completions'),
      ).toBe(true)

      await page.getByTestId('speech-mode-preset_voice').click()
      expect(await page.locator('#speech-input').inputValue()).toBe('Preset draft')
      await page.getByTestId('speech-mode-voice_design').click()
      expect(await page.locator('#speech-input').inputValue()).toBe('Design draft')

      await page.waitForFunction(
        () => !document.querySelector('[data-sonner-toast]'),
        undefined,
        { timeout: 15_000 },
      )

      await setWindowSize(mainWin, page, { width: 1280, height: 800 })
      await page.evaluate(() => window.scrollTo(0, 0))
      const wideLayout = await readSpeechLayout(page)
      expect(wideLayout.hasHorizontalOverflow).toBe(false)
      expect(wideLayout.asideRight).toBeLessThanOrEqual(wideLayout.mainLeft + 1)
      await page.screenshot({
        path: path.join(testResultsDir, 'fe-r02-speech-1280x800.png'),
        animations: 'disabled',
      })

      await setWindowSize(mainWin, page, { width: 786, height: 540 })
      await page.getByTestId('speech-mode-group').evaluate((element) => {
        element.scrollIntoView({ block: 'center' })
      })
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }))
      const narrowLayout = await readSpeechLayout(page)
      expect(narrowLayout.hasHorizontalOverflow).toBe(false)
      expect(narrowLayout.mainTop).toBeGreaterThanOrEqual(
        narrowLayout.asideBottom - 1,
      )
      expect(await speechModeButtonsFit(page)).toBe(true)
      await page.screenshot({
        path: path.join(testResultsDir, 'fe-r02-speech-786x540.png'),
        animations: 'disabled',
      })
      await page.getByText('Generated result', { exact: true }).evaluate(
        (element) => {
          element.scrollIntoView({ block: 'start' })
        },
      )
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }))
      await page.screenshot({
        path: path.join(testResultsDir, 'fe-r02-speech-workspace-786x540.png'),
        animations: 'disabled',
      })

      expect(await page.locator('body').innerText()).not.toMatch(
        /\baudio:[a-z0-9_.-]+/i,
      )
      await page.getByTestId('speech-mode-voice_clone').click()
      await page.getByTestId('speech-voice-sample-clear').click()
      expect(await page.getByTestId('speech-voice-sample-selected').count()).toBe(0)

      await seedSpeechAudioSettings(
        page,
        'mimo_two_routes',
        server.baseUrl,
        'voice_clone',
      )
      await page.getByTestId('speech-mode-fallback-notice').waitFor({
        state: 'visible',
      })
      expect(await page.getByTestId('speech-mode-preset_voice').count()).toBe(1)
      expect(await page.getByTestId('speech-mode-voice_design').count()).toBe(1)
      expect(await page.getByTestId('speech-mode-voice_clone').count()).toBe(0)
      expect(rendererErrors).toEqual([])
    }, 180_000)

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
              bodyText: document.body.innerText,
              bodyTextLength: document.body.innerText.trim().length,
              hasHorizontalOverflow:
                document.documentElement.scrollWidth >
                document.documentElement.clientWidth + 1,
            }))
            expect(pageState.bodyTextLength).toBeGreaterThan(100)
            expect(pageState.hasHorizontalOverflow).toBe(false)
            expect(pageState.bodyText).not.toMatch(/\baudio:[a-z0-9_.-]+/i)
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

type SpeechAudioSeed = 'none' | 'openai' | 'mimo' | 'mimo_two_routes'

async function seedSpeechAudioSettings(
  targetPage: Page,
  seed: SpeechAudioSeed,
  baseUrl: string,
  preferredMode?: 'preset_voice' | 'voice_design' | 'voice_clone',
): Promise<void> {
  await targetPage.evaluate(({ nextSeed, nextBaseUrl, nextPreferredMode }) => {
    localStorage.clear()
    localStorage.setItem('lang', 'en')
    if (nextPreferredMode) {
      localStorage.setItem(
        'fusionkit-speech-synthesizer',
        JSON.stringify({
          version: 5,
          state: {
            preferences: {
              speechMode: nextPreferredMode,
              input: 'Fallback draft',
              modeInputDrafts: { [nextPreferredMode]: 'Fallback draft' },
            },
          },
        }),
      )
    }
    if (nextSeed !== 'none') {
      const profileId = `fe_r02_${nextSeed}`
      const speechSynthesis = nextSeed === 'openai'
        ? {
            preset_voice: {
              transport: 'openai_audio',
              model: 'gpt-4o-mini-tts',
              enabled: true,
            },
          }
        : {
            preset_voice: {
              transport: 'mimo_chat_audio',
              model: 'mimo-v2.5-tts',
              enabled: true,
            },
            voice_design: {
              transport: 'mimo_chat_audio',
              model: 'mimo-v2.5-tts-voicedesign',
              enabled: true,
            },
            ...(nextSeed === 'mimo_two_routes'
              ? {}
              : {
                  voice_clone: {
                    transport: 'mimo_chat_audio',
                    model: 'mimo-v2.5-tts-voiceclone',
                    enabled: true,
                  },
                }),
          }
      localStorage.setItem(
        'fusionkit-audio-settings',
        JSON.stringify({
          version: 1,
          state: {
            profiles: [
              {
                id: profileId,
                name: nextSeed === 'openai'
                  ? 'FE-R02 OpenAI audio'
                  : 'FE-R02 MiMo audio',
                providerPreset: nextSeed === 'mimo_two_routes'
                  ? 'mimo'
                  : nextSeed,
                baseUrl: nextBaseUrl,
                apiKey: 'fe-r02-e2e-key',
                routes: { speechSynthesis },
              },
            ],
            assignment: {
              transcription: null,
              speechSynthesis: profileId,
              realtimeCaptions: null,
              realtimeVoice: null,
            },
            migration: {
              legacyModelStore: { status: 'not_needed' },
            },
          },
        }),
      )
    }
    window.location.hash = '#/tools/audio/speech-synthesis'
  }, {
    nextSeed: seed,
    nextBaseUrl: baseUrl,
    nextPreferredMode: preferredMode,
  })
  await targetPage.reload({ waitUntil: 'domcontentloaded' })
  await waitForFusionKitLoadingToExit(targetPage)
  await targetPage
    .getByTestId('speech-synthesizer')
    .waitFor({ state: 'visible' })
}

async function waitForFakeAudioRequestCount(
  server: FakeAudioApiServer,
  expectedCount: number,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (server.requests.length >= expectedCount) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(
    `Timed out waiting for ${expectedCount} fake audio API requests; received ${server.requests.length}.`,
  )
}

async function waitForSpeechGenerateReady(targetPage: Page): Promise<void> {
  await targetPage.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-testid="speech-generate"]',
    )
    return Boolean(
      button &&
      !button.disabled &&
      (document.body.innerText.includes('Generated result') ||
        document.querySelector('[role="alert"]')),
    )
  })
  const bodyText = await targetPage.locator('body').innerText()
  if (!bodyText.includes('Generated result')) {
    throw new Error(`Speech generation failed:\n${bodyText}`)
  }
}

async function setSpeechStreaming(
  targetPage: Page,
  enabled: boolean,
): Promise<void> {
  const streamSwitch = targetPage
    .getByTestId('speech-stream')
    .getByRole('switch')
  const current = await streamSwitch.getAttribute('aria-checked')
  if ((current === 'true') !== enabled) {
    await streamSwitch.click()
  }
  await expect.poll(async () =>
    (await streamSwitch.getAttribute('aria-checked')) === 'true',
  ).toBe(enabled)
}

interface SpeechLayoutSnapshot {
  asideRight: number
  asideBottom: number
  mainLeft: number
  mainTop: number
  hasHorizontalOverflow: boolean
}

async function readSpeechLayout(targetPage: Page): Promise<SpeechLayoutSnapshot> {
  return await targetPage.getByTestId('speech-synthesizer').evaluate((root) => {
    const aside = root.querySelector('aside')
    const main = root.querySelector('main')
    if (!aside || !main) throw new Error('Speech layout columns are missing')
    const asideRect = aside.getBoundingClientRect()
    const mainRect = main.getBoundingClientRect()
    return {
      asideRight: asideRect.right,
      asideBottom: asideRect.bottom,
      mainLeft: mainRect.left,
      mainTop: mainRect.top,
      hasHorizontalOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
    }
  })
}

async function speechModeButtonsFit(targetPage: Page): Promise<boolean> {
  return await targetPage.getByTestId('speech-mode-group').evaluate((group) => {
    const groupRect = group.getBoundingClientRect()
    const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>(
      '[role="radio"]',
    ))
    return (
      groupRect.left >= -1 &&
      groupRect.right <= window.innerWidth + 1 &&
      buttons.length === 3 &&
      buttons.every((button) => {
        const rect = button.getBoundingClientRect()
        return (
          rect.left >= groupRect.left - 1 &&
          rect.right <= groupRect.right + 1 &&
          button.scrollWidth <= button.clientWidth + 1
        )
      })
    )
  })
}

async function speechVoiceSampleDropZoneFits(
  targetPage: Page,
): Promise<boolean> {
  return await targetPage.locator('#speech-voice-sample').evaluate((dropZone) => {
    const aside = dropZone.closest('aside')
    const action = dropZone.querySelector<HTMLButtonElement>('button')
    if (!aside || !action) return false
    const asideRect = aside.getBoundingClientRect()
    const dropZoneRect = dropZone.getBoundingClientRect()
    const actionRect = action.getBoundingClientRect()
    return (
      dropZoneRect.left >= asideRect.left - 1 &&
      dropZoneRect.right <= asideRect.right + 1 &&
      actionRect.left >= dropZoneRect.left - 1 &&
      actionRect.right <= dropZoneRect.right + 1 &&
      action.scrollWidth <= action.clientWidth + 1
    )
  })
}
