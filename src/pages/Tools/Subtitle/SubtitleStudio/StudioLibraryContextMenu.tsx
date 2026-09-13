import { createPortal } from 'react-dom';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, Download, Languages, Play, Square, Trash2 } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { DocumentSummary } from '@/subtitle-studio/ipc-contract';

export type LibraryContextAction = 'translate' | 'export' | 'source' | 'resume' | 'cancel' | 'delete';
export type LibraryContextScope = { documents: DocumentSummary[]; x: number; y: number; origin: HTMLElement; query: unknown; offset: number };
export type LibraryDialogRequest = { original?: boolean; restoreFocus: () => void };

export function restoreLibraryFocus(origin: HTMLElement) {
  const fallback = document.querySelector<HTMLElement>('[data-testid="studio-library-search"]') ?? document.getElementById('studio-library-trigger');
  const target = [origin, fallback].find(item => item?.isConnected && item.getClientRects().length && !item.matches(':disabled'));
  target?.focus({ preventScroll: true });
}

export function StudioLibraryContextMenu({ scope, disabled, onClose, onAction }: {
  scope: LibraryContextScope | null; disabled: boolean; onClose: () => void;
  onAction: (action: LibraryContextAction, scope: LibraryContextScope) => void;
}) {
  const { t } = useTranslation();
  const handingOff = useRef(false);
  const outside = useRef(false);
  const receipt = useRef(scope);
  if (scope && scope !== receipt.current) { receipt.current = scope; handingOff.current = false; outside.current = false; }
  const current = scope ?? receipt.current;
  const targets = current?.documents ?? [];
  const act = (action: LibraryContextAction) => {
    if (!scope || disabled) return;
    handingOff.current = true; onAction(action, scope);
  };
  return <DropdownMenu open={!!scope} modal={false} onOpenChange={open => { if (!open) onClose(); }}>
    {createPortal(<DropdownMenuTrigger tabIndex={-1} aria-label={t('studio:library.context_actions')}
      style={{ position: 'fixed', left: current?.x ?? 0, top: current?.y ?? 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none' }} />, document.body)}
    <DropdownMenuContent align="start" side="bottom" sideOffset={2} collisionPadding={8} className="w-52" data-testid="studio-library-context-menu"
      onInteractOutside={() => { outside.current = true; }}
      onCloseAutoFocus={event => { event.preventDefault(); if (!handingOff.current && !outside.current && current) restoreLibraryFocus(current.origin); }}>
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t('studio:library.context_count', { count: targets.length })}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={disabled || !targets.some(doc => doc.capabilities.translate && doc.cueCount > 0)} onSelect={() => act('translate')}><Languages />{t('studio:translation.action')}</DropdownMenuItem>
      <DropdownMenuItem disabled={disabled} onSelect={() => act('export')}><Download />{t('studio:export.action')}</DropdownMenuItem>
      {targets.every(doc => doc.capabilities.preserveSource) && <DropdownMenuItem disabled={disabled} onSelect={() => act('source')}><ArrowDownToLine />{t('studio:export_source')}</DropdownMenuItem>}
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={disabled || !targets.some(doc => doc.task && ['failed', 'interrupted', 'needs_configuration'].includes(doc.task.status))} onSelect={() => act('resume')}><Play />{t('studio:translation.resume')}</DropdownMenuItem>
      <DropdownMenuItem disabled={disabled || !targets.some(doc => doc.task && ['queued', 'running', 'failed', 'interrupted', 'needs_configuration'].includes(doc.task.status))} onSelect={() => act('cancel')}><Square />{t('studio:translation.cancel_task')}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={disabled} variant="destructive" onSelect={() => act('delete')}><Trash2 />{t('studio:delete_document')}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
