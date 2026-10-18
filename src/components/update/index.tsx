import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  ScrollableDialog,
  ScrollableDialogHeader,
  ScrollableDialogContent,
  ScrollableDialogFooter,
  DialogTitle,
} from '@/components/qiuye-ui/scrollable-dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleHelp,
  Copy,
  Download,
  DownloadCloud,
  ExternalLink,
  FileText,
  Globe,
  Info,
  Loader2,
  MonitorUp,
  Power,
  RotateCcw,
  ShieldAlert,
} from 'lucide-react'
import { LATEST_RELEASE_URL, type AppUpdateError, type AppUpdateState } from '@/app-update/contract'
import { settingPath } from '@/pages/Setting/settingNavigation'
import useOnboardingStore from '@/store/useOnboardingStore'
import { showToast } from '@/utils/toast'
import { useChangelog, type ChangelogEntry } from './useChangelog'
import {
  MAC_QUARANTINE_COMMAND,
  UPDATE_HELP_PATH,
  UPDATE_MAC_HELP_PATH,
  formatUpdateBytes,
  updateErrorGuide,
  updateSourceLabel,
  type UpdateGuideAction,
} from './update-guide'

export const UPDATE_CHECK_EVENT = 'fusionkit-check-update'
export const UPDATE_STATUS_EVENT = 'fusionkit-update-status'
/** Opens the dialog on what the updater knows now (a found, downloading or downloaded version), without checking again. */
export const UPDATE_OPEN_EVENT = 'fusionkit-open-update'

/** The updater's state for other screens (the About page), or undefined until it is known. */
export function useAppUpdateState(): AppUpdateState | undefined {
  const [state, setState] = useState<AppUpdateState>()
  useEffect(() => {
    const api = window.appUpdate
    if (!api) return
    let active = true
    let pushed = false
    const stop = api.onState(next => { pushed = true; setState(next) })
    // A state pushed meanwhile is newer than the one asked for.
    void api.getState().then(next => { if (active && !pushed) setState(next) }).catch(() => undefined)
    return () => { active = false; stop() }
  }, [])
  return state
}

type UpdateProps = {
  autoCheck?: boolean
  autoCheckDelay?: number
  showTrigger?: boolean
  manualTriggerEvent?: string
  triggerLabel?: string
  checkingLabel?: string
}

/** Phases that show the new version, its changelog and what to do with it. */
const RELEASE_PHASES = new Set(['available', 'downloading', 'downloaded', 'installing'])

/**
 * The update dialog. A launch check stays quiet unless a new version is found; a check the user
 * asked for always answers, including why it failed and what to do next. On Windows the new
 * version downloads and installs in the app; on macOS the dialog links to the new DMG. What the
 * app shows by itself (a version found at launch, a download that ended) waits while the welcome
 * wizard is open, so a new user never gets two dialogs at once.
 */
const Update = ({
  autoCheck = false,
  autoCheckDelay = 1500,
  showTrigger = true,
  manualTriggerEvent = UPDATE_CHECK_EVENT,
  triggerLabel,
  checkingLabel,
}: UpdateProps) => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const api = window.appUpdate
  const [state, setState] = useState<AppUpdateState>()
  const [checking, setChecking] = useState(false)
  const [modalOpen, setModalOpen] = useState<boolean>(false)
  /** The check request itself failed (no answer from the main process). */
  const [requestError, setRequestError] = useState<AppUpdateError>()
  const phaseRef = useRef<AppUpdateState['phase'] | undefined>(undefined)
  const modalOpenRef = useRef(false)
  /** The dialog on screen was opened by the app itself, not by the user. */
  const openedByItselfRef = useRef(false)
  /** Something to show came up while the welcome wizard was open. */
  const deferredRef = useRef(false)

  useEffect(() => { modalOpenRef.current = modalOpen }, [modalOpen])

  const changeModalOpen = useCallback((open: boolean) => {
    if (!open) openedByItselfRef.current = false
    setModalOpen(open)
  }, [])

  const showByItself = useCallback(() => {
    if (useOnboardingStore.getState().open) {
      deferredRef.current = true
      return
    }
    openedByItselfRef.current = true
    setModalOpen(true)
  }, [])

  // The wizard comes first: what the app opened by itself steps aside and comes back after it.
  useEffect(() => useOnboardingStore.subscribe((next, previous) => {
    if (next.open === previous.open) return
    if (next.open) {
      if (modalOpenRef.current && openedByItselfRef.current) {
        deferredRef.current = true
        openedByItselfRef.current = false
        setModalOpen(false)
      }
    } else if (deferredRef.current) {
      deferredRef.current = false
      openedByItselfRef.current = true
      setModalOpen(true)
    }
  }), [])

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
    setRequestError(undefined)
    try {
      if (!api) throw new Error('window.appUpdate is not available')
      const result = await api.check({ manual: source === 'manual' })
      phaseRef.current = result.phase
      setState(result)
      // Launch checks stay quiet unless there is something new.
      if (source === 'manual') {
        openedByItselfRef.current = false
        setModalOpen(true)
      } else if (result.phase === 'available') {
        showByItself()
      }
    } catch (error) {
      if (source === 'manual') {
        setRequestError({ kind: 'unknown', during: 'check', mirrorsTried: false, detail: error instanceof Error ? error.message : String(error) })
        openedByItselfRef.current = false
        setModalOpen(true)
      }
    } finally {
      setChecking(false)
      emitUpdateStatus(false, source)
    }
  }, [api, emitUpdateStatus, showByItself])

  useEffect(() => {
    if (!api) return
    let active = true
    let pushed = false
    const stop = api.onState(next => {
      pushed = true
      const previous = phaseRef.current
      phaseRef.current = next.phase
      setState(next)
      // The user started this download: show how it ended even after closing the dialog.
      if (previous === 'downloading' && (next.phase === 'downloaded' || next.phase === 'error') && !modalOpenRef.current) showByItself()
    })
    // A state pushed meanwhile is newer than the one asked for.
    void api.getState().then(next => { if (active && !pushed) { phaseRef.current = next.phase; setState(next) } }).catch(() => undefined)
    return () => { active = false; stop() }
  }, [api, showByItself])

  useEffect(() => {
    const manualCheckHandler = () => {
      void checkUpdate('manual')
    }
    const openHandler = () => {
      setRequestError(undefined)
      openedByItselfRef.current = false
      setModalOpen(true)
    }
    window.addEventListener(manualTriggerEvent, manualCheckHandler)
    window.addEventListener(UPDATE_OPEN_EVENT, openHandler)

    let autoCheckTimer: number | undefined
    if (autoCheck) {
      autoCheckTimer = window.setTimeout(() => {
        void checkUpdate('auto')
      }, autoCheckDelay)
    }

    return () => {
      window.removeEventListener(manualTriggerEvent, manualCheckHandler)
      window.removeEventListener(UPDATE_OPEN_EVENT, openHandler)
      if (autoCheckTimer) {
        window.clearTimeout(autoCheckTimer)
      }
    }
  }, [autoCheck, autoCheckDelay, checkUpdate, manualTriggerEvent])

  const error = requestError ?? (state?.phase === 'error' ? state.error : undefined)
  const showRelease = !!state && !requestError && (RELEASE_PHASES.has(state.phase) || (state.phase === 'error' && state.error?.during !== 'check'))
  const {
    entries: changelogEntries,
    loading: changelogLoading,
    error: changelogError,
  } = useChangelog(state?.currentVersion, state?.latestVersion, modalOpen && showRelease, state?.downloadSourceMode)
  const mirrorDownloadUrl = requestError ? undefined : state?.manualDownload?.mirrorUrl

  const openHelp = useCallback((path: string) => {
    changeModalOpen(false)
    navigate(path)
  }, [changeModalOpen, navigate])

  const runGuideAction = useCallback((action: UpdateGuideAction, failure: AppUpdateError) => {
    if (action === 'open_network_settings') {
      changeModalOpen(false)
      navigate(settingPath('proxy'))
      return
    }
    if (action === 'open_help') {
      openHelp(UPDATE_HELP_PATH)
      return
    }
    if (action === 'open_releases') {
      window.open(state?.releaseUrl ?? LATEST_RELEASE_URL, '_blank', 'noopener,noreferrer')
      return
    }
    if (action === 'open_mirror_download') {
      if (mirrorDownloadUrl) window.open(mirrorDownloadUrl, '_blank', 'noopener,noreferrer')
      return
    }
    if (action === 'restart_app') {
      void api?.restart().then(setState)
      return
    }
    if (failure.during === 'check') void checkUpdate('manual')
    else if (failure.during === 'download') void api?.download().then(setState)
    else void api?.install().then(setState)
  }, [api, changeModalOpen, checkUpdate, mirrorDownloadUrl, navigate, openHelp, state?.releaseUrl])

  const releaseUrl = state?.releaseUrl ?? LATEST_RELEASE_URL
  const phase = requestError ? 'error' : state?.phase ?? 'idle'
  // Only one mirror vouched for this version: shown, but downloaded by hand (see AppUpdateManifestTrust).
  const manualOnly = !requestError && state?.installMode === 'in_app' && state.phase === 'available' && state.manifestTrust === 'unverified'

  return (
    <>
      <ScrollableDialog
        open={modalOpen}
        onOpenChange={changeModalOpen}
        maxWidth={showRelease && changelogEntries.length > 0 ? 'sm:max-w-[500px]' : 'sm:max-w-[440px]'}
      >
        <ScrollableDialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MonitorUp className="w-5 h-5 text-primary" />
            {t('common:update.title')}
          </DialogTitle>
        </ScrollableDialogHeader>
        <ScrollableDialogContent>
          <div data-testid="update-dialog" data-phase={phase} data-install-mode={state?.installMode} data-trust={state?.manifestTrust} className="space-y-4">
            {state?.installMode === 'unsupported' && !requestError ? (
              <div data-testid="update-dev-build" className="flex flex-col items-center justify-center py-6 text-center space-y-3">
                <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                  <Info className="w-6 h-6 text-muted-foreground" />
                </div>
                <p className="text-base font-semibold">{t('common:update.dev_title')}</p>
                <p className="text-sm text-muted-foreground max-w-[32ch]">{t('common:update.dev_desc')}</p>
              </div>
            ) : phase === 'checking' ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('common:update.checking')}
              </div>
            ) : showRelease && state ? (
              <>
                <VersionCard state={state} />
                {manualOnly && <UnverifiedUpdateNote onHelp={() => openHelp(UPDATE_HELP_PATH)} />}
                {error && <UpdateErrorGuide error={error} mirrorDownload={!!mirrorDownloadUrl} onAction={runGuideAction} />}
                {state.phase === 'downloading' && <DownloadProgress state={state} />}
                {state.phase === 'downloaded' && (
                  <div data-testid="update-downloaded" className="flex items-start gap-2.5 rounded-smooth-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5">
                    <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-medium">{t('common:update.downloaded_title')}</p>
                      <p className="text-xs leading-5 text-muted-foreground">{t('common:update.downloaded_desc')}</p>
                    </div>
                  </div>
                )}
                {state.phase === 'installing' && (
                  <div data-testid="update-installing" className="flex items-center gap-2 rounded-smooth-lg border bg-card px-3 py-2.5 text-sm text-muted-foreground">
                    <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />
                    {t('common:update.installing')}
                  </div>
                )}
                {state.installMode === 'manual' && <MacUpdateNote onHelp={() => openHelp(UPDATE_MAC_HELP_PATH)} />}
                <ChangelogSection loading={changelogLoading} entries={changelogEntries} failed={!!changelogError} t={t} />
              </>
            ) : error ? (
              <UpdateErrorGuide error={error} mirrorDownload={!!mirrorDownloadUrl} onAction={runGuideAction} />
            ) : (
              <div data-testid="update-up-to-date" className="flex flex-col items-center justify-center py-6 text-center space-y-4">
                <div className="w-12 h-12 rounded-full bg-emerald-100/50 dark:bg-emerald-500/10 flex items-center justify-center">
                  <CheckCircle2 className="w-6 h-6 text-emerald-600 dark:text-emerald-500" />
                </div>
                <div className="space-y-1">
                  <p className="text-base font-semibold">{t('common:update.up_to_date_title')}</p>
                  <p className="text-sm text-muted-foreground">
                    {t('common:update.up_to_date_desc', { version: state?.currentVersion ?? '-' })}
                  </p>
                </div>
                {state?.latestVersion && state.latestVersion !== state.currentVersion && (
                  <p className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
                    {t('common:update.latest_version', { version: state.latestVersion })}
                  </p>
                )}
              </div>
            )}
          </div>
        </ScrollableDialogContent>
        {/* A failure brings its own next steps (retry, release page) in the guide. */}
        {showRelease && state && state.phase !== 'error' && (
          <ScrollableDialogFooter className="flex flex-wrap items-center justify-end gap-2">
            <ReleaseActions
              state={state}
              releaseUrl={releaseUrl}
              manualOnly={manualOnly}
              onCheckAgain={() => { void checkUpdate('manual') }}
              onDownload={() => { void api?.download().then(setState) }}
              onCancel={() => { void api?.cancelDownload().then(setState) }}
              onInstall={() => { void api?.install().then(setState) }}
              onLater={() => changeModalOpen(false)}
            />
          </ScrollableDialogFooter>
        )}
      </ScrollableDialog>
      {showTrigger ? (
        <button disabled={checking} onClick={() => checkUpdate('manual')}>
          {checking ? checkingText : triggerText}
        </button>
      ) : null}
    </>
  )
}

function VersionCard({ state }: { state: AppUpdateState }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between rounded-smooth-lg border bg-card p-4">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium leading-none">
          {t('common:update.available_title', { version: state.latestVersion ?? '-' })}
        </p>
        <p className="text-sm text-muted-foreground flex flex-wrap items-center gap-2">
          <span className="font-mono bg-muted px-1.5 py-0.5 rounded text-xs">{state.currentVersion}</span>
          <ArrowRight className="w-3 h-3" />
          <span className="font-mono bg-primary/10 text-primary px-1.5 py-0.5 rounded text-xs font-semibold">{state.latestVersion ?? '-'}</span>
          {state.downloadSize !== undefined && (
            <span data-testid="update-size" className="text-xs">
              {t('common:update.installer_size', { size: formatUpdateBytes(state.downloadSize) })}
            </span>
          )}
        </p>
      </div>
    </div>
  )
}

function DownloadProgress({ state }: { state: AppUpdateState }) {
  const { t } = useTranslation()
  const progress = state.progress
  const percent = Math.round(progress?.percent ?? 0)
  const total = progress?.total || state.downloadSize || 0
  const source = updateSourceLabel(state.source)
  return (
    <div data-testid="update-progress" data-percent={percent} className="space-y-2 rounded-smooth-lg border bg-card px-3 py-3">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="flex min-w-0 items-center gap-2">
          <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          <span className="truncate">{t('common:update.downloading')}</span>
        </span>
        <span className="font-mono text-xs tabular-nums">{percent}%</span>
      </div>
      <Progress value={percent} aria-label={t('common:update.progress')} />
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <span>
          {total > 0
            ? t('common:update.transferred', { done: formatUpdateBytes(progress?.transferred ?? 0), total: formatUpdateBytes(total) })
            : formatUpdateBytes(progress?.transferred ?? 0)}
        </span>
        {(progress?.bytesPerSecond ?? 0) > 0 && (
          <span>{t('common:update.speed', { speed: formatUpdateBytes(progress!.bytesPerSecond) })}</span>
        )}
      </div>
      <p data-testid="update-source" data-source={state.source} className="text-xs text-muted-foreground">
        {t(source.key, { host: source.host })}
      </p>
    </div>
  )
}

function ReleaseActions({ state, releaseUrl, manualOnly, onCheckAgain, onDownload, onCancel, onInstall, onLater }: {
  state: AppUpdateState
  releaseUrl: string
  /** Windows, update information only one mirror vouched for: links to download by hand, no in-app download. */
  manualOnly: boolean
  onCheckAgain: () => void
  onDownload: () => void
  onCancel: () => void
  onInstall: () => void
  onLater: () => void
}) {
  const { t } = useTranslation()
  const releaseLink = (
    <Button asChild variant="ghost" size="sm" className="mr-auto gap-1.5 text-muted-foreground">
      <a href={releaseUrl} target="_blank" rel="noreferrer" data-testid="update-open-releases">
        <ExternalLink className="w-3.5 h-3.5" />
        {t('common:update.open_releases')}
      </a>
    </Button>
  )
  if (state.installMode === 'manual') {
    const links = state.manualDownload
    if (!links) return releaseLink
    const official = (
      <a href={links.officialUrl} target="_blank" rel="noreferrer" data-testid="update-mac-dmg">
        <Download className="w-4 h-4" />
        {t('common:update.mac_download')}
      </a>
    )
    const mirror = links.mirrorUrl ? (
      <a href={links.mirrorUrl} target="_blank" rel="noreferrer" data-testid="update-mac-mirror">
        <Globe className="w-4 h-4" />
        {t('common:update.mac_download_mirror')}
      </a>
    ) : null
    // "Mirror first" puts the mirror link in front.
    const mirrorFirst = state.downloadSourceMode === 'mirror' && mirror
    return (
      <>
        {releaseLink}
        {mirror && <Button asChild variant={mirrorFirst ? 'default' : 'outline'} size="sm" className="gap-1.5">{mirror}</Button>}
        <Button asChild variant={mirrorFirst ? 'outline' : 'default'} size="sm" className="gap-1.5">{official}</Button>
      </>
    )
  }
  if (manualOnly) {
    const mirrorUrl = state.manualDownload?.mirrorUrl
    return (
      <>
        <Button variant="ghost" size="sm" onClick={onCheckAgain} className="mr-auto gap-1.5 text-muted-foreground" data-testid="update-check-again">
          <RotateCcw className="w-3.5 h-3.5" />
          {t('common:update.check_again')}
        </Button>
        {mirrorUrl && (
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <a href={mirrorUrl} target="_blank" rel="noreferrer" data-testid="update-manual-mirror">
              <Globe className="w-4 h-4" />
              {t('common:update.open_mirror_download')}
            </a>
          </Button>
        )}
        <Button asChild size="sm" className="gap-1.5">
          <a href={releaseUrl} target="_blank" rel="noreferrer" data-testid="update-manual-releases">
            <ExternalLink className="w-4 h-4" />
            {t('common:update.open_releases')}
          </a>
        </Button>
      </>
    )
  }
  if (state.phase === 'downloading') {
    return (
      <Button variant="outline" size="sm" onClick={onCancel} data-testid="update-cancel">
        {t('common:update.cancel_download')}
      </Button>
    )
  }
  if (state.phase === 'downloaded' || state.phase === 'installing') {
    const installing = state.phase === 'installing'
    return (
      <>
        {releaseLink}
        <Button variant="outline" size="sm" onClick={onLater} disabled={installing} data-testid="update-later">
          {t('common:update.later')}
        </Button>
        <Button size="sm" className="gap-1.5" onClick={onInstall} disabled={installing} data-testid="update-install">
          {installing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
          {t('common:update.install_now')}
        </Button>
      </>
    )
  }
  return (
    <>
      {releaseLink}
      <Button size="sm" className="gap-1.5" onClick={onDownload} data-testid="update-download">
        <DownloadCloud className="w-4 h-4" />
        {t('common:update.start_download')}
      </Button>
    </>
  )
}

const GUIDE_ICONS = {
  retry: RotateCcw, open_network_settings: Globe, open_releases: ExternalLink, open_mirror_download: Download, restart_app: Power,
  open_help: CircleHelp,
} as const satisfies Record<UpdateGuideAction, unknown>
const GUIDE_LABELS = {
  retry: 'common:update.retry',
  open_network_settings: 'common:update.open_network_settings',
  open_releases: 'common:update.open_releases',
  open_mirror_download: 'common:update.open_mirror_download',
  restart_app: 'common:update.restart_app',
  open_help: 'common:update.open_help',
} as const satisfies Record<UpdateGuideAction, string>

/**
 * Windows: the update information came from one mirror only (GitHub and the other mirror did not
 * confirm it), so FusionKit does not download and run it; the footer links to the download page.
 */
function UnverifiedUpdateNote({ onHelp }: { onHelp: () => void }) {
  const { t } = useTranslation()
  return (
    <div data-testid="update-unverified" role="status" className="flex items-start gap-2 rounded-smooth-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs leading-5 text-amber-800 dark:text-amber-300">
      <ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{t('common:update.unverified_title')}</p>
        <p className="[overflow-wrap:anywhere]">{t('common:update.unverified_cause')}</p>
        <p className="text-amber-700/90 dark:text-amber-300/85 [overflow-wrap:anywhere]">{t('common:update.unverified_next')}</p>
        <Button type="button" variant="outline" size="xs" onClick={onHelp} className="bg-background/80 text-foreground" data-testid="update-unverified-help">
          <CircleHelp />{t('common:update.open_help')}
        </Button>
      </div>
    </div>
  )
}

/** macOS: how to replace the app, and the one command for "is damaged", ready to copy. */
function MacUpdateNote({ onHelp }: { onHelp: () => void }) {
  const { t } = useTranslation()
  const copy = () => {
    navigator.clipboard.writeText(MAC_QUARANTINE_COMMAND)
      .then(() => showToast(t('common:update.mac_command_copied'), 'success'))
      .catch(() => showToast(t('common:error.copy_failed'), 'error'))
  }
  return (
    <div data-testid="update-mac-note" className="flex items-start gap-2 rounded-smooth-lg border bg-muted/30 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
      <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="[overflow-wrap:anywhere]">{t('common:update.mac_note')}</p>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <code data-testid="update-mac-command" className="min-w-0 select-all rounded-smooth-md bg-muted px-2 py-1 font-mono text-[11px] leading-4 text-foreground [overflow-wrap:anywhere]">
            {MAC_QUARANTINE_COMMAND}
          </code>
          <Button type="button" variant="ghost" size="xs" onClick={copy} className="text-muted-foreground" data-testid="update-mac-copy">
            <Copy />{t('common:update.mac_copy_command')}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={onHelp} className="text-muted-foreground" data-testid="update-mac-help">
            <CircleHelp />{t('common:update.open_help')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Why the update failed, what to do next (with buttons), and the technical detail to copy. */
function UpdateErrorGuide({ error, mirrorDownload, onAction }: {
  error: AppUpdateError
  mirrorDownload: boolean
  onAction: (action: UpdateGuideAction, error: AppUpdateError) => void
}) {
  const { t } = useTranslation()
  const guide = updateErrorGuide(error, { mirrorDownload })
  const copy = () => {
    navigator.clipboard.writeText(error.detail)
      .then(() => showToast(t('common:update.details_copied'), 'success'))
      .catch(() => showToast(t('common:error.copy_failed'), 'error'))
  }
  return (
    <div
      role="alert"
      data-testid="update-error-guide"
      data-kind={error.kind}
      data-during={error.during}
      className="flex min-w-0 items-start gap-2 rounded-smooth-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs leading-5 text-amber-800 dark:text-amber-300"
    >
      <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm font-medium">{t(guide.titleKey)}</p>
        <p className="font-medium [overflow-wrap:anywhere]">{t(guide.causeKey)}</p>
        <p className="text-amber-700/90 dark:text-amber-300/85 [overflow-wrap:anywhere]">{t(guide.nextKey)}</p>
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {guide.actions.map(action => {
            const Icon = GUIDE_ICONS[action]
            return (
              <Button key={action} type="button" variant="outline" size="xs" data-action={action} onClick={() => onAction(action, error)}
                className="bg-background/80 text-foreground">
                <Icon />{t(GUIDE_LABELS[action])}
              </Button>
            )
          })}
        </div>
        {error.detail && (
          <details data-testid="update-error-detail" className="group pt-0.5 text-muted-foreground">
            <summary className="cursor-pointer select-none text-[11px] leading-4 hover:text-foreground">{t('common:update.details')}</summary>
            <div className="mt-1.5 space-y-1.5">
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-smooth-md bg-muted px-2 py-1.5 font-mono text-[11px] leading-4 [overflow-wrap:anywhere]">{error.detail}</pre>
              <Button type="button" variant="ghost" size="xs" onClick={copy} className="text-muted-foreground">
                <Copy />{t('common:update.copy_details')}
              </Button>
            </div>
          </details>
        )}
      </div>
    </div>
  )
}

function ChangelogSection({ loading, entries, failed, t }: {
  loading: boolean
  entries: ChangelogEntry[]
  failed: boolean
  t: (key: string) => string
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-3 text-sm text-muted-foreground gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('common:update.changelog_loading')}
      </div>
    )
  }

  if (entries.length === 0) {
    // Say so rather than leaving a gap where the spinner was.
    return failed
      ? <p data-testid="update-changelog-failed" className="text-xs leading-5 text-muted-foreground">{t('common:update.changelog_failed')}</p>
      : null
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
        <FileText className="w-3.5 h-3.5" />
        {t('common:update.changelog_title')}
      </p>
      <ScrollArea className="overflow-hidden rounded-smooth-lg border bg-muted/30" viewportProps={{ className: 'max-h-[240px]' }}>
        <div className="p-3 space-y-3">
          {entries.map((entry, idx) => (
            <div key={entry.version}>
              {idx > 0 && <div className="h-px bg-border mb-3" />}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-semibold bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                    v{entry.version}
                  </span>
                  <span className="text-xs text-muted-foreground">{entry.date}</span>
                </div>
                {entry.sections.map((section, sIdx) => (
                  <div key={sIdx} className="space-y-1">
                    {section.title && (
                      <p className="text-xs font-medium text-muted-foreground/80">{section.title}</p>
                    )}
                    <ul className="space-y-0.5">
                      {section.items.map((item, iIdx) => (
                        <li key={iIdx} className="text-sm flex items-start gap-1.5">
                          <span className="mt-[7px] w-1 h-1 rounded-full bg-foreground/40 shrink-0" />
                          <span className="leading-relaxed">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

export default Update
