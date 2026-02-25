import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CheckCircle2, AlertCircle, DownloadCloud, MonitorUp, ArrowRight } from 'lucide-react'

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
  const [modalOpen, setModalOpen] = useState<boolean>(false)

  const triggerText = useMemo(() => {
    return triggerLabel ?? t('common:action.check_update')
  }, [t, triggerLabel])

  const checkingText = useMemo(() => {
    return checkingLabel ?? t('common:update.checking')
  }, [t, checkingLabel])

  const emitUpdateStatus = useCallback((checking: boolean, source: 'manual' | 'auto') => {
    window.dispatchEvent(new CustomEvent(UPDATE_STATUS_EVENT, { detail: { checking, source } }))
  }, [])

  const checkUpdate = useCallback(async (source: 'manual' | 'auto' = 'manual') => {
    setChecking(true)
    emitUpdateStatus(true, source)
    setUpdateError(undefined)
    setUpdateAvailable(false)
    setVersionInfo(undefined)
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
  }, [emitUpdateStatus])

  const onUpdateCanAvailable = useCallback((_event: Electron.IpcRendererEvent, arg1: VersionInfo) => {
    setVersionInfo(arg1)
    setUpdateError(undefined)
    if (arg1.update) {
      setUpdateAvailable(true)
      setModalOpen(true)
    } else {
      setUpdateAvailable(false)
    }
  }, [])

  const onUpdateError = useCallback((_event: Electron.IpcRendererEvent, arg1: ErrorType) => {
    setUpdateAvailable(false)
    setUpdateError(arg1)
    setModalOpen(true)
  }, [])

  useEffect(() => {
    window.ipcRenderer.on('update-can-available', onUpdateCanAvailable)
    window.ipcRenderer.on('update-error', onUpdateError)

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
    }
  }, [
    autoCheck,
    autoCheckDelay,
    checkUpdate,
    manualTriggerEvent,
    onUpdateCanAvailable,
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
                <Button asChild variant="outline" className="w-full gap-2">
                  <a href={RELEASES_URL} target="_blank" rel="noreferrer">
                    <DownloadCloud className="w-4 h-4" />
                    {t('common:update.open_releases')}
                  </a>
                </Button>
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
                <Button asChild variant="outline" className="w-full gap-2">
                  <a href={RELEASES_URL} target="_blank" rel="noreferrer">
                    <DownloadCloud className="w-4 h-4" />
                    {t('common:update.open_releases')}
                  </a>
                </Button>
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
          <DialogFooter className="sm:justify-end">
            <Button onClick={() => setModalOpen(false)}>
              {t('common:action.close')}
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
