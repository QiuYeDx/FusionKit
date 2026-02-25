import type { ProgressInfo } from 'electron-updater'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { CheckCircle2, AlertCircle, DownloadCloud, MonitorUp, ArrowRight, FolderDown } from 'lucide-react'

export const UPDATE_CHECK_EVENT = 'fusionkit-check-update'
export const UPDATE_STATUS_EVENT = 'fusionkit-update-status'
const RELEASES_URL = 'https://github.com/QiuYeDx/FusionKit/releases/latest'

type UpdateProps = {
  autoCheck?: boolean
  autoCheckDelay?: number
  showTrigger?: boolean
  manualTriggerEvent?: string
  triggerLabel?: string
  checkingLabel?: string
}

const Update = ({
  autoCheck = false,
  autoCheckDelay = 1500,
  showTrigger = true,
  manualTriggerEvent = UPDATE_CHECK_EVENT,
  triggerLabel,
  checkingLabel,
}: UpdateProps) => {
  const { t } = useTranslation()
  const [checking, setChecking] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [versionInfo, setVersionInfo] = useState<VersionInfo>()
  const [updateError, setUpdateError] = useState<ErrorType>()
  const [progressInfo, setProgressInfo] = useState<Partial<ProgressInfo>>()
  const [downloadStatus, setDownloadStatus] = useState<'idle' | 'downloading' | 'downloaded'>('idle')
  const [modalOpen, setModalOpen] = useState<boolean>(false)
  const [manualDownloading, setManualDownloading] = useState(false)
  const [manualDownloadPath, setManualDownloadPath] = useState<string>()
  const [manualDownloadError, setManualDownloadError] = useState<string>()
  const [modalBtn, setModalBtn] = useState<{
    cancelText?: string
    okText?: string
    onCancel?: () => void
    onOk?: () => void
  }>({
    okText: undefined,
    onOk: () => setModalOpen(false),
  })

  const resetModalBtn = useCallback(() => {
    setModalBtn({
      cancelText: undefined,
      okText: t('common:action.close'),
      onOk: () => setModalOpen(false),
    })
  }, [t])

  const handleStartDownload = useCallback(() => {
    setDownloadStatus('downloading')
    window.ipcRenderer.invoke('start-download')
  }, [])

  const handleManualDownload = useCallback(async () => {
    setManualDownloading(true)
    setManualDownloadError(undefined)
    setManualDownloadPath(undefined)
    try {
      const dialogResult = await window.ipcRenderer.invoke('select-output-directory', {
        title: t('common:update.select_directory_title'),
        buttonLabel: t('common:update.select_directory_button'),
      })

      if (dialogResult?.canceled || !dialogResult?.filePaths?.[0]) {
        return
      }

      const result = await window.ipcRenderer.invoke('download-installer', {
        directory: dialogResult.filePaths[0],
      })

      if (result?.error) {
        setManualDownloadError(result?.message ?? result?.error?.message ?? t('common:update.manual_download_failed'))
        return
      }

      if (result?.filePath) {
        setManualDownloadPath(result.filePath)
      }
    } finally {
      setManualDownloading(false)
    }
  }, [t])
  const triggerText = useMemo(() => {
    return triggerLabel ?? t('common:action.check_update')
  }, [t, triggerLabel])

  const checkingText = useMemo(() => {
    return checkingLabel ?? t('common:update.checking')
  }, [t, checkingLabel])

  const progressValue = useMemo(() => {
    const value = Number(progressInfo?.percent ?? 0)
    if (Number.isNaN(value)) return 0
    return Math.max(0, Math.min(100, Math.round(value)))
  }, [progressInfo?.percent])

  const emitUpdateStatus = useCallback((checking: boolean, source: 'manual' | 'auto') => {
    window.dispatchEvent(new CustomEvent(UPDATE_STATUS_EVENT, { detail: { checking, source } }))
  }, [])

  const checkUpdate = useCallback(async (source: 'manual' | 'auto' = 'manual') => {
    setChecking(true)
    emitUpdateStatus(true, source)
    setUpdateError(undefined)
    setUpdateAvailable(false)
    setVersionInfo(undefined)
    setProgressInfo(undefined)
    setDownloadStatus('idle')
    setManualDownloadError(undefined)
    setManualDownloadPath(undefined)
    resetModalBtn()
    try {
      /**
       * @type {import('electron-updater').UpdateCheckResult | null | { message: string, error: Error }}
       */
      const result = await window.ipcRenderer.invoke('check-update')

      if (source === 'manual') {
        setModalOpen(true)
      }
      if (result?.error) {
        const message = result?.message ?? result?.error?.message
        if (source === 'auto' && message === 'The update feature is only available after the package.') {
          return
        }
        setUpdateError(result?.error)
      }
    } finally {
      setChecking(false)
      emitUpdateStatus(false, source)
    }
  }, [emitUpdateStatus, resetModalBtn])

  const onUpdateCanAvailable = useCallback((_event: Electron.IpcRendererEvent, arg1: VersionInfo) => {
    setVersionInfo(arg1)
    setUpdateError(undefined)
    setDownloadStatus('idle')
    // Can be update
    if (arg1.update) {
      setModalBtn(state => ({
        ...state,
        cancelText: t('common:action.cancel'),
        okText: t('common:update.start_download'),
        onCancel: () => setModalOpen(false),
        onOk: handleStartDownload,
      }))
      setUpdateAvailable(true)
      setModalOpen(true)
    } else {
      setUpdateAvailable(false)
      resetModalBtn()
    }
  }, [handleStartDownload, resetModalBtn, t])

  const onUpdateError = useCallback((_event: Electron.IpcRendererEvent, arg1: ErrorType) => {
    setUpdateAvailable(false)
    setUpdateError(arg1)
    setDownloadStatus('idle')
    resetModalBtn()
    setModalOpen(true)
  }, [resetModalBtn])

  const onDownloadProgress = useCallback((_event: Electron.IpcRendererEvent, arg1: ProgressInfo) => {
    setProgressInfo(arg1)
    setDownloadStatus('downloading')
  }, [])

  const onUpdateDownloaded = useCallback((_event: Electron.IpcRendererEvent) => {
    setProgressInfo({ percent: 100 })
    setModalBtn(state => ({
      ...state,
      cancelText: t('common:update.later'),
      okText: t('common:update.install_now'),
      onCancel: () => setModalOpen(false),
      onOk: () => window.ipcRenderer.invoke('quit-and-install'),
    }))
    setDownloadStatus('downloaded')
    setModalOpen(true)
  }, [t])

  useEffect(() => {
    // Get version information and whether to update
    window.ipcRenderer.on('update-can-available', onUpdateCanAvailable)
    window.ipcRenderer.on('update-error', onUpdateError)
    window.ipcRenderer.on('download-progress', onDownloadProgress)
    window.ipcRenderer.on('update-downloaded', onUpdateDownloaded)

    const manualCheckHandler = () => {
      void checkUpdate('manual')
    }
    window.addEventListener(manualTriggerEvent, manualCheckHandler)

    let autoCheckTimer: number | undefined
    if (autoCheck) {
      autoCheckTimer = window.setTimeout(() => {
        void checkUpdate('auto')
      }, autoCheckDelay)
    }

    return () => {
      window.removeEventListener(manualTriggerEvent, manualCheckHandler)
      if (autoCheckTimer) {
        window.clearTimeout(autoCheckTimer)
      }
      window.ipcRenderer.off('update-can-available', onUpdateCanAvailable)
      window.ipcRenderer.off('update-error', onUpdateError)
      window.ipcRenderer.off('download-progress', onDownloadProgress)
      window.ipcRenderer.off('update-downloaded', onUpdateDownloaded)
    }
  }, [
    autoCheck,
    autoCheckDelay,
    checkUpdate,
    manualTriggerEvent,
    onDownloadProgress,
    onUpdateCanAvailable,
    onUpdateDownloaded,
    onUpdateError,
  ])

  return (
    <>
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MonitorUp className="w-5 h-5 text-primary" />
              {t('common:update.title')}
            </DialogTitle>
          </DialogHeader>
          <div className="py-4">
            {updateError ? (
              <div className="space-y-4">
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>{t('common:update.error_title')}</AlertTitle>
                  <AlertDescription className="mt-2 break-all whitespace-pre-wrap">
                    {updateError.message}
                  </AlertDescription>
                </Alert>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button asChild variant="outline" className="flex-1 gap-2">
                    <a href={RELEASES_URL} target="_blank" rel="noreferrer">
                      <DownloadCloud className="w-4 h-4" />
                      {t('common:update.open_releases')}
                    </a>
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1 gap-2"
                    onClick={handleManualDownload}
                    disabled={manualDownloading}
                  >
                    <FolderDown className="w-4 h-4" />
                    {manualDownloading
                      ? t('common:update.downloading_package')
                      : t('common:update.download_package')}
                  </Button>
                </div>
                {manualDownloadError && (
                  <p className="text-sm text-destructive wrap-break-word whitespace-pre-wrap">
                    {manualDownloadError}
                  </p>
                )}
                {manualDownloadPath && (
                  <p className="text-sm text-muted-foreground wrap-break-word whitespace-pre-wrap">
                    {t('common:update.manual_download_saved', { path: manualDownloadPath })}
                  </p>
                )}
              </div>
            ) : updateAvailable ? (
              <div className="space-y-6">
                <div className="flex items-center justify-between rounded-lg border bg-card p-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium leading-none">
                      {t('common:update.available_title', { version: versionInfo?.newVersion ?? '-' })}
                    </p>
                    <p className="text-sm text-muted-foreground flex items-center gap-2">
                      <span className="font-mono bg-muted px-1.5 py-0.5 rounded text-xs">{versionInfo?.version ?? '-'}</span>
                      <ArrowRight className="w-3 h-3" />
                      <span className="font-mono bg-primary/10 text-primary px-1.5 py-0.5 rounded text-xs font-semibold">{versionInfo?.newVersion ?? '-'}</span>
                    </p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button asChild variant="outline" className="flex-1 gap-2">
                      <a href={RELEASES_URL} target="_blank" rel="noreferrer">
                        <DownloadCloud className="w-4 h-4" />
                        {t('common:update.open_releases')}
                      </a>
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1 gap-2"
                      onClick={handleManualDownload}
                      disabled={manualDownloading}
                    >
                      <FolderDown className="w-4 h-4" />
                      {manualDownloading
                        ? t('common:update.downloading_package')
                        : t('common:update.download_package')}
                    </Button>
                  </div>
                  {manualDownloadError && (
                    <p className="text-sm text-destructive wrap-break-word whitespace-pre-wrap">
                      {manualDownloadError}
                    </p>
                  )}
                  {manualDownloadPath && (
                    <p className="text-sm text-muted-foreground wrap-break-word whitespace-pre-wrap">
                      {t('common:update.manual_download_saved', { path: manualDownloadPath })}
                    </p>
                  )}
                </div>

                {downloadStatus !== 'idle' && (
                  <div className="space-y-2 bg-muted/50 p-4 rounded-lg">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-muted-foreground">
                        {downloadStatus === 'downloaded'
                          ? <span className="text-emerald-600 flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" />{t('common:update.downloaded')}</span>
                          : t('common:update.downloading')}
                      </span>
                      <span className="font-mono text-muted-foreground">{progressValue}%</span>
                    </div>
                    <Progress value={progressValue} className="h-2" />
                  </div>
                )}
                {downloadStatus === 'idle' && (
                  <p className="text-sm text-muted-foreground text-center">
                    {t('common:update.ready_to_download')}
                  </p>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-6 text-center space-y-4">
                <div className="w-12 h-12 rounded-full bg-emerald-100/50 dark:bg-emerald-500/10 flex items-center justify-center">
                  <CheckCircle2 className="w-6 h-6 text-emerald-600 dark:text-emerald-500" />
                </div>
                <div className="space-y-1">
                  <p className="text-base font-semibold">{t('common:update.up_to_date_title')}</p>
                  <p className="text-sm text-muted-foreground">
                    {t('common:update.up_to_date_desc', { version: versionInfo?.version ?? '-' })}
                  </p>
                </div>
                {versionInfo?.newVersion && versionInfo?.newVersion !== versionInfo?.version && (
                  <p className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
                    {t('common:update.latest_version', { version: versionInfo?.newVersion })}
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter className="sm:justify-end gap-2">
            {modalBtn?.cancelText && (
              <Button variant="outline" onClick={modalBtn?.onCancel}>
                {modalBtn?.cancelText}
              </Button>
            )}
            <Button onClick={modalBtn?.onOk}>
              {modalBtn?.okText ?? t('common:action.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {showTrigger ? (
        <button disabled={checking} onClick={() => checkUpdate('manual')}>
          {checking ? checkingText : triggerText}
        </button>
      ) : null}
    </>
  )
}

export default Update
