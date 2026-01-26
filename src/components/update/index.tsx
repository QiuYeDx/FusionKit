import type { ProgressInfo } from 'electron-updater'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import Progress from '@/components/update/Progress'
import './update.css'

export const UPDATE_CHECK_EVENT = 'fusionkit-check-update'

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

  const triggerText = useMemo(() => {
    return triggerLabel ?? t('common:action.check_update')
  }, [t, triggerLabel])

  const checkingText = useMemo(() => {
    return checkingLabel ?? t('common:update.checking')
  }, [t, checkingLabel])

  const checkUpdate = useCallback(async (source: 'manual' | 'auto' = 'manual') => {
    setChecking(true)
    setUpdateError(undefined)
    setUpdateAvailable(false)
    setVersionInfo(undefined)
    setProgressInfo(undefined)
    setDownloadStatus('idle')
    resetModalBtn()
    /**
     * @type {import('electron-updater').UpdateCheckResult | null | { message: string, error: Error }}
     */
    const result = await window.ipcRenderer.invoke('check-update')
    setChecking(false)

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
  }, [resetModalBtn])

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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common:update.title')}</DialogTitle>
          </DialogHeader>
          <div className='modal-slot'>
          {updateError
            ? (
              <div className='space-y-2'>
                <div className='text-sm font-medium text-destructive'>{t('common:update.error_title')}</div>
                <div className='text-sm text-muted-foreground'>{updateError.message}</div>
              </div>
            ) : updateAvailable
              ? (
                <div className='space-y-2'>
                  <div className='text-sm font-medium'>
                    {t('common:update.available_title', { version: versionInfo?.newVersion ?? '-' })}
                  </div>
                  <div className='text-xs text-muted-foreground'>
                    {t('common:update.available_desc', {
                      current: versionInfo?.version ?? '-',
                      latest: versionInfo?.newVersion ?? '-',
                    })}
                  </div>
                  {downloadStatus === 'idle' ? (
                    <div className='text-xs text-muted-foreground'>{t('common:update.ready_to_download')}</div>
                  ) : (
                    <>
                      {downloadStatus === 'downloaded' ? (
                        <div className='text-xs text-emerald-600'>{t('common:update.downloaded')}</div>
                      ) : (
                        <div className='text-xs text-muted-foreground'>{t('common:update.downloading')}</div>
                      )}
                      <div className='update__progress'>
                        <div className='progress__title'>{t('common:update.progress')}:</div>
                        <div className='progress__bar'>
                          <Progress percent={progressInfo?.percent} ></Progress>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )
              : (
                <div className='space-y-2'>
                  <div className='text-sm font-medium'>{t('common:update.up_to_date_title')}</div>
                  <div className='text-sm text-muted-foreground'>
                    {t('common:update.up_to_date_desc', { version: versionInfo?.version ?? '-' })}
                  </div>
                  {versionInfo?.newVersion && versionInfo?.newVersion !== versionInfo?.version ? (
                    <div className='text-xs text-muted-foreground'>
                      {t('common:update.latest_version', { version: versionInfo?.newVersion })}
                    </div>
                  ) : null}
                </div>
              )}
          </div>
        <DialogFooter>
          {modalBtn?.cancelText ? (
            <Button variant="outline" onClick={modalBtn?.onCancel}>
              {modalBtn?.cancelText}
            </Button>
          ) : null}
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
