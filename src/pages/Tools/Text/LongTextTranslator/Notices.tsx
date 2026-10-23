import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, CheckCheck, ChevronRight, CircleX, FileWarning, FolderOpen, Info, Settings, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ModelErrorGuide } from '@/components/model-error/ModelErrorGuide';
import type { DocumentDetail, ImportSkip, RunView, SupportedEncoding } from '@/long-text/contract';
import { unwrap } from '@/services/long-text/client';
import type { RunModel, RunModelProblem } from '@/services/long-text/model';
import { modelErrorGuide } from '@/services/ai-error-guide';
import useModelStore from '@/store/useModelStore';
import { StudioIconButton, StudioNotice } from '../../Subtitle/SubtitleStudio/StudioControls';
import { ENCODING_LABELS, ERROR_LABELS, IMPORT_SKIP_LABELS, MODEL_PROBLEM_LABELS } from './labels';
import { groupedCount, MODEL_SETTINGS_ROUTE, useLongTextPage, type TransientNotice } from './page-context';

/** At most this many notices at once (design §4.8). */
export const NOTICE_LIMIT = 3;
/** Files named in the import notice before "等 n 个". */
const LISTED_FILES = 3;
const FLASH_MS = 900;

/** Highest priority first; only the first `NOTICE_LIMIT` show. */
export const NOTICE_ORDER = ['failed', 'storage', 'interrupted', 'encoding', 'knowledge', 'model', 'import', 'large', 'journal', 'run_end', 'sample', 'exported'] as const;

type Transient<K extends TransientNotice['kind']> = Extract<TransientNotice, { kind: K }>;

/** One notice of the stack. `key` identifies what it says, so a dismissed notice stays away until that changes. */
export type NoticeItem = { key: string } & (
  | { kind: 'failed' | 'storage'; run: RunView }
  | { kind: 'interrupted'; run: RunView; done: number }
  | { kind: 'encoding'; encoding: SupportedEncoding }
  | { kind: 'knowledge'; noticeId: number | null }
  | { kind: 'model'; problem: RunModelProblem }
  | { kind: 'import'; notice: Transient<'import'> }
  | { kind: 'large'; notice: Transient<'large'> }
  | { kind: 'journal'; count: number }
  | { kind: 'run_end'; run: RunView }
  | { kind: 'sample'; stale: boolean }
  | { kind: 'exported'; notice: Transient<'exported'> }
);

/**
 * The notices of the page: run failures and endings, the encoding check, the model and materials
 * problems of the open document, and what an import or export just reported. Sorted by priority,
 * without dismissed ones, at most `limit`.
 */
export function collectNotices({ detail, runModel, transient, dismissed, limit = NOTICE_LIMIT }: {
  detail: DocumentDetail | null;
  runModel: RunModel | { problem: RunModelProblem };
  transient: readonly TransientNotice[];
  dismissed: ReadonlySet<string>;
  limit?: number;
}): NoticeItem[] {
  const items: NoticeItem[] = [];
  const run = detail?.run;
  if (detail && run) {
    const code = run.error?.code;
    if (run.status === 'failed' && code === 'storage_failed') items.push({ kind: 'storage', key: `storage:${run.id}`, run });
    else if (run.status === 'failed' && (code === 'knowledge_unavailable' || code === 'knowledge_invalid')) items.push({ kind: 'knowledge', key: `knowledge:${run.id}`, noticeId: null });
    else if (run.status === 'failed') items.push({ kind: 'failed', key: `failed:${run.id}`, run });
    if (run.status === 'interrupted') items.push({ kind: 'interrupted', key: `interrupted:${run.id}`, run, done: detail.counts.done });
    if (run.status === 'completed' && run.kind !== 'sample' && (run.deferred > 0 || run.failed > 0)) items.push({ kind: 'run_end', key: `run_end:${run.id}`, run });
    if (run.status === 'completed' && run.kind === 'sample' && detail.sample && !detail.fullRunStarted) {
      items.push({ kind: 'sample', key: `sample:${run.id}:${detail.sample.stale}`, stale: detail.sample.stale });
    }
  }
  // Imports confirm a high-confidence encoding themselves; whatever is still unconfirmed blocks runs.
  if (detail?.encoding && !detail.encoding.confirmed) items.push({ kind: 'encoding', key: `encoding:${detail.id}`, encoding: detail.encoding.name });
  if (detail && 'problem' in runModel) items.push({ kind: 'model', key: `model:${detail.id}:${runModel.problem}`, problem: runModel.problem });
  if (detail?.journalIssues) items.push({ kind: 'journal', key: `journal:${detail.id}:${detail.journalIssues}`, count: detail.journalIssues });
  for (const notice of transient) {
    const key = `notice:${notice.id}`;
    if (notice.kind === 'import') items.push({ kind: 'import', key, notice });
    else if (notice.kind === 'large') items.push({ kind: 'large', key, notice });
    else if (notice.documentId !== detail?.id) continue;
    else if (notice.kind === 'exported') items.push({ kind: 'exported', key, notice });
    else if (!items.some(item => item.kind === 'knowledge')) items.push({ kind: 'knowledge', key, noticeId: notice.id });
  }
  return items
    .filter(item => !dismissed.has(item.key))
    .sort((a, b) => NOTICE_ORDER.indexOf(a.kind) - NOTICE_ORDER.indexOf(b.kind))
    .slice(0, limit);
}

const isCjk = (language: string) => /^(zh|ja)/i.test(language);

/**
 * "a.docx（暂不支持此格式…）、ep01.srt（…）等 2 个": the first files with their reasons, in the
 * interface language's list style and parentheses.
 */
export function skippedList(items: ReadonlyArray<{ name: string; reason: string }>, more: string | null, language: string): string {
  const cjk = isCjk(language);
  const entries = items.map(item => cjk ? `${item.name}（${item.reason}）` : `${item.name} (${item.reason})`);
  if (!more) return new Intl.ListFormat(language, { type: 'conjunction' }).format(entries);
  return `${new Intl.ListFormat(language, { type: 'conjunction', style: 'narrow' }).format(entries)}${cjk ? '' : ', '}${more}`;
}

function NoticeShell({ item, tone = 'neutral', icon, children, actions, onDismiss, flash, className }: {
  item: NoticeItem; tone?: 'neutral' | 'warning' | 'error'; icon: ReactNode; children: ReactNode; actions?: ReactNode;
  onDismiss?: () => void; flash?: boolean; className?: string;
}) {
  const { t } = useTranslation('text');
  return <StudioNotice role={tone === 'neutral' ? 'status' : 'alert'} data-testid={`long-text-notice-${item.kind.replace('_', '-')}`}
    data-tone={tone} data-flash={flash || undefined} className={className ? `lt-notice ${className}` : 'lt-notice'}>
    {icon}
    <span>{children}</span>
    {actions}
    {onDismiss && <StudioIconButton label={t('notices.dismiss')} onClick={onDismiss}><X /></StudioIconButton>}
  </StudioNotice>;
}

/** The run stopped for good: the reason, the next step with its button, and the provider's own words folded away (§4.8). */
function FailedNotice({ item, run, onDismiss, onContinue }: { item: NoticeItem; run: RunView; onDismiss: () => void; onContinue: () => void }) {
  const { t } = useTranslation('text');
  const profiles = useModelStore(state => state.profiles);
  const [open, setOpen] = useState(false);
  const error = run.error;
  const category = error?.code === 'model_failed' ? error.category : undefined;
  const profile = profiles.find(candidate => candidate.id === run.model.profileId) ?? null;
  const reason = category ? t(modelErrorGuide(category, profile, 'runtime').causeKey)
    : error?.code === 'unstable_output' ? t('notices.unstable_output')
      : error ? t(ERROR_LABELS[error.code]) : null;
  const message = error?.message?.trim();
  return <StudioNotice role="alert" data-testid="long-text-notice-failed" data-tone="error" className="lt-notice lt-notice-fatal">
    <div className="lt-notice-row">
      <CircleX className="text-destructive" />
      <span className="font-medium text-destructive">{reason ? t('notices.run_failed', { reason }) : t('notices.run_failed_generic')}</span>
      <Button size="sm" variant="outline" onClick={onContinue}>{t('notices.continue')}</Button>
      <StudioIconButton label={t('notices.dismiss')} onClick={onDismiss}><X /></StudioIconButton>
    </div>
    {category && <ModelErrorGuide category={category} profile={profile} context="runtime" hideCause className="lt-notice-guide" testId="long-text-error-guide" />}
    {message && <div className="lt-notice-detail">
      <Button size="xs" variant="ghost" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <ChevronRight className="lt-notice-chevron" data-open={open || undefined} />{t('notices.provider_detail')}
      </Button>
      {open && <p className="lt-provider-message">{message}</p>}
    </div>}
  </StudioNotice>;
}

/** The notice stack above the document (design §4.8). */
export function Notices() {
  const { t, i18n } = useTranslation('text');
  const navigate = useNavigate();
  const page = useLongTextPage();
  const { notices, encodingFlash } = page;
  // Only the active document's notices show: while another one loads, the previous one is not what their buttons act on.
  const detail = page.detail && page.detail.id === page.activeId ? page.detail : null;
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [flashing, setFlashing] = useState(false);
  const encodingButton = useRef<HTMLButtonElement>(null);

  // A run refused for the unconfirmed encoding brings its notice back, flashes it and focuses "编码正确".
  useEffect(() => {
    if (!encodingFlash || !detail) return;
    const key = `encoding:${detail.id}`;
    setDismissed(set => set.has(key) ? new Set([...set].filter(item => item !== key)) : set);
    setFlashing(true);
    const focus = requestAnimationFrame(() => encodingButton.current?.focus({ preventScroll: true }));
    const timer = setTimeout(() => setFlashing(false), FLASH_MS);
    return () => { cancelAnimationFrame(focus); clearTimeout(timer); };
    // Only a new request flashes; the document is read at that moment.
  }, [encodingFlash]);

  const items = collectNotices({ detail, runModel: page.runModel, transient: notices, dismissed });
  if (!items.length) return null;

  const hide = (item: NoticeItem) => {
    if (item.kind === 'import' || item.kind === 'large' || item.kind === 'exported') page.dismissNotice(item.notice.id);
    else if (item.kind === 'knowledge' && item.noticeId !== null) page.dismissNotice(item.noticeId);
    else setDismissed(set => new Set(set).add(item.key));
  };
  const continueRun = (run: RunView) => void page.start(run.kind === 'sample' ? { kind: 'sample' } : { kind: 'full' });
  const openModelSettings = () => navigate(MODEL_SETTINGS_ROUTE);
  const amber = (Icon: typeof AlertCircle) => <Icon className="text-amber-600 dark:text-amber-400" />;

  const render = (item: NoticeItem) => {
    const dismiss = () => hide(item);
    switch (item.kind) {
      case 'failed':
        return <FailedNotice key={item.key} item={item} run={item.run} onDismiss={dismiss} onContinue={() => continueRun(item.run)} />;
      case 'storage':
        return <NoticeShell key={item.key} item={item} tone="error" icon={<CircleX className="text-destructive" />} onDismiss={dismiss}
          actions={<Button size="sm" variant="ghost" onClick={() => continueRun(item.run)}>{t('notices.continue')}</Button>}>{t('notices.storage_failed')}</NoticeShell>;
      case 'interrupted':
        return <NoticeShell key={item.key} item={item} tone="warning" icon={amber(AlertCircle)} onDismiss={dismiss}
          actions={<Button size="sm" variant="ghost" onClick={() => continueRun(item.run)}>{t('notices.continue')}</Button>}>
          {t('notices.interrupted', { count: groupedCount(item.done, i18n.language) })}</NoticeShell>;
      case 'encoding':
        return <NoticeShell key={item.key} item={item} tone="warning" icon={amber(FileWarning)} onDismiss={dismiss} flash={flashing}
          actions={<>
            {detail?.source.kind === 'file' && <Button size="sm" variant="ghost" onClick={() => page.openDialog({ kind: 'encoding' })}>{t('notices.encoding_change')}</Button>}
            <Button ref={encodingButton} size="sm" variant="outline" onClick={() => void page.confirmEncoding()}>{t('notices.encoding_ok')}</Button>
          </>}>{t('notices.encoding_low', { encoding: t(ENCODING_LABELS[item.encoding]) })}</NoticeShell>;
      case 'knowledge':
        return <NoticeShell key={item.key} item={item} tone="warning" icon={amber(AlertCircle)} onDismiss={dismiss}
          actions={<Button size="sm" variant="ghost" onClick={() => page.openDialog({ kind: 'settings', intent: 'edit', focus: 'materials' })}><Settings />{t('notices.open_settings')}</Button>}>
          {t('notices.knowledge_unavailable')}</NoticeShell>;
      case 'model':
        return <NoticeShell key={item.key} item={item} tone="warning" icon={amber(AlertCircle)} onDismiss={dismiss}
          actions={<Button size="sm" variant="ghost" onClick={openModelSettings}><Settings />{t('notices.model_settings')}</Button>}>
          {item.problem === 'no_profile' ? t('notices.model_missing') : t(MODEL_PROBLEM_LABELS[item.problem])}</NoticeShell>;
      case 'import':
        return <ImportNotice key={item.key} item={item} skipped={item.notice.skipped} duplicates={item.notice.duplicates} onDismiss={dismiss} />;
      case 'large':
        return <NoticeShell key={item.key} item={item} icon={<Info className="text-muted-foreground" />}>
          {new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(item.notice.names.map(name => t('import.large', { name })))}</NoticeShell>;
      case 'journal':
        return <NoticeShell key={item.key} item={item} tone="warning" icon={amber(AlertCircle)} onDismiss={dismiss}>
          {t('notices.journal_issues', { count: item.count })}</NoticeShell>;
      case 'run_end':
        return <NoticeShell key={item.key} item={item} tone="warning" icon={amber(AlertCircle)} onDismiss={dismiss}
          actions={item.run.deferred > 0 && <Button size="sm" variant="ghost" onClick={() => continueRun(item.run)}>{t('notices.continue')}</Button>}>
          {item.run.deferred > 0 ? t('notices.deferred', { count: item.run.deferred }) : t('notices.run_done_failed', { count: item.run.failed })}</NoticeShell>;
      case 'sample':
        return <NoticeShell key={item.key} item={item} icon={<CheckCheck className="text-emerald-600 dark:text-emerald-400" />} onDismiss={dismiss}
          actions={item.stale
            ? <Button size="sm" variant="outline" onClick={() => void page.start({ kind: 'sample', resample: true })}>{t('notices.sample_again')}</Button>
            : <>
              <Button size="sm" variant="ghost" onClick={() => page.openDialog({ kind: 'settings', intent: 'edit' })}>{t('notices.adjust')}</Button>
              <Button size="sm" variant="outline" onClick={() => void page.start({ kind: 'full' })}>{t('notices.translate_all')}</Button>
            </>}>{t(item.stale ? 'notices.sample_stale' : 'notices.sample_done')}</NoticeShell>;
      case 'exported':
        return <NoticeShell key={item.key} item={item} icon={<CheckCheck className="text-emerald-600 dark:text-emerald-400" />} onDismiss={dismiss}
          actions={<Button size="sm" variant="ghost" onClick={() => void unwrap(window.longText.reveal({ documentId: item.notice.documentId, target: 'export' })).catch(page.reportError)}>
            <FolderOpen />{t('notices.reveal')}</Button>}>{t('notices.exported', { name: item.notice.name })}</NoticeShell>;
    }
  };
  return <div className="lt-notices">{items.map(render)}</div>;
}

/** Files the import left out, and files already in the list (design §2 F2). */
function ImportNotice({ item, skipped, duplicates, onDismiss }: { item: NoticeItem; skipped: readonly ImportSkip[]; duplicates: readonly string[]; onDismiss: () => void }) {
  const { t, i18n } = useTranslation('text');
  const navigate = useNavigate();
  const shown = skipped.slice(0, LISTED_FILES).map(entry => ({ name: entry.name, reason: t(IMPORT_SKIP_LABELS[entry.reason]) }));
  const more = skipped.length > LISTED_FILES ? t('import.and_more', { count: skipped.length - LISTED_FILES }) : null;
  const parts = [
    skipped.length ? t('import.skipped', { count: skipped.length, list: skippedList(shown, more, i18n.language) }) : '',
    duplicates.length ? t('import.duplicate', { name: new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(duplicates) }) : '',
  ].filter(Boolean);
  return <NoticeShell item={item} tone={skipped.length ? 'warning' : 'neutral'} onDismiss={onDismiss}
    icon={skipped.length ? <AlertCircle className="text-amber-600 dark:text-amber-400" /> : <Info className="text-muted-foreground" />}
    actions={skipped.some(entry => entry.reason === 'subtitle_file') && <Button size="sm" variant="ghost" onClick={() => navigate('/tools/subtitle/studio')}>{t('import.open_studio')}</Button>}>
    {parts.join(' ')}
  </NoticeShell>;
}
