import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { DialogTransition } from '@/components/qiuye-ui/dialog-motion';
import { useTranslation } from 'react-i18next';
import { BookOpen, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { LanguagePair } from '@/translation-knowledge/schemas';
import type { KnowledgeErrorCode, LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import { knowledgeSelectionSchema } from '@/translation-knowledge/execution-contract';
import { announceKnowledgeChange } from '@/translation-knowledge/library-events';
import { ErrorNotice, KnowledgeDialog, TextField } from './Controls';
import { CaptureDestinationFields, initialCaptureCollection, NEW_COLLECTION_CHOICE } from './CaptureDestinationFields';
import { captureCollectionId, captureProposal, captureStatuses, type CaptureDestination, type CaptureRow } from './capture';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSource?: string;
  initialTarget?: string;
  initialLanguagePair?: LanguagePair;
  preferredCollectionId?: string;
  onSaved?: (snapshot: LibrarySnapshot, collectionId: string) => void;
};

/** A fresh form per explicit invocation. Saving never changes a running task. */
export function QuickTermDialog(props: Props) {
  return <AnimatePresence>{props.open && <QuickTermForm key="quick-term" {...props} />}</AnimatePresence>;
}

function QuickTermForm({ onOpenChange, initialSource = '', initialTarget = '', initialLanguagePair, preferredCollectionId, onSaved }: Props) {
  const { t, i18n } = useTranslation('materials');
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [collectionId, setCollectionId] = useState('');
  const [collectionName, setCollectionName] = useState('');
  const [source, setSource] = useState(initialSource);
  const [target, setTarget] = useState(initialTarget);
  const [pair, setPair] = useState<LanguagePair>(initialLanguagePair ?? {
    source: '', target: i18n.resolvedLanguage === 'zh' ? 'zh-Hans' : i18n.resolvedLanguage ?? 'zh-Hans',
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<KnowledgeErrorCode | 'unexpected' | null>(null);
  const operation = useRef(false);
  // Kept across attempts so a retry after an uncertain write rebuilds the same records.
  const ids = useRef<Record<string, string>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void window.translationKnowledge.read().then(result => {
      if (!active) return;
      if (!result.ok) { setError(result.error); return; }
      setSnapshot(result.value);
      setCollectionId(initialCaptureCollection(result.value.data.collections.filter(item => !item.archived), preferredCollectionId, initialLanguagePair ?? {}));
    }).catch(() => { if (active) setError('unexpected'); });
    return () => { active = false; mounted.current = false; };
  }, []);
  const collections = snapshot?.data.collections.filter(item => !item.archived) ?? [];
  const selected = collections.find(item => item.id === collectionId);
  const destination: CaptureDestination | null = collectionId === NEW_COLLECTION_CHOICE
    ? (collectionName.trim() ? { newCollectionName: collectionName.trim() } : null) : selected ? { collectionId } : null;
  // A new collection takes the chosen direction; an existing one keeps its own.
  const destinationPair = selected?.languagePair ?? pair;
  const pairValid = knowledgeSelectionSchema.shape.languagePair.safeParse(destinationPair).success;
  const rows: CaptureRow[] = useMemo(() => [{ key: 'term', source, target, selected: true }], [source, target]);
  const status = snapshot && destination && pairValid && source.trim() && target.trim()
    ? captureStatuses(rows, snapshot, destination, destinationPair)[0] : undefined;
  const valid = !!status && (status.kind === 'new' || status.kind === 'conflict');
  const save = async () => {
    if (operation.current || !valid || !destination) return;
    operation.current = true; setPending(true); setError(null);
    try {
      const refreshed = await window.translationKnowledge.read();
      if (!refreshed.ok) { setError(refreshed.error); return; }
      const latest = refreshed.value;
      if (mounted.current) setSnapshot(latest);
      const proposal = captureProposal(rows, latest, destination, destinationPair,
        { basis: 'user_stated', evidence: `${source.trim()} → ${target.trim()}`, ids: ids.current });
      ids.current = proposal.ids;
      if (!proposal.saveable && !proposal.nothingToSave) { setError('invalid_input'); return; }
      let saved = latest;
      if (proposal.saveable) {
        const result = await window.translationKnowledge.saveRecords(proposal.request(latest.generation));
        if (!result.ok) {
          if (mounted.current) setError(result.error);
          if (result.error === 'revision_conflict') {
            const again = await window.translationKnowledge.read();
            if (mounted.current && again.ok) setSnapshot(again.value);
          }
          return;
        }
        saved = result.value;
        announceKnowledgeChange(saved);
      }
      toast.success(t('saved'));
      onSaved?.(saved, captureCollectionId(proposal, saved, destination) ?? '');
      if (mounted.current) onOpenChange(false);
    } catch { if (mounted.current) setError('unexpected'); }
    finally { operation.current = false; if (mounted.current) setPending(false); }
  };
  return <KnowledgeDialog title={t('title')} description={t('description')} pending={pending} onClose={() => onOpenChange(false)} footer={
    <Button data-testid="quick-term-save" size="sm" disabled={!valid || pending} onClick={() => void save()}>{pending ? <LoaderCircle className="size-4 animate-spin" /> : <BookOpen className="size-4" />}{t('save')}</Button>
  }>
    <div data-testid="quick-term-form">
      <ErrorNotice error={error} stageClassName="pb-4" />
      <DialogTransition transitionKey={!snapshot && !error ? 'loading' : 'ready'} stageClassName="pb-4">{!snapshot && !error && <p role="status" className="text-xs text-muted-foreground">{t('loading')}</p>}</DialogTransition>
      <fieldset disabled={pending || !snapshot} className="space-y-4 disabled:opacity-60">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label={t('source')} value={source} onChange={setSource} required />
          <TextField label={t('target')} value={target} onChange={setTarget} required />
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{t('boundary_hint')}</p>
        <CaptureDestinationFields collections={collections} collectionId={collectionId} onCollectionChange={setCollectionId}
          collectionName={collectionName} onCollectionNameChange={setCollectionName} pair={pair} onPairChange={setPair} current={initialLanguagePair ?? {}} />
      </fieldset>
      <DialogTransition transitionKey={status?.kind ?? 'none'} stageClassName="pt-4">
        {status?.kind === 'exists' && <p role="status" className="text-xs leading-5 text-muted-foreground">{t('duplicate')}</p>}
        {status?.kind === 'conflict' && <p role="status" className="text-xs leading-5 text-amber-700 dark:text-amber-400">{t('conflict', { collection: status.collectionName, target: status.target })}</p>}
      </DialogTransition>
      <p className="pt-4 text-xs leading-5 text-muted-foreground">{t('future_hint')}</p>
    </div>
  </KnowledgeDialog>;
}
