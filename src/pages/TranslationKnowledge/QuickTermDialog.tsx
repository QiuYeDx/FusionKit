import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { Collection, Entry, LanguagePair, Source } from '@/translation-knowledge/schemas';
import type { KnowledgeErrorCode, LibrarySnapshot } from '@/translation-knowledge/ipc-contract';
import { knowledgeSelectionSchema } from '@/translation-knowledge/execution-contract';
import { Choice, ErrorNotice, KnowledgeDialog, LanguageField, TextField } from './Controls';

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
  return props.open ? <QuickTermForm {...props} /> : null;
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
  const [error, setError] = useState<KnowledgeErrorCode | 'unexpected' | 'required' | null>(null);
  const operation = useRef(false);
  const entryId = useRef(crypto.randomUUID());
  const sourceId = useRef(crypto.randomUUID());
  const newCollectionId = useRef(crypto.randomUUID());
  const mounted = useRef(true);
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
      if (!initialLanguagePair && preferred?.defaultLanguagePair) setPair(preferred.defaultLanguagePair);
    }).catch(() => { if (active) setError('unexpected'); });
    return () => { active = false; mounted.current = false; };
  }, []);
  const collections = snapshot?.data.collections.filter(item => !item.archived) ?? [];
  const matchingTerms = snapshot?.data.entries.filter(entry => entry.kind === 'term'
    && entry.state !== 'archived' && entry.state !== 'rejected'
    && entry.collectionId === collectionId
    && entry.scope.languagePair.source === pair.source && entry.scope.languagePair.target === pair.target
    && entry.payload.source === source.trim()) ?? [];
  const duplicate = matchingTerms.some(entry => entry.kind === 'term' && entry.payload.target === target.trim());
  const chooseCollection = (id: string) => {
    setCollectionId(id);
    const selected = collections.find(item => item.id === id);
    if (selected?.defaultLanguagePair) setPair(selected.defaultLanguagePair);
  };
  const valid = !!snapshot && !!source.trim() && !!target.trim() && knowledgeSelectionSchema.shape.languagePair.safeParse(pair).success
    && (collectionId === 'new' ? !!collectionName.trim() : collections.some(item => item.id === collectionId))
    && !duplicate && !snapshot.maintenance?.cleanupPending;
  const save = async () => {
    if (operation.current || !valid || !snapshot) return;
    operation.current = true; setPending(true); setError(null);
    let latest = snapshot;
    try {
      // Reconcile uncertain writes before retrying with stable entity IDs.
      const refreshed = await window.translationKnowledge.read();
      if (!refreshed.ok) { setError(refreshed.error); return; }
      latest = refreshed.value;
      if (mounted.current) setSnapshot(latest);
      const alreadySaved = latest.data.entries.find(item => item.id === entryId.current);
      if (alreadySaved) {
        if (alreadySaved.kind !== 'term' || alreadySaved.payload.source !== source.trim() || alreadySaved.payload.target !== target.trim()
          || alreadySaved.scope.languagePair.source !== pair.source || alreadySaved.scope.languagePair.target !== pair.target
          || alreadySaved.collectionId !== (collectionId === 'new' ? newCollectionId.current : collectionId)
          || alreadySaved.state !== 'ready' || latest.approvals[alreadySaved.id]?.revision !== alreadySaved.revision) {
          if (mounted.current) setError('revision_conflict');
          return;
        }
        onSaved?.(latest, alreadySaved.collectionId);
        if (mounted.current) onOpenChange(false);
        toast.success(t('saved'));
        return;
      }
      let destinationId = collectionId;
      if (destinationId === 'new') {
        const existing = latest.data.collections.find(item => item.id === newCollectionId.current);
        if (existing) destinationId = existing.id;
        else {
          const collection: Collection = { id: newCollectionId.current, revision: 1, archived: false, name: collectionName.trim(), description: '', aboutSubjectIds: [], defaultLanguagePair: pair };
          const result = await window.translationKnowledge.saveRecord({ generation: latest.generation, group: 'collections', record: collection });
          if (!result.ok) { setError(result.error); return; }
          latest = result.value; destinationId = collection.id;
        }
        // A subsequent term failure must reuse this collection on retry.
        if (mounted.current) { setSnapshot(latest); setCollectionId(destinationId); }
      }
      const evidence: Source = { id: sourceId.current, revision: 1, kind: 'user_note', title: t('source_note'), excerpt: `${source.trim()} → ${target.trim()}` };
      const entry: Entry = {
        id: entryId.current, revision: 1, title: source.trim().slice(0, 120), kind: 'term',
        collectionId: destinationId, aboutSubjectIds: [], state: 'ready',
        scope: { languagePair: pair, requiredSubjects: [], condition: { mode: 'none' } },
        evidence: [{ sourceId: evidence.id, support: 'direct' }], derivedFrom: [],
        payload: { source: source.trim(), target: target.trim(), aliases: [], sense: '', match: { mode: 'literal_phrase', caseSensitive: true }, strength: 'preferred' },
      };
      const result = await window.translationKnowledge.saveRecord({ generation: latest.generation, group: 'entries', record: entry, source: evidence, adopt: true });
      if (!result.ok) {
        if (mounted.current) setError(result.error);
        if (result.error === 'revision_conflict') {
          const refreshed = await window.translationKnowledge.read();
          if (mounted.current && refreshed.ok) setSnapshot(refreshed.value);
        }
        return;
      }
      toast.success(t('saved'));
      onSaved?.(result.value, destinationId);
      if (mounted.current) onOpenChange(false);
    } catch { if (mounted.current) setError('unexpected'); }
    finally { operation.current = false; if (mounted.current) setPending(false); }
  };
  return <KnowledgeDialog title={t('title')} description={t('description')} pending={pending} onClose={() => onOpenChange(false)} footer={
    <Button data-testid="quick-term-save" size="sm" disabled={!valid || pending} onClick={() => void save()}>{pending ? <LoaderCircle className="size-4 animate-spin" /> : <BookOpen className="size-4" />}{t('save')}</Button>
  }>
    <div data-testid="quick-term-form" className="space-y-4">
      <ErrorNotice error={error} />
      {!snapshot && !error && <p role="status" className="text-xs text-muted-foreground">{t('loading')}</p>}
      <fieldset disabled={pending || !snapshot} className="space-y-4 disabled:opacity-60">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label={t('source')} value={source} onChange={setSource} required />
          <TextField label={t('target')} value={target} onChange={setTarget} required />
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{t('boundary_hint')}</p>
        <Choice label={t('collection')} value={collectionId} onChange={chooseCollection} options={[...collections.map(item => ({ value: item.id, label: item.name })), { value: 'new', label: t('new_collection') }]} />
        {collectionId === 'new' && <TextField label={t('collection_name')} value={collectionName} onChange={setCollectionName} required />}
        <div className="grid gap-4 sm:grid-cols-2">
          <LanguageField label={t('source_language')} value={pair.source} onChange={value => setPair(current => ({ ...current, source: value }))} />
          <LanguageField label={t('target_language')} value={pair.target} onChange={value => setPair(current => ({ ...current, target: value }))} />
        </div>
      </fieldset>
      {duplicate ? <p role="status" className="text-xs leading-5 text-muted-foreground">{t('duplicate')}</p> : !!matchingTerms.length && <p role="status" className="text-xs leading-5 text-amber-700 dark:text-amber-400">{t('conflict')}</p>}
      <p className="text-xs leading-5 text-muted-foreground">{t('future_hint')}</p>
    </div>
  </KnowledgeDialog>;
}
