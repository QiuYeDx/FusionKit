import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, BookOpen, ChevronDown, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function UsageGuide({ empty, reviewCount, disabled, onStart, onReview }: {
  empty: boolean;
  reviewCount: number;
  disabled: boolean;
  onStart: () => void;
  onReview: () => void;
}) {
  const { t } = useTranslation('knowledge');
  const [expanded, setExpanded] = useState(empty);
  return <section data-testid="knowledge-guide" className="min-w-0 rounded-lg border bg-muted/20 p-3">
    <div className="flex min-w-0 items-start gap-2">
      <BookOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-1">
        <h2 className="text-sm font-medium">{t('guide.title')}</h2>
        <p className="text-xs leading-5 text-muted-foreground">{t('guide.control')}</p>
      </div>
    </div>
    <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)} className="mt-2">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium [&::-webkit-details-marker]:hidden">
        {t('guide.how')}<ChevronDown aria-hidden className={`size-3.5 ${expanded ? 'rotate-180' : ''}`} />
      </summary>
      <ol className="mt-3 grid gap-3 text-xs leading-5 lg:grid-cols-3">
        <li><p className="font-medium">{t('guide.organize')}</p><p className="mt-1 text-muted-foreground">{t('guide.organize_help')}</p></li>
        <li><p className="font-medium">{t('guide.approve')}</p><p className="mt-1 text-muted-foreground">{t('guide.approve_help')}</p></li>
        <li><p className="font-medium">{t('guide.use')}</p><p className="mt-1 text-muted-foreground">{t('guide.use_help')}</p></li>
      </ol>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('guide.supported')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button data-testid="knowledge-get-started" size="sm" disabled={disabled} onClick={onStart}><Plus />{t('guide.add_term')}</Button>
        {reviewCount > 0 && <Button size="sm" variant="outline" onClick={onReview}>{t('guide.review', { count: reviewCount })}</Button>}
        <Button asChild size="sm" variant="outline"><Link to="/tools/subtitle/studio">{t('guide.translate')}<ArrowRight /></Link></Button>
      </div>
    </details>
  </section>;
}
