import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { KnowledgeErrorCode, LibrarySnapshot, TranslationKnowledgeApi } from '@/translation-knowledge/ipc-contract';
import { entrySummary } from '@/translation-knowledge/ipc-contract';
import type { Diagnostic } from '@/translation-knowledge/validation';
import { ErrorNotice, Pagination } from './Controls';
import { KnowledgeRecordDialog } from './KnowledgeRecordDialog';
import { KnowledgeDisclosure } from './KnowledgeDisclosure';
import { PAGE_SIZE } from './model';
import { batchReviewReason, selectedReviewEntries, type BatchReviewAction } from './batch-review';

export function BatchReviewDialog({ initial, ids, action, api, blocked, onSnapshot, onComplete, onClose }: {
  initial: LibrarySnapshot; ids: string[]; action: BatchReviewAction; api: TranslationKnowledgeApi; blocked: boolean;
  onSnapshot: (snapshot: LibrarySnapshot) => void;
  onComplete: (snapshot: LibrarySnapshot, count: number, remainingIds: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('knowledge');
  // The reviewed generation and target identities remain frozen while this dialog is open.
  const [snapshot, setSnapshot] = useState(initial);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<KnowledgeErrorCode | 'unexpected' | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const inFlight = useRef(false);
  const entries = selectedReviewEntries(snapshot, ids);
  const eligible = entries.filter(entry => !batchReviewReason(entry, snapshot, action));
  const targets = eligible.filter(entry => !excluded.includes(entry.id));
  const skipped = entries.length - eligible.length;
  const safePage = Math.min(page, Math.max(0, Math.ceil(entries.length / PAGE_SIZE) - 1));
  const submit = async () => {
    if (inFlight.current || blocked || stale || !targets.length) return;
    inFlight.current = true; setPending(true); setError(null); setDiagnostics([]);
    const targetIds = targets.map(entry => entry.id);
    try {
      const result = await api.reviewEntries({ generation: snapshot.generation, ids: targetIds, action });
      if (!result.ok) {
        setError(result.error); setDiagnostics(result.diagnostics ?? []);
        if (result.error === 'revision_conflict' || result.error === 'not_found') setStale(true);
        return;
      }
      onComplete(result.value, targetIds.length, ids.filter(id => !targetIds.includes(id)));
    } catch { setError('unexpected'); }
    finally { inFlight.current = false; setPending(false); }
  };
  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true);
    try {
      const result = await api.read();
      if (!result.ok) { setError(result.error); setDiagnostics(result.diagnostics ?? []); return; }
      setSnapshot(result.value); onSnapshot(result.value); setStale(false); setError(null); setDiagnostics([]);
    } catch { setError('unexpected'); }
    finally { inFlight.current = false; setPending(false); }
  };
  return <KnowledgeRecordDialog wide title={t(action === 'adopt' ? 'bulk_review.adopt_title' : 'bulk_review.reject_title')}
    description={t('bulk_review.preview_help')} pending={pending} onClose={onClose} error={error}
    footer={<div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      {error && <span role="alert" className="text-xs text-destructive">{t('bulk_review.failed')}</span>}
      <span className="text-xs text-muted-foreground" data-testid="knowledge-batch-target-count">{t('bulk_review.target_count', { count: targets.length })}</span>
      {stale ? <Button size="sm" disabled={pending} onClick={() => void refresh()} data-testid="knowledge-batch-refresh">{t('bulk_review.refresh')}</Button>
        : <Button size="sm" variant={action === 'reject' ? 'outline' : 'default'} disabled={pending || blocked || !targets.length}
          onClick={() => void submit()} data-testid="knowledge-batch-confirm">
          {pending ? <LoaderCircle className="animate-spin" /> : <Check />}{t(action === 'adopt' ? 'bulk_review.confirm_adopt' : 'bulk_review.confirm_reject', { count: targets.length })}
        </Button>}
    </div>}>
    <div data-testid="knowledge-batch-review" className="space-y-3">
      <p className="text-xs leading-5 text-muted-foreground">{t(action === 'adopt' ? 'bulk_review.adopt_help' : 'bulk_review.reject_help')}</p>
      {skipped > 0 && <p role="status" className="text-xs leading-5 text-muted-foreground">{t('bulk_review.skipped', { count: skipped })}</p>}
      {entries.length < ids.length && <p role="status" className="text-xs text-muted-foreground">{t('bulk_review.changed', { count: ids.length - entries.length })}</p>}
      {/* Errors precede the potentially long list and the recovery action is in the fixed footer. */}
      <ErrorNotice error={stale && (error === 'revision_conflict' || error === 'not_found') ? null : error} diagnostics={diagnostics} />
      {stale && <p role="alert" className="rounded-md border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">{t('bulk_review.stale')}</p>}
      <div className="space-y-2">
        {entries.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE).map(entry => {
          const reason = batchReviewReason(entry, snapshot, action);
          return <div key={entry.id} className="flex min-w-0 items-start gap-3 rounded-lg border p-3" data-batch-entry={entry.id}>
            <Checkbox className="mt-1 shrink-0" aria-label={t('bulk_review.select_entry', { title: entry.title })}
              checked={!reason && !excluded.includes(entry.id)} disabled={pending || !!reason}
              onCheckedChange={checked => setExcluded(value => checked ? value.filter(id => id !== entry.id) : [...value, entry.id])} />
            <div className="min-w-0 flex-1 space-y-1">
              {entry.kind === 'term' ? <div className="grid grid-cols-2 gap-3 text-sm"><span className="break-words font-medium">{entry.payload.source}</span><span className="whitespace-pre-wrap break-words">{entry.payload.target}</span></div>
                : <p className="whitespace-pre-wrap break-words text-sm leading-6">{entrySummary(entry)}</p>}
              <p className="break-words text-xs text-muted-foreground">{snapshot.data.collections.find(c => c.id === entry.collectionId)?.name} · {t(`kind.${entry.kind}`)}</p>
              {reason && <p className="text-xs leading-5 text-muted-foreground">{t(`bulk_review.reason_${reason}`)}</p>}
              <KnowledgeDisclosure variant="inline" title={t('bulk_review.evidence')}>
                <div className="space-y-2 text-xs leading-5 text-muted-foreground">
                  <p>{entry.scope.languagePair.source} → {entry.scope.languagePair.target}</p>
                  <p className="break-words">{entry.title}</p>
                  {entry.kind === 'term' && <p className="break-words">{entry.payload.sense}{entry.payload.aliases.length ? ` · ${entry.payload.aliases.join(' / ')}` : ''}</p>}
                  {entry.scope.requiredSubjects.map(subject => <p key={`${subject.subjectId}:${subject.role}`}>{snapshot.data.subjects.find(s => s.id === subject.subjectId)?.name} · {t(`role.${subject.role}`)}</p>)}
                  {entry.scope.condition.mode !== 'none' && <p className="break-words">{entry.scope.condition.text}</p>}
                  {entry.evidence.map((evidence, index) => { const source = snapshot.data.sources.find(s => s.id === evidence.sourceId); return <p className="whitespace-pre-wrap break-words" key={index}>{source?.title}：{source?.excerpt}</p>; })}
                </div>
              </KnowledgeDisclosure>
            </div>
          </div>;
        })}
      </div>
      {!entries.length && <p className="text-sm text-muted-foreground">{t('empty.review')}</p>}
      <Pagination page={safePage} total={entries.length} onChange={setPage} />
    </div>
  </KnowledgeRecordDialog>;
}
