import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, History, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { TranslationDraft } from '@/services/subtitle-studio/translation-draft';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';

type Props = {
  previous?: TranslationDraft;
  previousModel: string;
  previousLanguage: string;
  library: LibrarySnapshot | null;
  disabled: boolean;
  onReuse: () => void;
};

/** Reuse is an explicit replacement of general settings, never document authority. */
export function StudioTranslationSettings({ previous, previousModel, previousLanguage, library, disabled, onReuse }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const names = (previous?.selection.collectionIds ?? []).map(id => library?.data.collections.find(item => item.id === id)?.name ?? t('knowledge:automatic.removed_item'));
  return <Popover open={open} onOpenChange={next => { if (!disabled) setOpen(next); }}>
    <PopoverTrigger asChild>
      <Button data-testid="studio-translation-settings" type="button" size="sm" variant="ghost" className="shrink-0 gap-1.5 px-2 text-xs text-muted-foreground" disabled={disabled}>
        <History className="size-3.5" />{t('studio:materials.settings')}<ChevronDown className="size-3.5" />
      </Button>
    </PopoverTrigger>
    <PopoverContent data-testid="studio-translation-settings-panel" aria-label={t('studio:materials.settings')} align="end" sideOffset={8} collisionPadding={16} className="w-[360px] max-w-[calc(100vw-3rem)] max-h-[min(70vh,var(--radix-popover-content-available-height))] overflow-y-auto rounded-smooth-xl p-0 motion-reduce:animate-none">
      <div className="space-y-3 p-3">
        <div className="flex items-center gap-2 text-sm font-medium"><RotateCcw className="size-4 text-muted-foreground" />{t('studio:materials.recent_settings')}</div>
        {previous ? <>
          <p className="text-xs leading-5 text-muted-foreground">{t('studio:materials.reuse_help')}</p>
          <dl data-testid="studio-translation-reuse-summary" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-smooth-lg bg-muted/50 p-3 text-xs leading-5">
            <dt className="text-muted-foreground">{t('studio:translation.model')}</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{previousModel}</dd>
            <dt className="text-muted-foreground">{t('studio:translation.language')}</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{previousLanguage}</dd>
            <dt className="text-muted-foreground">{t('studio:materials.reuse_materials')}</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{names.length ? names.join(' · ') : t('studio:materials.reuse_without_materials')}</dd>
          </dl>
          <Button data-testid="studio-translation-reuse" type="button" size="sm" variant="outline" className="w-full" disabled={disabled} onClick={() => { onReuse(); setOpen(false); }}><RotateCcw />{t('studio:materials.reuse')}</Button>
        </> : <p className="text-xs leading-5 text-muted-foreground">{t('studio:materials.no_recent_settings')}</p>}
      </div>
    </PopoverContent>
  </Popover>;
}
