import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { DialogTransition } from '@/components/qiuye-ui/dialog-motion';
import { useTranslation } from 'react-i18next';
import { BookOpen, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { LanguagePair } from '@/translation-knowledge/schemas';
import type { KnowledgeErrorCode, LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import { knowledgeSelectionSchema } from '@/translation-knowledge/execution-contract';
import { announceKnowledgeChange } from '@/translation-knowledge/library-events';
import type { ProposalBasis } from '@/translation-knowledge/proposal';
import { Choice, ErrorNotice, KnowledgeDialog, LanguageField, TextField } from './Controls';
import { captureProposal, captureRows, captureStatuses, type CaptureDestination, type CaptureRow } from './capture';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wordings: readonly { source: string; target: string; note?: string }[];
  languagePair?: Partial<LanguagePair>;
  preferredCollectionId?: string;
  /** Where the wordings come from; user_revision is the user's own applied revision. */
  basis?: ProposalBasis;
  /** A short quote kept as evidence, such as the revision request. */
  evidence?: string;
  onSaved?: (snapshot: LibrarySnapshot, collectionId: string) => void;
};

/** Keeps several wordings at once. A fresh form per invocation; saving never changes a running task. */
export function KnowledgeCaptureDialog(props: Props) {
  return <AnimatePresence>{props.open && <CaptureForm key="knowledge-capture" {...props} />}</AnimatePresence>;
}

function CaptureForm({ onOpenChange, wordings, languagePair, preferredCollectionId, basis = 'user_revision', evidence, onSaved }: Props) {
  const { t } = useTranslation('materials');
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [rows, setRows] = useState<CaptureRow[]>(() => captureRows(wordings));
  const [collectionId, setCollectionId] = useState('');
  const [collectionName, setCollectionName] = useState('');
  const [pair, setPair] = useState<LanguagePair>({ source: languagePair?.source ?? '', target: languagePair?.target ?? '' });
  const [adopt, setAdopt] = useState(basis === 'user_stated' || basis === 'user_revision');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<KnowledgeErrorCode | 'unexpected' | null>(null);
  const operation = useRef(false);
  const ids = useRef<Record<string, string>>({});
  const mounted = useRef(true);
  const initialized = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void window.translationKnowledge.read().then(result => {
      if (!active) return;
      if (!result.ok) { setError(result.error); return; }
      setSnapshot(result.value);
      const collections = result.value.data.collections.filter(item => !item.archived);
      const preferred = collections.find(item => item.id === preferredCollectionId) ?? (collections.length === 1 ? collections[0] : undefined);
      setCollectionId(preferred?.id ?? (collections.length ? '' : 'new'));
      if (preferred?.defaultLanguagePair) setPair(current => ({ source: current.source || preferred.defaultLanguagePair!.source, target: current.target || preferred.defaultLanguagePair!.target }));
    }).catch(() => { if (active) setError('unexpected'); });
    return () => { active = false; mounted.current = false; };
  }, []);
  const collections = snapshot?.data.collections.filter(item => !item.archived) ?? [];
  const destination: CaptureDestination | null = collectionId === 'new' ? (collectionName.trim() ? { newCollectionName: collectionName.trim() } : null)
    : collections.some(item => item.id === collectionId) ? { collectionId } : null;
  const pairValid = knowledgeSelectionSchema.shape.languagePair.safeParse(pair).success && !!pair.source && !!pair.target;
  const statuses = useMemo(() => snapshot && destination && pairValid ? captureStatuses(rows, snapshot, destination, pair) : rows.map(() => undefined),
    [snapshot, rows, JSON.stringify(destination), pair.source, pair.target, pairValid]);
  // Rows already in the chosen collection start unchosen; the user decides the rest.
  useEffect(() => {
    if (initialized.current || !snapshot || !destination || !pairValid) return;
    initialized.current = true;
    setRows(current => current.map((row, index) => statuses[index]?.kind === 'exists' ? { ...row, selected: false } : row));
  }, [statuses]);
  const chosen = rows.filter((row, index) => row.selected && statuses[index]?.kind !== 'exists');
  const valid = !!snapshot && !!destination && pairValid && chosen.length > 0 && chosen.every(row => row.source.trim() && row.target.trim())
    && !snapshot.maintenance?.cleanupPending;
  const chooseCollection = (id: string) => {
    setCollectionId(id);
    const selected = collections.find(item => item.id === id);
    if (selected?.defaultLanguagePair) setPair(selected.defaultLanguagePair);
  };
  const update = (key: string, change: Partial<CaptureRow>) => setRows(current => current.map(row => row.key === key ? { ...row, ...change } : row));
  const save = async () => {
    if (operation.current || !valid || !destination) return;
    operation.current = true; setPending(true); setError(null);
    try {
      const refreshed = await window.translationKnowledge.read();
      if (!refreshed.ok) { setError(refreshed.error); return; }
      const latest = refreshed.value;
      if (mounted.current) setSnapshot(latest);
      const proposal = captureProposal(rows.filter((row, index) => statuses[index]?.kind !== 'exists'), latest, destination, pair,
        { basis, evidence, ids: ids.current, sourceTitles: { user_revision: t('capture.source_revision'), user_stated: t('source_note') } });
      ids.current = proposal.ids;
      if (proposal.items.some(item => item.status === 'invalid')) { setError('invalid_input'); return; }
      const destinationId = proposal.collectionIds[0] ?? ('collectionId' in destination ? destination.collectionId : '');
      if (!proposal.nothingToSave) {
        const result = await window.translationKnowledge.saveRecords(proposal.request(adopt, latest.generation));
        if (!result.ok) {
          if (mounted.current) setError(result.error);
          if (result.error === 'revision_conflict') {
            const again = await window.translationKnowledge.read();
            if (mounted.current && again.ok) setSnapshot(again.value);
          }
          return;
        }
        announceKnowledgeChange(result.value);
        onSaved?.(result.value, destinationId);
      } else onSaved?.(latest, destinationId);
      toast.success(proposal.nothingToSave ? t('capture.nothing') : t('capture.saved', { count: proposal.counts.created }));
      if (mounted.current) onOpenChange(false);
    } catch { if (mounted.current) setError('unexpected'); }
    finally { operation.current = false; if (mounted.current) setPending(false); }
  };
  const statusText = (index: number) => {
    const status = statuses[index];
    if (!status || status.kind === 'new') return null;
    if (status.kind === 'exists') return <span className="text-muted-foreground">{t('capture.status_exists')}</span>;
    if (status.kind === 'conflict') return <span className="text-amber-700 dark:text-amber-400">{t('capture.status_conflict', { collection: status.collectionName, target: status.target })}</span>;
    return rows[index].selected ? <span className="text-destructive">{t('capture.status_invalid')}</span> : null;
  };
  return <KnowledgeDialog wide title={t('capture.title')} description={t('capture.description')} pending={pending} onClose={() => onOpenChange(false)} footer={
    <Button data-testid="knowledge-capture-save" size="sm" disabled={!valid || pending} onClick={() => void save()}>
      {pending ? <LoaderCircle className="size-4 animate-spin" /> : <BookOpen className="size-4" />}{t('capture.save', { count: chosen.length })}
    </Button>
  }>
    <div data-testid="knowledge-capture-form">
      <ErrorNotice error={error} stageClassName="pb-4" />
      <DialogTransition transitionKey={!snapshot && !error ? 'loading' : 'ready'} stageClassName="pb-4">{!snapshot && !error && <p role="status" className="text-xs text-muted-foreground">{t('loading')}</p>}</DialogTransition>
      <fieldset disabled={pending || !snapshot} className="space-y-4 disabled:opacity-60">
        <div className="space-y-1.5">
          <div aria-hidden className="grid grid-cols-[1.25rem_1fr] gap-x-2 text-xs text-muted-foreground sm:grid-cols-[1.25rem_1fr_1fr]">
            <span /><span>{t('source')}</span><span className="hidden sm:block">{t('target')}</span>
          </div>
          <ul className="space-y-2" data-testid="knowledge-capture-rows">
            {rows.map((row, index) => {
              const exists = statuses[index]?.kind === 'exists';
              return <li key={row.key} data-testid="knowledge-capture-row" data-status={statuses[index]?.kind ?? 'pending'}
                className={cn('grid grid-cols-[1.25rem_1fr] items-start gap-x-2 gap-y-1.5 sm:grid-cols-[1.25rem_1fr_1fr]', exists && 'opacity-70')}>
                <Checkbox className="mt-2.5" aria-label={t('capture.choose', { source: row.source })} checked={row.selected && !exists} disabled={exists}
                  onCheckedChange={checked => update(row.key, { selected: checked === true })} />
                <Input aria-label={t('source')} value={row.source} onChange={event => update(row.key, { source: event.target.value })} />
                <Input aria-label={t('target')} className="col-start-2 sm:col-start-auto" value={row.target} onChange={event => update(row.key, { target: event.target.value })} />
                {statusText(index) && <p className="text-xs leading-5 [grid-column:2/-1] [overflow-wrap:anywhere]">{statusText(index)}</p>}
              </li>;
            })}
          </ul>
        </div>
        <div>
          <Choice label={t('collection')} value={collectionId} onChange={chooseCollection} options={[...collections.map(item => ({ value: item.id, label: item.name })), { value: 'new', label: t('new_collection') }]} />
          <DialogTransition transitionKey={collectionId === 'new' ? 'new' : 'existing'} stageClassName="pt-4">{collectionId === 'new' && <TextField label={t('collection_name')} value={collectionName} onChange={setCollectionName} required />}</DialogTransition>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <LanguageField label={t('source_language')} value={pair.source} onChange={value => setPair(current => ({ ...current, source: value }))} />
          <LanguageField label={t('target_language')} value={pair.target} onChange={value => setPair(current => ({ ...current, target: value }))} />
        </div>
        <div className="flex items-start gap-2.5">
          <Switch id="knowledge-capture-adopt" checked={adopt} onCheckedChange={setAdopt} className="mt-0.5" />
          <label htmlFor="knowledge-capture-adopt" className="min-w-0 cursor-pointer text-sm leading-5">
            <span className="block">{t('capture.adopt')}</span>
            <span className="block text-xs text-muted-foreground">{adopt ? t('capture.adopt_on') : t('capture.adopt_off')}</span>
          </label>
        </div>
      </fieldset>
    </div>
  </KnowledgeDialog>;
}
