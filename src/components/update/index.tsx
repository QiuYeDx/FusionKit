import type { ProgressInfo } from 'electron-updater'
import { useCallback, useEffect, useState } from 'react'
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
  triggerLabel = 'Check update',
  checkingLabel = 'Checking...',
}: UpdateProps) => {
  const [checking, setChecking] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [versionInfo, setVersionInfo] = useState<VersionInfo>()
  const [updateError, setUpdateError] = useState<ErrorType>()
  const [progressInfo, setProgressInfo] = useState<Partial<ProgressInfo>>()
  const [modalOpen, setModalOpen] = useState<boolean>(false)
  const [modalBtn, setModalBtn] = useState<{
    cancelText?: string
    okText?: string
    onCancel?: () => void
    onOk?: () => void
  }>({
    cancelText: 'Close',
    okText: 'OK',
    onCancel: () => setModalOpen(false),
    onOk: () => setModalOpen(false),
  })

  const resetModalBtn = useCallback(() => {
    setModalBtn({
      cancelText: 'Close',
      okText: 'OK',
      onCancel: () => setModalOpen(false),
      onOk: () => setModalOpen(false),
    })
  }, [])

  const checkUpdate = useCallback(async (source: 'manual' | 'auto' = 'manual') => {
    setChecking(true)
    setUpdateError(undefined)
    setUpdateAvailable(false)
    setVersionInfo(undefined)
    setProgressInfo({ percent: 0 })
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
    // Can be update
    if (arg1.update) {
      setModalBtn(state => ({
        ...state,
        cancelText: 'Cancel',
        okText: 'Update',
        onOk: () => window.ipcRenderer.invoke('start-download'),
      }))
      setUpdateAvailable(true)
      setModalOpen(true)
    } else {
      setUpdateAvailable(false)
    }
  }, [])

  const onUpdateError = useCallback((_event: Electron.IpcRendererEvent, arg1: ErrorType) => {
    setUpdateAvailable(false)
    setUpdateError(arg1)
    resetModalBtn()
  }, [resetModalBtn])

  const onDownloadProgress = useCallback((_event: Electron.IpcRendererEvent, arg1: ProgressInfo) => {
    setProgressInfo(arg1)
  }, [])

  const onUpdateDownloaded = useCallback((_event: Electron.IpcRendererEvent) => {
    setProgressInfo({ percent: 100 })
    setModalBtn(state => ({
      ...state,
      cancelText: 'Later',
      okText: 'Install now',
      onOk: () => window.ipcRenderer.invoke('quit-and-install'),
    }))
    setModalOpen(true)
  }, [])

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
            <DialogTitle>Update</DialogTitle>
          </DialogHeader>
          <div className='modal-slot'>
            {updateError
              ? (
                <div>
                  <p>Error downloading the latest version.</p>
                  <p>{updateError.message}</p>
                </div>
              ) : updateAvailable
                ? (
                  <div>
                    <div>The last version is: v{versionInfo?.newVersion}</div>
                    <div className='new-version__target'>v{versionInfo?.version} -&gt; v{versionInfo?.newVersion}</div>
                    <div className='update__progress'>
                      <div className='progress__title'>Update progress:</div>
                      <div className='progress__bar'>
                        <Progress percent={progressInfo?.percent} ></Progress>
                      </div>
                    </div>
                  </div>
                )
                : (
                  <div className='can-not-available'>{JSON.stringify(versionInfo ?? {}, null, 2)}</div>
                )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={modalBtn?.onCancel}>
              {modalBtn?.cancelText}
            </Button>
            <Button onClick={modalBtn?.onOk}>
              {modalBtn?.okText}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {showTrigger ? (
        <button disabled={checking} onClick={() => checkUpdate('manual')}>
          {checking ? checkingLabel : triggerLabel}
        </button>
      ) : null}
    </>
  )
}

export default Update
