import { useTranslation } from 'react-i18next';
import { DialogTransition } from '@/components/qiuye-ui/dialog-motion';
import type { Collection, LanguagePair } from '@/translation-knowledge/schemas';
import { Choice, LanguageField, TextField } from './Controls';
import { languagePairLabel } from './labels';

export const NEW_COLLECTION_CHOICE = 'new';
const samePair = (a: Partial<LanguagePair>, b: LanguagePair) => a.source === b.source && a.target === b.target;

/** The collection a capture starts on: the preferred one, else the only one translating the current direction. */
export function initialCaptureCollection(collections: readonly Collection[], preferredId: string | undefined, current: Partial<LanguagePair>): string {
  const preferred = collections.find(item => item.id === preferredId);
  if (preferred) return preferred.id;
  const matching = collections.filter(item => samePair(current, item.languagePair));
  if (matching.length === 1) return matching[0].id;
  return collections.length ? '' : NEW_COLLECTION_CHOICE;
}

/**
 * Where captured wordings go. An existing collection brings its own direction; a new one asks
 * for it, starting from the direction being translated.
 */
export function CaptureDestinationFields({ collections, collectionId, onCollectionChange, collectionName, onCollectionNameChange, pair, onPairChange, current }: {
  collections: readonly Collection[];
  collectionId: string;
  onCollectionChange: (id: string) => void;
  collectionName: string;
  onCollectionNameChange: (name: string) => void;
  /** The direction of a new collection. */
  pair: LanguagePair;
  onPairChange: (pair: LanguagePair) => void;
  /** The direction being translated, when known. */
  current: Partial<LanguagePair>;
}) {
  const { t } = useTranslation('materials');
  const { t: tk } = useTranslation('knowledge');
  const pairText = (value: LanguagePair) => languagePairLabel(tk, value);
  const selected = collections.find(item => item.id === collectionId);
  const mismatch = !!selected && !!current.source && !!current.target && !samePair(current, selected.languagePair);
  const creating = collectionId === NEW_COLLECTION_CHOICE;
  return <div data-testid="capture-destination">
    <Choice label={t('collection')} value={collectionId} onChange={onCollectionChange} placeholder={t('choose_collection')}
      options={[...collections.map(item => ({ value: item.id, label: `${item.name} · ${pairText(item.languagePair)}` })), { value: NEW_COLLECTION_CHOICE, label: t('new_collection') }]} />
    <DialogTransition transitionKey={mismatch ? 'mismatch' : 'match'} stageClassName="pt-2">
      {mismatch && <p role="status" data-testid="capture-direction-mismatch" className="text-xs leading-5 text-amber-700 dark:text-amber-400">
        {t('direction_mismatch', { collection: pairText(selected.languagePair), current: pairText(current as LanguagePair) })}
      </p>}
    </DialogTransition>
    <DialogTransition transitionKey={creating ? 'new' : 'existing'} stageClassName="pt-4">
      {creating && <div className="space-y-4">
        <TextField label={t('collection_name')} value={collectionName} onChange={onCollectionNameChange} required />
        <div className="grid gap-4 sm:grid-cols-2">
          <LanguageField label={t('source_language')} value={pair.source} onChange={value => onPairChange({ ...pair, source: value })} />
          <LanguageField label={t('target_language')} value={pair.target} onChange={value => onPairChange({ ...pair, target: value })} />
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{t('direction_hint')}</p>
      </div>}
    </DialogTransition>
  </div>;
}
