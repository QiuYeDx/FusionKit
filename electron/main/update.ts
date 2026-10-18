import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { APP_UPDATE_CHANNELS } from '../../src/app-update/contract'
import { AppUpdateService, type UpdaterLike } from './app-update/service'
import { createTestUpdater, recordTestRestart, resolveTestUpdateSetup } from './app-update/test-updater'
import { loadElectronUpdater } from './app-update/updater-runtime'
import { currentNetworkSettings } from './network/runtime'

let activeWindow: Electron.BrowserWindow | null = null
let prepareQuitAndInstall: (() => Promise<void>) | undefined
let service: AppUpdateService | undefined

export interface UpdateOptions {
  readonly prepareQuitAndInstall?: () => Promise<void>
}

/**
 * Serves the update dialog (window.appUpdate). The installed app checks GitHub and the download
 * mirrors (see app-update/service.ts); a development build never checks, and a test build only
 * talks to the local servers a UI test names.
 */
export function update(win: Electron.BrowserWindow, options: UpdateOptions = {}) {
  activeWindow = win
  if (options.prepareQuitAndInstall) {
    prepareQuitAndInstall = options.prepareQuitAndInstall
  }
  if (service) return

  const runtime = loadElectronUpdater()
  const testSetup = resolveTestUpdateSetup(process.env, { packaged: app.isPackaged })
  // A development build has no app-update.yml and must not reach the network.
  const active = app.isPackaged || !!testSetup
  let updater: UpdaterLike
  let relaunch: (() => void) | undefined
  if (!active) {
    updater = INACTIVE_UPDATER
  } else if (testSetup) {
    updater = createTestUpdater({
      runtime,
      userDataPath: path.join(app.getPath('userData'), 'update-test'),
      version: app.getVersion(),
      name: app.getName(),
      whenReady: () => app.whenReady(),
    })
    // A test run records the restart instead of quitting.
    relaunch = recordTestRestart
  } else {
    const autoUpdater = runtime.autoUpdater
    // Downloads start only when the user clicks "download and install".
    autoUpdater.autoDownload = false
    autoUpdater.disableWebInstaller = true
    autoUpdater.allowDowngrade = false
    updater = autoUpdater
    relaunch = () => {
      // Not "install on quit" this time: the installer would race the new FusionKit. The
      // downloaded update stays in the cache and is offered again after the restart.
      autoUpdater.autoInstallOnAppQuit = false
      app.relaunch()
      app.quit()
    }
  }

  service = new AppUpdateService({
    updater,
    classes: runtime,
    currentVersion: app.getVersion(),
    platform: testSetup?.platform ?? process.platform,
    arch: process.platform === 'darwin' ? process.arch : undefined,
    active,
    getDownloadSourceMode: () => currentNetworkSettings().downloadSource,
    sources: testSetup ? () => testSetup.sources : undefined,
    prepareInstall: () => prepareQuitAndInstall?.() ?? Promise.resolve(),
    relaunch,
    onState: state => sendToActiveWindow(APP_UPDATE_CHANNELS.state, state),
    // A test run records the install instead of quitting, so it stays in "installing" unless the test asks otherwise.
    installTimeoutMs: testSetup ? testSetup.installTimeoutMs : undefined,
  })
  const updates = service

  ipcMain.handle(APP_UPDATE_CHANNELS.getState, event => {
    assertTrusted(event)
    return updates.state()
  })
  ipcMain.handle(APP_UPDATE_CHANNELS.check, event => {
    assertTrusted(event)
    return updates.check()
  })
  ipcMain.handle(APP_UPDATE_CHANNELS.download, event => {
    assertTrusted(event)
    return updates.download()
  })
  ipcMain.handle(APP_UPDATE_CHANNELS.cancel, event => {
    assertTrusted(event)
    return updates.cancel()
  })
  ipcMain.handle(APP_UPDATE_CHANNELS.install, event => {
    assertTrusted(event)
    return updates.install()
  })
  ipcMain.handle(APP_UPDATE_CHANNELS.restart, event => {
    assertTrusted(event)
    return updates.restart()
  })
}

/** A development build's updater: the service never calls it, and electron-updater is never created. */
const INACTIVE_UPDATER: UpdaterLike = {
  setFeedURL: () => undefined,
  checkForUpdates: async () => null,
  downloadUpdate: async () => [],
  quitAndInstall: () => undefined,
  on: () => undefined,
}

function sendToActiveWindow(channel: string, payload: unknown) {
  if (!activeWindow || activeWindow.isDestroyed()) return
  activeWindow.webContents.send(channel, payload)
}

/** Only the application's own windows, from their main frame, may download or start an installer. */
function assertTrusted(event: IpcMainInvokeEvent): void {
  if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Updates are only available to the application window.')
  }
}
