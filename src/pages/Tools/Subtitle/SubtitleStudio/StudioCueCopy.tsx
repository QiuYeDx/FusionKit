import { useState } from 'react';
import { Check, Clock3, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { SubtitleCue, SubtitleText } from '@/subtitle-studio/domain';
import { buildCueCopyText, type CueCopyMode } from '@/services/subtitle-studio/cue-copy';
import './StudioCueCopy.css';

const copyLabels = {
  source: 'studio:copy_options.source',
  target: 'studio:copy_options.target',
  bilingual: 'studio:copy_options.bilingual',
} as const;

export function StudioCueCopy({ cue, translation, copied, onCopy }: {
  cue: Pick<SubtitleCue, 'source' | 'timing' | 'sourceRevision'>;
  translation?: { text: SubtitleText; sourceRevision: number };
  copied: boolean;
  onCopy: (text: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hasTarget = !!translation?.text.plain.trim();
  const stale = hasTarget && translation?.sourceRevision !== cue.sourceRevision;
  const copy = (mode: CueCopyMode, timing: boolean) => {
    const text = buildCueCopyText({ source: cue.source.plain, target: translation?.text.plain, ...cue.timing }, mode, timing);
    if (text !== null) void onCopy(text);
  };
  const choices = (timing: boolean) => (Object.keys(copyLabels) as CueCopyMode[]).map(mode =>
    <DropdownMenuItem key={mode} disabled={mode !== 'source' && !hasTarget} onSelect={() => copy(mode, timing)}>
      {timing ? <Clock3 /> : <Copy />}{t(copyLabels[mode])}
    </DropdownMenuItem>);
  return <DropdownMenu open={open} onOpenChange={setOpen}>
    <Tooltip delayDuration={350} open={open ? false : undefined}>
      <TooltipTrigger asChild><DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" className={copied ? 'studio-copy is-copied text-emerald-600 dark:text-emerald-400' : 'studio-copy text-muted-foreground'} aria-label={t('studio:copy_options.choose')}>
          {copied ? <Check /> : <Copy />}
        </Button>
      </DropdownMenuTrigger></TooltipTrigger>
      <TooltipContent sideOffset={6}>{t(copied ? 'studio:copied' : 'studio:copy_options.choose')}</TooltipContent>
    </Tooltip>
    <DropdownMenuContent align="end" data-testid="studio-copy-menu" className="studio-copy-menu">
      {choices(false)}
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger><Clock3 />{t('studio:copy_options.with_time')}</DropdownMenuSubTrigger>
        <DropdownMenuPortal><DropdownMenuSubContent className="studio-copy-menu" data-testid="studio-copy-timed-menu">
          {choices(true)}
          {cue.timing.endMs === null && <p className="studio-copy-hint">{t('studio:copy_options.start_only')}</p>}
        </DropdownMenuSubContent></DropdownMenuPortal>
      </DropdownMenuSub>
      {(!hasTarget || stale) && <><DropdownMenuSeparator /><p className="studio-copy-hint" role="note">{t(stale ? 'studio:copy_options.stale' : 'studio:copy_options.no_translation')}</p></>}
    </DropdownMenuContent>
  </DropdownMenu>;
}
