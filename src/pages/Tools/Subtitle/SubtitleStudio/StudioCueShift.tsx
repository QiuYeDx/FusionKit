import { useEffect, useId, useRef, useState } from 'react';
import { Clock3, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollableDialog, ScrollableDialogHeader, ScrollableDialogContent, ScrollableDialogFooter, DialogTitle, DialogDescription } from '@/components/qiuye-ui/scrollable-dialog';
import type { DocumentPage } from '@/subtitle-studio/ipc-contract';
import { formatStudioTime } from './StudioControls';

type Cue = DocumentPage['cues'][number];

/** Times of the cues moved by `deltaMs`, or why they cannot move. */
export function shiftedTimes(cues: readonly Cue[], deltaMs: number, previousStart?: number, nextStart?: number) {
  const changes: Record<string, { startMs: number; endMs: number | null }> = {};
  for (const cue of cues) {
    const startMs = cue.timing.startMs + deltaMs;
    const endMs = cue.timing.endMs === null ? null : cue.timing.endMs + deltaMs;
    if (startMs < 0) return { problem: 'negative' as const };
    changes[cue.id] = { startMs, endMs };
  }
  const first = changes[cues[0].id].startMs, last = changes[cues.at(-1)!.id].startMs;
  if (previousStart !== undefined && first < previousStart && cues[0].timing.startMs >= previousStart) return { problem: 'before_previous' as const };
  if (nextStart !== undefined && last > nextStart && cues.at(-1)!.timing.startMs <= nextStart) return { problem: 'after_next' as const };
  return { changes };
}

/** Moves the selected cues earlier or later by the same amount, as one edit. */
export function StudioCueShift({ cues, previousStart, nextStart, open, busy, onClose, onShift }: {
  cues: readonly Cue[];
  previousStart?: number;
  nextStart?: number;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onShift: (changes: Record<string, { startMs: number; endMs: number | null }>) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [value, setValue] = useState('0');
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setValue('0'); setSaving(false); } }, [open]);
  const delta = /^\s*[+-]?\d{1,9}\s*$/.test(value) ? Number(value) : null;
  const result = delta === null || !cues.length ? null : shiftedTimes(cues, delta, previousStart, nextStart);
  const problem = delta === null ? 'invalid' : result && 'problem' in result ? result.problem : null;
  const firstChange = result && 'changes' in result && cues[0] ? result.changes![cues[0].id] : undefined;
  const apply = async () => {
    if (!result || !('changes' in result) || !delta || saving) return;
    setSaving(true);
    const ok = await onShift(result.changes!);
    setSaving(false);
    if (ok) onClose();
  };
  return <ScrollableDialog open={open} onOpenChange={next => { if (!next && !saving) onClose(); }} maxWidth="sm:max-w-[420px]"
    onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); input.current?.select(); }}>
    <ScrollableDialogHeader className="p-3 pr-12">
      <DialogTitle className="flex items-center gap-2 text-base"><Clock3 className="size-4" />{t('studio:cue_structure.shift_title')}</DialogTitle>
      <DialogDescription className="text-xs leading-5">{t('studio:cue_structure.shift_description', { count: cues.length })}</DialogDescription>
    </ScrollableDialogHeader>
    <ScrollableDialogContent className="p-3" fadeMaskHeight={12}>
      <label htmlFor={`${id}-delta`} className="mb-1.5 block text-xs font-medium">{t('studio:cue_structure.shift_label')}</label>
      <Input ref={input} id={`${id}-delta`} data-testid="studio-cue-shift-delta" inputMode="numeric" className="h-8 font-mono text-sm" value={value} aria-invalid={!!problem && value.trim() !== '' || undefined}
        onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void apply(); } }} />
      <p className={problem && value.trim() ? 'mt-2 text-xs text-destructive' : 'mt-2 text-xs text-muted-foreground'} role={problem ? 'alert' : undefined} data-testid="studio-cue-shift-preview">
        {problem ? t(`studio:cue_structure.shift_${problem}`)
          : firstChange && cues[0] ? t('studio:cue_structure.shift_preview', { from: formatStudioTime(cues[0].timing.startMs), to: formatStudioTime(firstChange.startMs), count: cues.length }) : ''}
      </p>
    </ScrollableDialogContent>
    <ScrollableDialogFooter className="flex justify-end gap-2 p-3">
      <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>{t('studio:cancel')}</Button>
      <Button size="sm" data-testid="studio-cue-shift-apply" disabled={busy || saving || !!problem || !delta} onClick={() => void apply()}>
        {saving ? <LoaderCircle className="studio-spin" /> : <Clock3 />}{t('studio:cue_structure.shift_apply')}
      </Button>
    </ScrollableDialogFooter>
  </ScrollableDialog>;
}
