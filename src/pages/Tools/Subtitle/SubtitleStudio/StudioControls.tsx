import { type ComponentProps, type ReactNode, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LIMITS } from '@/subtitle-studio/domain';

export function StudioFileName({ name, focusable = false }: { name: string; focusable?: boolean }) {
  const characters = Array.from(name);
  const tailLength = Math.min(12, Math.ceil(characters.length / 2));
  return <Tooltip delayDuration={350}>
    <TooltipTrigger asChild>
      <span className="studio-file-name" tabIndex={focusable ? 0 : undefined}>
        <span className="sr-only">{name}</span>
        <span aria-hidden="true" className="studio-file-name-start">{characters.slice(0, -tailLength).join('')}</span>
        <span aria-hidden="true" className="studio-file-name-end">{characters.slice(-tailLength).join('')}</span>
      </span>
    </TooltipTrigger>
    <TooltipContent sideOffset={6} className="w-max max-w-[min(20rem,calc(100vw-2rem))] whitespace-normal break-normal text-wrap [overflow-wrap:anywhere]">{name}</TooltipContent>
  </Tooltip>;
}

export function StudioIconButton({ label, children, ...props }: ComponentProps<typeof Button> & { label: string; children: ReactNode }) {
  return <Tooltip delayDuration={350}>
    <TooltipTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={label} {...props}>{children}</Button></TooltipTrigger>
    <TooltipContent sideOffset={6}>{label}</TooltipContent>
  </Tooltip>;
}

export function StudioPagination({ offset, total, busy, onChange, compact = false }: {
  offset: number; total: number; busy: boolean; onChange: (offset: number) => void; compact?: boolean;
}) {
  const { t } = useTranslation();
  const current = Math.floor(offset / LIMITS.pageSize) + 1;
  const pages = Math.max(1, Math.ceil(total / LIMITS.pageSize));
  const [draft, setDraft] = useState(String(current));
  useEffect(() => setDraft(String(current)), [current]);
  const commit = () => {
    const requested = Number(draft);
    if (Number.isInteger(requested) && requested >= 1 && requested <= pages && requested !== current) {
      onChange((requested - 1) * LIMITS.pageSize);
    }
    setDraft(String(current));
  };
  return <div className="studio-pagination">
    {!compact && <span className="studio-range">{total ? offset + 1 : 0}–{Math.min(offset + LIMITS.pageSize, total)} <span>/ {total.toLocaleString()}</span></span>}
    <div className="studio-page-controls">
      <StudioIconButton label={t('studio:previous')} disabled={busy || offset === 0} onClick={() => onChange(Math.max(0, offset - LIMITS.pageSize))}><ChevronLeft /></StudioIconButton>
      {pages > 1 && <form onSubmit={event => { event.preventDefault(); commit(); }} className="studio-page-jump">
        <input aria-label={t('studio:page_number')} type="number" min={1} max={pages} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} onBlur={() => setDraft(String(current))} />
        <span>/ {pages}</span>
      </form>}
      <StudioIconButton label={t('studio:next')} disabled={busy || offset + LIMITS.pageSize >= total} onClick={() => onChange(offset + LIMITS.pageSize)}><ChevronRight /></StudioIconButton>
    </div>
  </div>;
}

export function formatStudioTime(ms: number): string {
  const value = Math.abs(ms);
  return `${ms < 0 ? '-' : ''}${String(Math.floor(value / 3600000)).padStart(2, '0')}:${String(Math.floor(value / 60000) % 60).padStart(2, '0')}:${String(Math.floor(value / 1000) % 60).padStart(2, '0')}.${String(value % 1000).padStart(3, '0')}`;
}
