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
  createOpenAIRealtimeClientSecretBody,
  createOpenAITranscriptionBody,
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

    test('route-aware audio transcription renders usable fields and reauthorizes consumed input files', async () => {
      const server = fakeAudioApiServer
      const samplePath = voiceSamplePath
      if (!server || !samplePath) {
        throw new Error('FE-R03 E2E fixtures were not initialized')
      }

      await setWindowSize(mainWin, page, { width: 1280, height: 800 })
      await seedTranscriberAudioSettings(page, 'none', server.baseUrl)
      expect(
        await page.getByTestId('transcriber-config-cta').isVisible(),
      ).toBe(true)
      expect(await page.getByTestId('transcriber-file-input').count()).toBe(0)
      expect(await page.getByTestId('transcriber-start').count()).toBe(0)
      expect(await hasHorizontalOverflow(page)).toBe(false)
      await page.getByTestId('transcriber-config-cta').click()
      await page.waitForFunction(() =>
        window.location.hash ===
          '#/setting?tab=audio&returnTo=%2Ftools%2Faudio%2Ftranscriber',
      )

      await seedTranscriberAudioSettings(page, 'openai_gpt', server.baseUrl)
      expect(
        await page.getByTestId('transcriber-field-prompt').isVisible(),
      ).toBe(true)
      expect(await page.getByTestId('transcriber-stream').isVisible()).toBe(true)
      expect(await page.getByTestId('transcriber-field-timestamps').count()).toBe(0)
      expect(
        await page
          .getByTestId('transcriber-output-format')
          .locator('[data-slot="select-trigger"]')
          .count(),
      ).toBe(0)
      const gptFormatSummary = page.getByTestId(
        'transcriber-output-format-summary',
      )
      expect(await gptFormatSummary.count()).toBe(1)
      expect((await gptFormatSummary.textContent())?.trim()).toBe('JSON')
      expect(
        await page
          .getByTestId('audio-transcriber')
          .getByText('Generation mode', { exact: true })
          .count(),
      ).toBe(0)

      await seedTranscriberAudioSettings(page, 'openai_whisper', server.baseUrl)
      expect(await page.getByTestId('transcriber-stream').count()).toBe(0)
      expect(
        await page
          .getByTestId('transcriber-output-format')
          .locator('[data-slot="select-trigger"]')
          .count(),
      ).toBe(1)
      expect(await page.getByTestId('transcriber-field-timestamps').count()).toBe(0)
      await page.locator('#transcriber-response-format').click()
      await page.getByRole('option', {
        name: 'Verbose JSON',
        exact: true,
      }).click()
      await page.getByTestId('transcriber-field-timestamps').waitFor({
        state: 'visible',
      })

      await seedTranscriberAudioSettings(page, 'mimo', server.baseUrl)
      expect(await page.getByTestId('transcriber-field-prompt').count()).toBe(0)
      expect(await page.getByTestId('transcriber-field-timestamps').count()).toBe(0)
      expect(await page.getByTestId('transcriber-stream').isVisible()).toBe(true)
      const mimoFormatSelect = page.locator('#transcriber-response-format')
      expect(await mimoFormatSelect.isVisible()).toBe(true)
      await mimoFormatSelect.click()
      expect(
        (await page.getByRole('option').allTextContents()).map((value) =>
          value.trim(),
        ),
      ).toEqual(['JSON', 'Plain text'])
      await page.keyboard.press('Escape')

      await seedTranscriberAudioSettings(page, 'openai_gpt', server.baseUrl)
      const displayOnlyMode = page.getByTestId(
        'transcriber-output-mode-display_only',
      )
      const sourceDirectoryMode = page.getByTestId(
        'transcriber-output-mode-source_dir',
      )
      const customDirectoryMode = page.getByTestId(
        'transcriber-output-mode-custom_dir',
      )
      await displayOnlyMode.click()
      await displayOnlyMode.focus()
      expect(
        await Promise.all([
          displayOnlyMode.getAttribute('tabindex'),
          sourceDirectoryMode.getAttribute('tabindex'),
          customDirectoryMode.getAttribute('tabindex'),
        ]),
      ).toEqual(['0', '-1', '-1'])
      await page.keyboard.press('ArrowRight')
      expect(await sourceDirectoryMode.getAttribute('data-state')).toBe('checked')
      expect(await sourceDirectoryMode.evaluate((element) =>
        document.activeElement === element,
      )).toBe(true)
      await page.keyboard.press('End')
      expect(await customDirectoryMode.getAttribute('data-state')).toBe('checked')
      await page.keyboard.press('Home')
      expect(await displayOnlyMode.getAttribute('data-state')).toBe('checked')
      expect(await displayOnlyMode.evaluate((element) =>
        document.activeElement === element,
      )).toBe(true)

      await page
        .getByTestId('transcriber-file-input')
        .setInputFiles(samplePath)
      await page.getByTestId('transcriber-file-selected').waitFor({
        state: 'visible',
      })
      expect(await page.getByTestId('transcriber-start').isEnabled()).toBe(true)

      const requestCountBefore = server.requests.length
      server.enqueueRoute('openai_transcriptions', {
        body: createOpenAITranscriptionBody({
          text: 'First route-aware transcript',
          model: 'gpt-4o-transcribe',
        }),
      })
      await page.getByTestId('transcriber-start').evaluate((button) => {
        const start = button as HTMLButtonElement
        start.click()
        start.click()
      })
      await waitForFakeAudioRequestCount(server, requestCountBefore + 1)
      await waitForTranscriptionReady(page, 'First route-aware transcript')
      await page.waitForTimeout(100)
      expect(server.requests).toHaveLength(requestCountBefore + 1)

      server.enqueueRoute('openai_transcriptions', {
        body: createOpenAITranscriptionBody({
          text: 'Second route-aware transcript',
          model: 'gpt-4o-transcribe',
        }),
      })
      await page.getByTestId('transcriber-start').click()
      await waitForFakeAudioRequestCount(server, requestCountBefore + 2)
      await waitForTranscriptionReady(page, 'Second route-aware transcript')
      expect(
        server.requests
          .slice(requestCountBefore)
          .map((request) => request.route),
      ).toEqual(['openai_transcriptions', 'openai_transcriptions'])

      const persistedTranscriber = await page.evaluate(() => {
        const raw = localStorage.getItem('fusionkit-audio-transcriber') ?? ''
        try {
          const envelope = JSON.parse(raw) as { state?: Record<string, unknown> }
          return {
            raw,
            stateKeys: Object.keys(envelope.state ?? {}).sort(),
          }
        } catch {
          return { raw, stateKeys: ['invalid-json'] }
        }
      })
      expect(persistedTranscriber.stateKeys).toEqual(['preferences'])
      expect(persistedTranscriber.raw).not.toContain(path.basename(samplePath))
      expect(persistedTranscriber.raw).not.toContain(samplePath)
      expect(persistedTranscriber.raw).not.toContain('fileName')
      expect(persistedTranscriber.raw).not.toContain('filePath')
      expect(persistedTranscriber.raw).not.toContain('fileToken')
      expect(persistedTranscriber.raw).not.toContain('sourceFile')

      await page.waitForFunction(
        () => !document.querySelector('[data-sonner-toast]'),
        undefined,
        { timeout: 15_000 },
      )
      await setWindowSize(mainWin, page, { width: 1280, height: 800 })
      await scrollTestTargetIntoView(page, 'audio-transcriber', 'start')
      expect(await hasHorizontalOverflow(page)).toBe(false)
      await page.screenshot({
        path: path.join(testResultsDir, 'fe-r03-transcriber-1280x800.png'),
        animations: 'disabled',
      })

      await setWindowSize(mainWin, page, { width: 786, height: 540 })
      await scrollTestTargetIntoView(page, 'transcriber-result', 'center')
      expect(await hasHorizontalOverflow(page)).toBe(false)
      await page.screenshot({
        path: path.join(testResultsDir, 'fe-r03-transcriber-786x540.png'),
        animations: 'disabled',
      })

      expect(await page.locator('body').innerText()).not.toMatch(
        /\baudio:[a-z0-9_.-]+/i,
      )
      expect(rendererErrors).toEqual([])
    }, 180_000)

    test('route-aware realtime captions expose only usable controls', async () => {
      const server = fakeAudioApiServer
      if (!server) {
        throw new Error('FE-R03 realtime captions fixtures were not initialized')
      }

      await setWindowSize(mainWin, page, { width: 1280, height: 800 })
      await seedRealtimeCaptionsAudioSettings(page, 'none', server.baseUrl)
      expect(await page.getByTestId('captions-config-cta').isVisible()).toBe(true)
      expect(await page.getByTestId('captions-config').count()).toBe(0)
      expect(await page.getByTestId('captions-start').count()).toBe(0)
      expect(await hasHorizontalOverflow(page)).toBe(false)
      await page.getByTestId('captions-config-cta').click()
      await page.waitForFunction(() =>
        window.location.hash ===
          '#/setting?tab=audio&returnTo=%2Ftools%2Faudio%2Frealtime-captions',
      )

      await seedRealtimeCaptionsAudioSettings(
        page,
        'openai_realtime',
        server.baseUrl,
      )
      expect(
        await page.getByTestId('captions-config-summary').textContent(),
      ).toContain('FE-R03 OpenAI Realtime audio')
      expect(await page.getByTestId('captions-config').isVisible()).toBe(true)
      expect(await page.locator('#captions-language').isVisible()).toBe(true)
      expect(
        await page.getByTestId('captions-input-audio-format').isVisible(),
      ).toBe(true)
      expect(await page.locator('#captions-turn-detection').count()).toBe(0)
      expect(await page.locator('#captions-assistant-transcript').count()).toBe(0)
      expect(await page.locator('#captions-instructions').count()).toBe(0)

      const pcm16 = page.getByTestId('captions-input-format-pcm16')
      const pcmu = page.getByTestId('captions-input-format-pcmu')
      const pcma = page.getByTestId('captions-input-format-pcma')
      await pcm16.click()
      await pcm16.focus()
      expect(
        await Promise.all([
          pcm16.getAttribute('tabindex'),
          pcmu.getAttribute('tabindex'),
          pcma.getAttribute('tabindex'),
        ]),
      ).toEqual(['0', '-1', '-1'])
      await page.keyboard.press('ArrowRight')
      expect(await pcmu.getAttribute('data-state')).toBe('checked')
      expect(await pcmu.evaluate((element) => document.activeElement === element))
        .toBe(true)
      await page.keyboard.press('End')
      expect(await pcma.getAttribute('data-state')).toBe('checked')
      await page.keyboard.press('Home')
      expect(await pcm16.getAttribute('data-state')).toBe('checked')
      expect(await pcm16.evaluate((element) => document.activeElement === element))
        .toBe(true)

      await expect.poll(async () => {
        return await page.evaluate(() => {
          const raw = localStorage.getItem('fusionkit-realtime-captions')
          if (!raw) return []
          try {
            const envelope = JSON.parse(raw) as {
              version?: unknown
              state?: Record<string, unknown>
            }
            return [envelope.version, ...Object.keys(envelope.state ?? {}).sort()]
          } catch {
            return ['invalid-json']
          }
        })
      }).toEqual([4, 'preferences'])

      await seedRealtimeCaptionsAudioSettings(page, 'mimo_chunked', server.baseUrl)
      expect(
        await page.getByTestId('captions-config-summary').textContent(),
      ).toContain('FE-R03 MiMo captions audio')
      expect(await page.getByTestId('captions-input-audio-format').count()).toBe(0)
      expect(await page.locator('#captions-turn-detection').count()).toBe(0)
      expect(await page.locator('#captions-assistant-transcript').count()).toBe(0)
      expect(await page.locator('#captions-instructions').count()).toBe(0)
      expect(await page.getByTestId('captions-chunked-notice').isVisible()).toBe(true)
      expect(
        (await page.getByTestId('captions-chunked-notice').textContent())?.toLowerCase(),
      ).toContain('not a webrtc')
      expect(await page.getByTestId('captions-start').isEnabled()).toBe(true)

      const languageTrigger = page.locator('#captions-language')
      expect(await languageTrigger.textContent()).toContain('Auto detect')
      await languageTrigger.click()
      expect(
        (await page.getByRole('option').allTextContents()).map((value) =>
          value.trim(),
        ),
      ).toEqual(['Auto detect', 'Chinese', 'English'])
      await page.keyboard.press('Escape')

      await scrollTestTargetIntoView(page, 'realtime-captions', 'start')
      const wideLayout = await readCaptionsLayout(page)
      expect(wideLayout.hasHorizontalOverflow).toBe(false)
      expect(wideLayout.asideRight).toBeLessThanOrEqual(wideLayout.mainLeft + 1)
      await page.screenshot({
        path: path.join(testResultsDir, 'fe-r03-captions-mimo-1280x800.png'),
        animations: 'disabled',
      })

      await seedRealtimeCaptionsAudioSettings(
        page,
        'openai_realtime',
        server.baseUrl,
      )
      await setWindowSize(mainWin, page, { width: 786, height: 540 })
      await scrollTestTargetIntoView(page, 'captions-input-audio-format', 'center')
      const narrowLayout = await readCaptionsLayout(page)
      expect(narrowLayout.hasHorizontalOverflow).toBe(false)
      expect(narrowLayout.mainTop).toBeGreaterThanOrEqual(
        narrowLayout.asideBottom - 1,
      )
      expect(await captionsInputFormatItemsFit(page)).toBe(true)
      await page.screenshot({
        path: path.join(testResultsDir, 'fe-r03-captions-openai-786x540.png'),
        animations: 'disabled',
      })
      await scrollTestTargetIntoView(page, 'captions-workspace', 'start')
      expect(await hasHorizontalOverflow(page)).toBe(false)
      await page.screenshot({
        path: path.join(
          testResultsDir,
          'fe-r03-captions-workspace-786x540.png',
        ),
        animations: 'disabled',
      })

      expect(await page.locator('body').innerText()).not.toMatch(
        /\baudio:[a-z0-9_.-]+/i,
      )
      expect(rendererErrors).toEqual([])
    }, 180_000)

    test('route-aware realtime voice uses standalone config and accessible controls', async () => {
      const server = fakeAudioApiServer
      if (!server) {
        throw new Error('FE-R03 realtime voice fixtures were not initialized')
      }

      await setWindowSize(mainWin, page, { width: 1280, height: 800 })
      await seedRealtimeVoiceAudioSettings(page, 'none', server.baseUrl)
      expect(await page.getByTestId('voice-config-cta').isVisible()).toBe(true)
      expect(await page.getByTestId('voice-config').count()).toBe(0)
      expect(await page.getByTestId('voice-connect').count()).toBe(0)
      expect(await hasHorizontalOverflow(page)).toBe(false)
      await page.getByTestId('voice-config-cta').click()
      await page.waitForFunction(() =>
        window.location.hash ===
          '#/setting?tab=audio&returnTo=%2Ftools%2Faudio%2Frealtime-voice',
      )

      await seedRealtimeVoiceAudioSettings(page, 'openai', server.baseUrl)
      expect(
        await page.getByTestId('voice-config-summary').textContent(),
      ).toContain('FE-R03 OpenAI voice audio')
      expect(await page.getByTestId('voice-config').isVisible()).toBe(true)
      expect(await page.getByTestId('voice-select').isVisible()).toBe(true)
      expect(await page.getByTestId('voice-field-instructions').isVisible()).toBe(true)
      expect(await page.locator('#realtime-voice-turn-detection').count()).toBe(0)
      expect(await page.getByText('Manual', { exact: true }).count()).toBe(0)
      expect(await page.getByTestId('voice-connect').isEnabled()).toBe(true)

      await page.getByTestId('voice-select').click()
      expect(
        (await page.getByRole('option').allTextContents()).map((value) =>
          value.trim(),
        ),
      ).toEqual([
        'alloy',
        'ash',
        'ballad',
        'coral',
        'echo',
        'marin',
        'sage',
        'verse',
      ])
      await page.getByRole('option', { name: 'ash', exact: true }).click()

      const inputPcm16 = page.getByTestId('voice-input-format-pcm16')
      const inputPcmu = page.getByTestId('voice-input-format-pcmu')
      const inputPcma = page.getByTestId('voice-input-format-pcma')
      await inputPcm16.click()
      await inputPcm16.focus()
      expect(
        await Promise.all([
          inputPcm16.getAttribute('tabindex'),
          inputPcmu.getAttribute('tabindex'),
          inputPcma.getAttribute('tabindex'),
        ]),
      ).toEqual(['0', '-1', '-1'])
      await page.keyboard.press('ArrowRight')
      expect(await inputPcmu.getAttribute('data-state')).toBe('checked')
      expect(
        await inputPcmu.evaluate((element) => document.activeElement === element),
      ).toBe(true)
      await page.keyboard.press('End')
      expect(await inputPcma.getAttribute('data-state')).toBe('checked')
      await page.keyboard.press('Home')
      expect(await inputPcm16.getAttribute('data-state')).toBe('checked')

      const outputPcmu = page.getByTestId('voice-output-format-pcmu')
      await outputPcmu.click()
      expect(await outputPcmu.getAttribute('data-state')).toBe('checked')

      await expect.poll(async () => {
        return await page.evaluate(() => {
          const raw = localStorage.getItem('fusionkit-realtime-voice')
          if (!raw) return []
          try {
            const envelope = JSON.parse(raw) as {
              version?: unknown
              state?: Record<string, unknown>
            }
            return [envelope.version, ...Object.keys(envelope.state ?? {}).sort()]
          } catch {
            return ['invalid-json']
          }
        })
      }).toEqual([4, 'preferences'])
      expect(await page.locator('body').innerText()).not.toContain('must-not-hydrate')

      await scrollTestTargetIntoView(page, 'realtime-voice', 'start')
      const wideLayout = await readVoiceLayout(page)
      expect(wideLayout.hasHorizontalOverflow).toBe(false)
      expect(wideLayout.asideRight).toBeLessThanOrEqual(wideLayout.mainLeft + 1)
      await page.screenshot({
        path: path.join(testResultsDir, 'fe-r03-voice-1280x800.png'),
        animations: 'disabled',
      })

      await setWindowSize(mainWin, page, { width: 786, height: 540 })
      await scrollTestTargetIntoView(page, 'voice-input-audio-format', 'center')
      const narrowLayout = await readVoiceLayout(page)
      expect(narrowLayout.hasHorizontalOverflow).toBe(false)
      expect(narrowLayout.mainTop).toBeGreaterThanOrEqual(
        narrowLayout.asideBottom - 1,
      )
      expect(await voiceFormatItemsFit(page)).toBe(true)
      await page.screenshot({
        path: path.join(testResultsDir, 'fe-r03-voice-786x540.png'),
        animations: 'disabled',
      })
      await scrollTestTargetIntoView(page, 'voice-workspace', 'start')
      await page.screenshot({
        path: path.join(testResultsDir, 'fe-r03-voice-workspace-786x540.png'),
        animations: 'disabled',
      })

      await page.evaluate(() => {
        const testWindow = window as typeof window & {
          __voiceGetUserMediaCount?: number
        }
        testWindow.__voiceGetUserMediaCount = 0
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: {
            getUserMedia: () => {
              testWindow.__voiceGetUserMediaCount =
                (testWindow.__voiceGetUserMediaCount ?? 0) + 1
              return new Promise<MediaStream>(() => undefined)
            },
          },
        })
      })
      const requestCountBeforeConnect = server.requests.length
      server.enqueueRoute('openai_realtime_client_secrets', {
        body: createOpenAIRealtimeClientSecretBody({
          sessionId: 'sess_fe_r03_voice',
          model: 'gpt-realtime',
          expiresAt: 2_000_000_000,
        }),
      })
      await page.getByTestId('voice-connect').evaluate((element) => {
        const button = element as HTMLButtonElement
        button.click()
        button.click()
      })
      await waitForFakeAudioRequestCount(server, requestCountBeforeConnect + 1)
      await expect.poll(async () =>
        await page.evaluate(() => (
          window as typeof window & { __voiceGetUserMediaCount?: number }
        ).__voiceGetUserMediaCount ?? 0),
      ).toBe(1)
      expect(server.requests).toHaveLength(requestCountBeforeConnect + 1)
      await page.getByTestId('voice-disconnect').click()
      await expect.poll(async () =>
        await page.getByTestId('voice-connect').isEnabled(),
      ).toBe(true)
      expect(server.requests).toHaveLength(requestCountBeforeConnect + 1)

      await installRealtimeVoiceBrowserHarness(page)
      const requestCountBeforeFullSession = server.requests.length
      server.enqueueRoute('openai_realtime_client_secrets', {
        body: createOpenAIRealtimeClientSecretBody({
          sessionId: 'sess_fe_r03_voice_full',
          model: 'gpt-realtime',
          expiresAt: 2_000_000_000,
        }),
      })
      await page.getByTestId('voice-connect').evaluate((element) => {
        const button = element as HTMLButtonElement
        button.click()
        button.click()
      })
      await waitForFakeAudioRequestCount(
        server,
        requestCountBeforeFullSession + 1,
      )
      await expect.poll(async () =>
        await page.getByTestId('voice-disconnect').isEnabled(),
      ).toBe(true)
      expect(await readRealtimeVoiceHarness(page)).toMatchObject({
        getUserMediaCount: 1,
        peerConnectionCount: 1,
        trackStopCount: 0,
      })

      await emitRealtimeVoiceServerEvent(page, {
        type: 'response.created',
        response: { id: 'resp_a' },
      })
      await emitRealtimeVoiceServerEvent(page, {
        type: 'output_audio_buffer.started',
      })
      await emitRealtimeVoiceServerEvent(page, {
        type: 'response.created',
        response: { id: 'resp_b' },
      })
      await emitRealtimeVoiceServerEvent(page, {
        type: 'response.done',
        response: { id: 'resp_a', status: 'completed' },
      })
      expect(await page.getByTestId('voice-interrupt').isEnabled()).toBe(true)

      await emitRealtimeVoiceServerEvent(page, {
        type: 'response.output_audio_transcript.done',
        item_id: 'item_b',
        response_id: 'resp_b',
        transcript: 'Buffered response',
      })
      await page.getByText('Buffered response', { exact: true }).waitFor()
      await page.getByTestId('voice-clear').click()
      expect(await page.getByText('Buffered response', { exact: true }).count())
        .toBe(0)
      expect(await page.getByTestId('voice-interrupt').isEnabled()).toBe(true)

      await emitRealtimeVoiceServerEvent(page, {
        type: 'response.done',
        response: { id: 'resp_b', status: 'completed' },
      })
      expect(await page.getByTestId('voice-interrupt').isEnabled()).toBe(true)
      await page.getByTestId('voice-interrupt').click()
      await expect.poll(async () =>
        (await readRealtimeVoiceHarness(page)).sentEvents,
      ).toEqual([{ type: 'output_audio_buffer.clear' }])

      await emitRealtimeVoiceServerEvent(page, {
        type: 'response.output_audio.done',
        response_id: 'resp_b',
      })
      expect(await page.getByTestId('voice-interrupt').isEnabled()).toBe(true)
      expect(
        await page
          .locator('[data-sonner-toast]')
          .filter({ hasText: 'Interrupt command sent' })
          .count(),
      ).toBe(0)
      await emitRealtimeVoiceServerEvent(page, {
        type: 'output_audio_buffer.cleared',
      })
      await expect.poll(async () =>
        await page.getByTestId('voice-interrupt').isEnabled(),
      ).toBe(false)
      await page
        .locator('[data-sonner-toast]')
        .filter({ hasText: 'Interrupt command sent' })
        .waitFor({ state: 'visible' })

      await emitRealtimeVoiceServerEvent(page, {
        type: 'response.created',
        response: { id: 'resp_c' },
      })
      await emitRealtimeVoiceServerEvent(page, {
        type: 'output_audio_buffer.started',
      })
      await page.getByTestId('voice-interrupt').click()
      await expect.poll(async () =>
        (await readRealtimeVoiceHarness(page)).sentEvents.slice(-2),
      ).toEqual([
        { type: 'response.cancel', response_id: 'resp_c' },
        { type: 'output_audio_buffer.clear' },
      ])
      await emitRealtimeVoiceServerEvent(page, {
        type: 'response.done',
        response: { id: 'resp_c', status: 'cancelled' },
      })
      expect(await page.getByTestId('voice-interrupt').isEnabled()).toBe(true)
      await emitRealtimeVoiceServerEvent(page, {
        type: 'output_audio_buffer.cleared',
      })
      await expect.poll(async () =>
        await page.getByTestId('voice-interrupt').isEnabled(),
      ).toBe(false)

      await page.getByTestId('voice-disconnect').evaluate((element) => {
        const button = element as HTMLButtonElement
        button.click()
        button.click()
      })
      await expect.poll(async () =>
        await page.getByTestId('voice-connect').isEnabled(),
      ).toBe(true)
      expect(await readRealtimeVoiceHarness(page)).toMatchObject({
        dataChannelCloseCount: 1,
        peerConnectionCloseCount: 1,
        trackStopCount: 1,
      })

      server.enqueueRoute('openai_realtime_client_secrets', {
        body: createOpenAIRealtimeClientSecretBody({
          sessionId: 'sess_fe_r03_voice_unmount',
          model: 'gpt-realtime',
          expiresAt: 2_000_000_000,
        }),
      })
      await page.getByTestId('voice-connect').click()
      await expect.poll(async () =>
        (await readRealtimeVoiceHarness(page)).peerConnectionCount,
      ).toBe(2)
      await page.evaluate(() => {
        window.location.hash = '#/tools/audio/realtime-captions'
      })
      await page.getByTestId('realtime-captions').waitFor({ state: 'visible' })
      await expect.poll(async () =>
        await readRealtimeVoiceHarness(page),
      ).toMatchObject({
        dataChannelCloseCount: 2,
        peerConnectionCloseCount: 2,
        trackStopCount: 2,
      })

      expect(await page.locator('body').innerText()).not.toMatch(
        /\baudio:[a-z0-9_.-]+/i,
      )
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

type TranscriberAudioSeed =
  | 'none'
  | 'openai_gpt'
  | 'openai_whisper'
  | 'mimo'

async function seedTranscriberAudioSettings(
  targetPage: Page,
  seed: TranscriberAudioSeed,
  baseUrl: string,
): Promise<void> {
  await targetPage.evaluate(({ nextSeed, nextBaseUrl }) => {
    localStorage.clear()
    localStorage.setItem('lang', 'en')
    if (nextSeed !== 'none') {
      const isMimo = nextSeed === 'mimo'
      const profileId = `fe_r03_${nextSeed}`
      const model = nextSeed === 'openai_whisper'
        ? 'whisper-1'
        : isMimo
          ? 'mimo-v2.5-asr'
          : 'gpt-4o-transcribe'
      localStorage.setItem(
        'fusionkit-audio-settings',
        JSON.stringify({
          version: 1,
          state: {
            profiles: [
              {
                id: profileId,
                name: isMimo
                  ? 'FE-R03 MiMo audio'
                  : 'FE-R03 OpenAI audio',
                providerPreset: isMimo ? 'mimo' : 'openai',
                baseUrl: nextBaseUrl,
                apiKey: 'fe-r03-e2e-key',
                routes: {
                  transcription: {
                    transport: isMimo ? 'mimo_chat_audio' : 'openai_audio',
                    model,
                    enabled: true,
                  },
                  speechSynthesis: {},
                },
              },
            ],
            assignment: {
              transcription: profileId,
              speechSynthesis: null,
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
    window.location.hash = '#/tools/audio/transcriber'
  }, { nextSeed: seed, nextBaseUrl: baseUrl })
  await targetPage.reload({ waitUntil: 'domcontentloaded' })
  await waitForFusionKitLoadingToExit(targetPage)
  await targetPage.getByTestId('audio-transcriber').waitFor({ state: 'visible' })
  await targetPage
    .getByTestId(
      seed === 'none' ? 'transcriber-config-cta' : 'transcriber-workspace',
    )
    .waitFor({ state: 'visible' })
}

type RealtimeCaptionsAudioSeed = 'none' | 'openai_realtime' | 'mimo_chunked'

async function seedRealtimeCaptionsAudioSettings(
  targetPage: Page,
  seed: RealtimeCaptionsAudioSeed,
  baseUrl: string,
): Promise<void> {
  await targetPage.evaluate(({ nextSeed, nextBaseUrl }) => {
    localStorage.clear()
    localStorage.setItem('lang', 'en')
    if (nextSeed !== 'none') {
      const isMimo = nextSeed === 'mimo_chunked'
      const profileId = `fe_r03_captions_${nextSeed}`
      if (isMimo) {
        localStorage.setItem(
          'fusionkit-realtime-captions',
          JSON.stringify({
            version: 4,
            state: {
              preferences: {
                language: 'ja',
                outputFormat: 'txt',
                inputAudioFormat: 'pcma',
              },
              status: 'listening',
              sessionId: 'must-not-hydrate',
              lines: [{ id: 'must-not-hydrate' }],
            },
          }),
        )
      }
      localStorage.setItem(
        'fusionkit-audio-settings',
        JSON.stringify({
          version: 1,
          state: {
            profiles: [
              {
                id: profileId,
                name: isMimo
                  ? 'FE-R03 MiMo captions audio'
                  : 'FE-R03 OpenAI Realtime audio',
                providerPreset: isMimo ? 'mimo' : 'openai',
                baseUrl: nextBaseUrl,
                apiKey: 'fe-r03-captions-e2e-key',
                routes: {
                  speechSynthesis: {},
                  realtimeCaptions: {
                    transport: isMimo ? 'mimo_chat_audio' : 'openai_realtime',
                    model: isMimo ? 'mimo-v2.5-asr' : 'gpt-realtime-whisper',
                    enabled: true,
                  },
                },
              },
            ],
            assignment: {
              transcription: null,
              speechSynthesis: null,
              realtimeCaptions: profileId,
              realtimeVoice: null,
            },
            migration: {
              legacyModelStore: { status: 'not_needed' },
            },
          },
        }),
      )
    }
    window.location.hash = '#/tools/audio/realtime-captions'
  }, { nextSeed: seed, nextBaseUrl: baseUrl })
  await targetPage.reload({ waitUntil: 'domcontentloaded' })
  await waitForFusionKitLoadingToExit(targetPage)
  await targetPage.getByTestId('realtime-captions').waitFor({ state: 'visible' })
  await targetPage
    .getByTestId(seed === 'none' ? 'captions-config-cta' : 'captions-workspace')
      .waitFor({ state: 'visible' })
}

type RealtimeVoiceAudioSeed = 'none' | 'openai'

async function seedRealtimeVoiceAudioSettings(
  targetPage: Page,
  seed: RealtimeVoiceAudioSeed,
  baseUrl: string,
): Promise<void> {
  await targetPage.evaluate(({ nextSeed, nextBaseUrl }) => {
    localStorage.clear()
    localStorage.setItem('lang', 'en')
    localStorage.setItem(
      'fusionkit-model',
      JSON.stringify({
        version: 5,
        state: {
          profiles: [
            {
              id: 'legacy_voice_connection',
              name: 'Legacy voice connection must be ignored',
              provider: 'OpenAI',
              apiKey: 'legacy-key',
              baseUrl: nextBaseUrl,
              modelKey: 'gpt-realtime',
              apiFormat: 'responses',
              outputTokenParameter: 'max_output_tokens',
              tokenPricing: {
                inputTokensPerMillion: 1,
                outputTokensPerMillion: 1,
              },
            },
          ],
          assignment: {},
          audioProfiles: [
            {
              id: 'legacy_voice_profile',
              name: 'Legacy voice profile must be ignored',
              connectionProfileId: 'legacy_voice_connection',
              audioDialect: 'openai_realtime',
              capabilities: ['realtime_duplex_voice'],
              models: { realtimeVoice: 'gpt-realtime' },
              defaults: {},
            },
          ],
          audioAssignment: {
            transcription: null,
            speechSynthesis: null,
            realtimeCaptions: null,
            realtimeVoice: 'legacy_voice_profile',
          },
        },
      }),
    )
    localStorage.setItem(
      'fusionkit-realtime-voice',
      JSON.stringify({
        version: 4,
        state: {
          preferences: {
            voice: 'marin',
            instructions: 'Answer briefly.',
            turnDetection: 'manual',
            inputAudioFormat: 'pcma',
            outputAudioFormat: 'pcmu',
          },
          status: 'connected',
          micState: 'granted',
          sessionId: 'must-not-hydrate',
          startedAtMs: 1,
          activeResponseId: 'must-not-hydrate',
          assistantSpeaking: true,
          lines: [{ id: 'must-not-hydrate' }],
        },
      }),
    )
    const profileId = nextSeed === 'openai' ? 'fe_r03_voice_openai' : null
    localStorage.setItem(
      'fusionkit-audio-settings',
      JSON.stringify({
        version: 1,
        state: {
          profiles: profileId
            ? [
                {
                  id: profileId,
                  name: 'FE-R03 OpenAI voice audio',
                  providerPreset: 'openai',
                  baseUrl: nextBaseUrl,
                  apiKey: 'fe-r03-voice-e2e-key',
                  routes: {
                    speechSynthesis: {},
                    realtimeVoice: {
                      transport: 'openai_realtime',
                      model: 'gpt-realtime',
                      enabled: true,
                    },
                  },
                },
              ]
            : [],
          assignment: {
            transcription: null,
            speechSynthesis: null,
            realtimeCaptions: null,
            realtimeVoice: profileId,
          },
          migration: {
            legacyModelStore: { status: 'completed', sourceVersion: 5 },
          },
        },
      }),
    )
    window.location.hash = '#/tools/audio/realtime-voice'
  }, { nextSeed: seed, nextBaseUrl: baseUrl })
  await targetPage.reload({ waitUntil: 'domcontentloaded' })
  try {
    await waitForFusionKitLoadingToExit(targetPage)
  } catch (error) {
    const diagnostics = await targetPage.evaluate(() => ({
      hash: window.location.hash,
      bodyText: document.body.innerText,
      rootHtml: document.querySelector('#root')?.innerHTML ?? null,
    })).catch(() => null)
    throw new Error(
      `Realtime voice page did not mount: ${JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        diagnostics,
        rendererErrors,
      })}`,
    )
  }
  await targetPage.getByTestId('realtime-voice').waitFor({ state: 'visible' })
  await targetPage
    .getByTestId(seed === 'none' ? 'voice-config-cta' : 'voice-workspace')
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

interface RealtimeVoiceBrowserHarnessSnapshot {
  getUserMediaCount: number
  peerConnectionCount: number
  dataChannelCloseCount: number
  peerConnectionCloseCount: number
  trackStopCount: number
  sentEvents: Array<Record<string, unknown>>
}

async function installRealtimeVoiceBrowserHarness(
  targetPage: Page,
): Promise<void> {
  await targetPage.evaluate(() => {
    interface HarnessState {
      getUserMediaCount: number
      peerConnectionCount: number
      dataChannelCloseCount: number
      peerConnectionCloseCount: number
      trackStopCount: number
      sentEvents: Array<Record<string, unknown>>
    }
    interface Harness {
      state: HarnessState
      emit: (event: Record<string, unknown>) => void
    }
    type TestWindow = typeof window & { __voiceHarness?: Harness }

    const testWindow = window as TestWindow
    const state: HarnessState = {
      getUserMediaCount: 0,
      peerConnectionCount: 0,
      dataChannelCloseCount: 0,
      peerConnectionCloseCount: 0,
      trackStopCount: 0,
      sentEvents: [],
    }
    const dataChannelListeners = new Map<string, Set<EventListener>>()
    const addDataChannelListener = (type: string, listener: EventListener) => {
      const listeners = dataChannelListeners.get(type) ?? new Set<EventListener>()
      listeners.add(listener)
      dataChannelListeners.set(type, listeners)
    }

    class FakeDataChannel {
      private closed = false

      addEventListener(type: string, listener: EventListener) {
        addDataChannelListener(type, listener)
      }

      send(payload: string) {
        state.sentEvents.push(JSON.parse(payload) as Record<string, unknown>)
      }

      close() {
        if (this.closed) return
        this.closed = true
        state.dataChannelCloseCount += 1
        for (const listener of dataChannelListeners.get('close') ?? []) {
          listener(new Event('close'))
        }
      }
    }

    class FakePeerConnection {
      connectionState: RTCPeerConnectionState = 'connected'
      iceConnectionState: RTCIceConnectionState = 'connected'
      private closed = false

      constructor() {
        state.peerConnectionCount += 1
      }

      createDataChannel() {
        return new FakeDataChannel() as unknown as RTCDataChannel
      }

      addEventListener() {}

      addTrack() {}

      async createOffer(): Promise<RTCSessionDescriptionInit> {
        return { type: 'offer', sdp: 'fake-offer-sdp' }
      }

      async setLocalDescription() {}

      async setRemoteDescription() {}

      close() {
        if (this.closed) return
        this.closed = true
        this.connectionState = 'closed'
        this.iceConnectionState = 'closed'
        state.peerConnectionCloseCount += 1
      }
    }

    const track = {
      kind: 'audio',
      enabled: true,
      stop: () => {
        state.trackStopCount += 1
      },
      addEventListener: () => undefined,
    } as unknown as MediaStreamTrack
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as MediaStream

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          state.getUserMediaCount += 1
          return stream
        },
      },
    })
    Object.defineProperty(window, 'RTCPeerConnection', {
      configurable: true,
      value: FakePeerConnection,
    })
    const originalFetch = window.fetch.bind(window)
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
      if (url.endsWith('/realtime/calls')) {
        return new Response('fake-answer-sdp', {
          status: 200,
          headers: { 'Content-Type': 'application/sdp' },
        })
      }
      return await originalFetch(input, init)
    }) as typeof window.fetch

    testWindow.__voiceHarness = {
      state,
      emit: (event) => {
        const message = new MessageEvent('message', {
          data: JSON.stringify(event),
        })
        for (const listener of dataChannelListeners.get('message') ?? []) {
          listener(message)
        }
      },
    }
  })
}

async function emitRealtimeVoiceServerEvent(
  targetPage: Page,
  event: Record<string, unknown>,
): Promise<void> {
  await targetPage.evaluate((rawEvent) => {
    const testWindow = window as typeof window & {
      __voiceHarness?: {
        emit: (event: Record<string, unknown>) => void
      }
    }
    if (!testWindow.__voiceHarness) {
      throw new Error('Realtime voice browser harness is not installed')
    }
    testWindow.__voiceHarness.emit(rawEvent)
  }, event)
}

async function readRealtimeVoiceHarness(
  targetPage: Page,
): Promise<RealtimeVoiceBrowserHarnessSnapshot> {
  return await targetPage.evaluate(() => {
    const testWindow = window as typeof window & {
      __voiceHarness?: {
        state: RealtimeVoiceBrowserHarnessSnapshot
      }
    }
    if (!testWindow.__voiceHarness) {
      throw new Error('Realtime voice browser harness is not installed')
    }
    return JSON.parse(JSON.stringify(
      testWindow.__voiceHarness.state,
    )) as RealtimeVoiceBrowserHarnessSnapshot
  })
}

async function waitForTranscriptionReady(
  targetPage: Page,
  expectedText: string,
): Promise<void> {
  await targetPage.waitForFunction((text) => {
    const start = document.querySelector<HTMLButtonElement>(
      '[data-testid="transcriber-start"]',
    )
    const result = document.querySelector('[data-testid="transcriber-result"]')
    const output = result?.querySelector<HTMLTextAreaElement>('textarea')
    return Boolean(start && !start.disabled && output?.value.includes(text))
  }, expectedText)
  const resultText = await targetPage
    .getByTestId('transcriber-result')
    .locator('textarea')
    .inputValue()
  if (!resultText.includes(expectedText)) {
    const bodyText = await targetPage.locator('body').innerText()
    throw new Error(`Audio transcription failed:\n${bodyText}`)
  }
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

async function readCaptionsLayout(
  targetPage: Page,
): Promise<SpeechLayoutSnapshot> {
  return await targetPage.getByTestId('realtime-captions').evaluate((root) => {
    const aside = root.querySelector('aside')
    const main = root.querySelector('main')
    if (!aside || !main) throw new Error('Captions layout columns are missing')
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

async function readVoiceLayout(
  targetPage: Page,
): Promise<SpeechLayoutSnapshot> {
  return await targetPage.getByTestId('realtime-voice').evaluate((root) => {
    const aside = root.querySelector('aside')
    const main = root.querySelector('main')
    if (!aside || !main) throw new Error('Voice layout columns are missing')
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

async function captionsInputFormatItemsFit(targetPage: Page): Promise<boolean> {
  return await targetPage
    .getByTestId('captions-input-audio-format')
    .evaluate((group) => {
      const groupRect = group.getBoundingClientRect()
      const items = Array.from(group.querySelectorAll<HTMLElement>(
        '[role="radio"]',
      ))
      return (
        items.length === 3 &&
        items.every((item) => {
          const rect = item.getBoundingClientRect()
          return (
            rect.left >= groupRect.left - 1 &&
            rect.right <= groupRect.right + 1 &&
            item.scrollWidth <= item.clientWidth + 1
          )
        })
      )
    })
}

async function voiceFormatItemsFit(targetPage: Page): Promise<boolean> {
  const testIds = [
    'voice-input-audio-format',
    'voice-output-audio-format',
  ]
  const results = await Promise.all(testIds.map(async (testId) =>
    await targetPage.getByTestId(testId).evaluate((group) => {
      const groupRect = group.getBoundingClientRect()
      const items = Array.from(group.querySelectorAll<HTMLElement>(
        '[role="radio"]',
      ))
      return (
        items.length === 3 &&
        items.every((item) => {
          const rect = item.getBoundingClientRect()
          return (
            rect.left >= groupRect.left - 1 &&
            rect.right <= groupRect.right + 1 &&
            item.scrollWidth <= item.clientWidth + 1
          )
        })
      )
    }),
  ))
  return results.every(Boolean)
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
