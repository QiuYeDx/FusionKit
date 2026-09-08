import type { HTMLAttributes, ReactNode } from 'react';
import { FolderOpen, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SmoothCorners } from '@/components/qiuye-ui/smooth-corners';
import { cn } from '@/lib/utils';

type Props = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title: ReactNode;
  description: ReactNode;
  actionLabel: ReactNode;
  icon?: ReactNode;
  secondaryAction?: ReactNode;
  layout?: 'horizontal' | 'stacked';
  disabled?: boolean;
  dragging?: boolean;
  onSelect: () => void;
};

/** Shared file-picker presentation for native dialogs and file-input drop zones. */
export function ToolFilePickerSurface({ title, description, actionLabel, icon, secondaryAction, layout = 'horizontal', disabled, dragging, onSelect, className, children, ...props }: Props) {
  return <SmoothCorners
    data-slot="tool-file-picker"
    radius={18}
    smoothing={0.74}
    className={cn(
      'relative flex flex-wrap items-center gap-3 border-2 border-dashed p-3 transition-colors',
      layout === 'stacked' && 'flex-col items-stretch gap-3 text-center',
      disabled ? 'cursor-not-allowed border-border/70 opacity-60' : 'cursor-pointer',
      dragging ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
      className,
    )}
    onClick={() => { if (!disabled) onSelect(); }}
    {...props}
  >
    {children}
    <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border bg-muted/40 text-foreground/70', layout === 'stacked' && 'self-center')}>
      {icon ?? (dragging ? <FolderOpen className="h-5 w-5" /> : <Upload className="h-5 w-5" />)}
    </div>
    <div className={cn('min-w-0 flex-1', layout === 'horizontal' && 'basis-32')}>
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
    </div>
    <div className={cn('ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2', layout === 'stacked' && 'ml-0 justify-center')}>
      {secondaryAction}
      <Button variant="outline" size="sm" type="button" disabled={disabled} onClick={event => { event.preventDefault(); event.stopPropagation(); onSelect(); }}>
        <FolderOpen className="h-3.5 w-3.5" />{actionLabel}
      </Button>
    </div>
  </SmoothCorners>;
}
