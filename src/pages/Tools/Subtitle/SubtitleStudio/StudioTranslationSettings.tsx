import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookmarkPlus, ChevronDown, History, LoaderCircle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { TranslationDraft } from '@/services/subtitle-studio/translation-draft';
import type { LibrarySnapshot } from '@/translation-knowledge/ipc-contract';

type Props = {
  previous?: TranslationDraft;
  previousModel: string;
  previousLanguage: string;
  library: LibrarySnapshot | null;
  disabled: boolean;
  canSave: boolean;
  saving: boolean;
  name: string;
  error?: string;
  onNameChange: (value: string) => void;
  onSavingChange: (value: boolean) => void;
  onReuse: () => void;
  onSave: () => void;
};

/** Reuse is an explicit replacement of general settings, never document authority. */
export function StudioTranslationSettings({ previous, previousModel, previousLanguage, library, disabled, canSave, saving, name, error, onNameChange, onSavingChange, onReuse, onSave }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wasSaving = useRef(saving);
  useEffect(() => {
    if (wasSaving.current && !saving) setOpen(false);
    wasSaving.current = saving;
  }, [saving]);
  const recipe = library?.data.recipes.find(item => item.id === previous?.selection.recipeId);
  const collections = [...new Set([...(previous?.selection.collectionIds ?? []), ...(recipe?.readCollectionIds ?? [])])];
  const names = collections.map(id => library?.data.collections.find(item => item.id === id)?.name ?? t('knowledge:automatic.removed_item'));
  if (previous?.selection.recipeId && !recipe) names.unshift(t('knowledge:automatic.removed_item'));
  return <Popover open={open} onOpenChange={next => { if (!disabled) { setOpen(next); if (!next) onSavingChange(false); } }}>
    <PopoverTrigger asChild>
      <Button data-testid="studio-translation-settings" type="button" size="sm" variant="ghost" className="shrink-0 gap-1.5 px-2 text-xs text-muted-foreground" disabled={disabled}>
        <History className="size-3.5" />{t('studio:materials.settings')}<ChevronDown className="size-3.5" />
      </Button>
    </PopoverTrigger>
    <PopoverContent data-testid="studio-translation-settings-panel" aria-label={t('studio:materials.settings')} align="end" sideOffset={8} collisionPadding={16} className="w-[360px] max-w-[calc(100vw-3rem)] max-h-[min(70vh,var(--radix-popover-content-available-height))] overflow-y-auto rounded-xl p-0 motion-reduce:animate-none">
      <div className="space-y-3 p-3">
        <div className="flex items-center gap-2 text-sm font-medium"><RotateCcw className="size-4 text-muted-foreground" />{t('studio:materials.recent_settings')}</div>
        {previous ? <>
          <p className="text-xs leading-5 text-muted-foreground">{t('studio:materials.reuse_help')}</p>
          <dl data-testid="studio-translation-reuse-summary" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg bg-muted/50 p-3 text-xs leading-5">
            <dt className="text-muted-foreground">{t('studio:translation.model')}</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{previousModel}</dd>
            <dt className="text-muted-foreground">{t('studio:translation.language')}</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{previousLanguage}</dd>
            {recipe && <><dt className="text-muted-foreground">{t('materials:selection.preset')}</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{recipe.name}</dd></>}
            <dt className="text-muted-foreground">{t('studio:materials.reuse_materials')}</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{names.length ? names.join(' · ') : t('studio:materials.reuse_without_materials')}</dd>
          </dl>
          <Button data-testid="studio-translation-reuse" type="button" size="sm" variant="outline" className="w-full" disabled={disabled} onClick={() => { onReuse(); setOpen(false); onSavingChange(false); }}><RotateCcw />{t('studio:materials.reuse')}</Button>
        </> : <p className="text-xs leading-5 text-muted-foreground">{t('studio:materials.no_recent_settings')}</p>}
      </div>
      <div className="space-y-3 border-t p-3">
        {saving ? <>
          <label className="block space-y-2 text-xs font-medium">
            <span>{t('studio:materials.recipe_name')}</span>
            <Input data-testid="studio-translation-recipe-name" value={name} maxLength={160} className="h-8 text-sm" disabled={disabled} onChange={event => onNameChange(event.target.value)} placeholder={t('studio:materials.recipe_name')} autoFocus />
          </label>
          <p className="text-xs leading-5 text-muted-foreground">{t('studio:materials.recipe_help')}</p>
          {error && <p role="alert" className="text-xs leading-5 text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => onSavingChange(false)}>{t('studio:cancel')}</Button>
            <Button data-testid="studio-translation-confirm-recipe" type="button" size="sm" disabled={disabled || !canSave || !name.trim()} onClick={onSave}>{disabled ? <LoaderCircle className="animate-spin" /> : <BookmarkPlus />}{t('knowledge:actions.save')}</Button>
          </div>
        </> : <>
          <Button data-testid="studio-translation-save-recipe" type="button" size="sm" variant="ghost" className="h-auto w-full justify-start whitespace-normal px-2 py-2 text-left" disabled={disabled || !canSave} onClick={() => onSavingChange(true)}><BookmarkPlus />{t('studio:materials.save_recipe')}</Button>
          {!canSave && <p className="text-xs leading-5 text-muted-foreground">{t('studio:materials.save_requires_materials')}</p>}
        </>}
      </div>
    </PopoverContent>
  </Popover>;
}
