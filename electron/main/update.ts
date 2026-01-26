import { app, dialog, ipcMain } from 'electron'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import type {
  ProgressInfo,
  UpdateDownloadedEvent,
  UpdateInfo,
} from 'electron-updater'

const { autoUpdater } = createRequire(import.meta.url)('electron-updater');
const RELEASES_DOWNLOAD_BASE = 'https://github.com/QiuYeDx/FusionKit/releases/latest/download/'
let latestUpdateInfo: UpdateInfo | null = null

export function update(win: Electron.BrowserWindow) {

  // When set to false, the update download will be triggered through the API
  autoUpdater.autoDownload = false
  autoUpdater.disableWebInstaller = false
  autoUpdater.allowDowngrade = false

  // start check
  autoUpdater.on('checking-for-update', function () { })
  // update available
  autoUpdater.on('update-available', (arg: UpdateInfo) => {
    latestUpdateInfo = arg
    win.webContents.send('update-can-available', { update: true, version: app.getVersion(), newVersion: arg?.version })
  })
  // update not available
  autoUpdater.on('update-not-available', (arg: UpdateInfo) => {
    latestUpdateInfo = null
    win.webContents.send('update-can-available', { update: false, version: app.getVersion(), newVersion: arg?.version })
  })

  // Checking for updates
  ipcMain.handle('check-update', async () => {
    if (!app.isPackaged) {
      const error = new Error('The update feature is only available after the package.')
      return { message: error.message, error }
    }

    try {
      return await autoUpdater.checkForUpdates()
    } catch (error) {
      return { message: 'Network error', error }
    }
  })

  // Start downloading and feedback on progress
  ipcMain.handle('start-download', (event: Electron.IpcMainInvokeEvent) => {
    startDownload(
      (error, progressInfo) => {
        if (error) {
          // feedback download error message
          event.sender.send('update-error', { message: error.message, error })
        } else {
          // feedback update progress message
          event.sender.send('download-progress', progressInfo)
        }
      },
      () => {
        // feedback update downloaded message
        event.sender.send('update-downloaded')
      }
    )
  })

  // Manually download installer to a directory
  ipcMain.handle('download-installer', async (_event, payload?: { directory?: string }) => {
    if (!app.isPackaged) {
      const error = new Error('The update feature is only available after the package.')
      return { message: error.message, error }
    }

    if (!payload?.directory) {
      const error = new Error('No target directory selected.')
      return { message: error.message, error }
    }

    const fileUrl = latestUpdateInfo ? pickUpdateFileUrl(latestUpdateInfo) : null
    if (!fileUrl) {
      const error = new Error('No update file found.')
      return { message: error.message, error }
    }

    const fileName = getFileName(fileUrl)
    if (!fileName) {
      const error = new Error('Unable to resolve update file name.')
      return { message: error.message, error }
    }

    const downloadUrl = /^https?:\/\//i.test(fileUrl)
      ? fileUrl
      : `${RELEASES_DOWNLOAD_BASE}${fileName}`
    const targetPath = path.join(payload.directory, fileName)

    try {
      await downloadFile(downloadUrl, targetPath)
      return { filePath: targetPath }
    } catch (error) {
      return { message: 'Download failed', error }
    }
  })

  // Install now
  ipcMain.handle('quit-and-install', () => {
    autoUpdater.quitAndInstall(false, true)
  })
}

function startDownload(
  callback: (error: Error | null, info: ProgressInfo | null) => void,
  complete: (event: UpdateDownloadedEvent) => void,
) {
  autoUpdater.on('download-progress', (info: ProgressInfo) => callback(null, info))
  autoUpdater.on('error', (error: Error) => callback(error, null))
  autoUpdater.on('update-downloaded', complete)
  autoUpdater.downloadUpdate()
}

function pickUpdateFileUrl(info: UpdateInfo) {
  const files = info.files ?? []
  if (!files.length) return null
  const fileUrls = files.map(file => file.url).filter(Boolean)
  if (!fileUrls.length) return null

  const fileNameMap = fileUrls.map(url => ({ url, name: getFileName(url) }))
  const extensions = getPlatformExtensions()
  for (const ext of extensions) {
    const match = fileNameMap.find(item => item.name.toLowerCase().endsWith(ext))
    if (match) return match.url
  }

  return fileUrls[0] ?? null
}

function getPlatformExtensions() {
  if (process.platform === 'darwin') return ['.zip']
  if (process.platform === 'win32') return ['.exe', '.msi', '.nsis', '.zip']
  return ['.appimage', '.deb', '.rpm', '.zip']
}

function getFileName(fileUrl: string) {
  if (!fileUrl) return ''
  try {
    if (/^https?:\/\//i.test(fileUrl)) {
      return path.basename(new URL(fileUrl).pathname)
    }
  } catch {
    // ignore URL parse errors
  }
  return path.basename(fileUrl)
}

function downloadFile(url: string, targetPath: string, redirectCount = 0): Promise<void> {
  if (redirectCount > 5) {
    return Promise.reject(new Error('Too many redirects'))
  }

  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      const statusCode = response.statusCode ?? 0
      const redirectUrl = response.headers.location

      if (statusCode >= 300 && statusCode < 400 && redirectUrl) {
        response.resume()
        return resolve(downloadFile(redirectUrl, targetPath, redirectCount + 1))
      }

      if (statusCode !== 200) {
        response.resume()
        return reject(new Error(`Download failed with status ${statusCode}`))
      }

      const fileStream = fs.createWriteStream(targetPath)
      response.pipe(fileStream)
      fileStream.on('finish', () => fileStream.close(() => resolve()))
      fileStream.on('error', error => {
        fileStream.close(() => {
          fs.promises.unlink(targetPath).catch(() => undefined).finally(() => reject(error))
        })
      })
    })

    request.on('error', error => reject(error))
  })
}
