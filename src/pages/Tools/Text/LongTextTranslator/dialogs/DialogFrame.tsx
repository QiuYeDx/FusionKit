import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AlertCircle, Info } from 'lucide-react';
import {
  DialogTitle,
  ScrollableDialog,
  ScrollableDialogContent,
  ScrollableDialogFooter,
  ScrollableDialogHeader,
} from '@/components/qiuye-ui/scrollable-dialog';
import type { DocumentDetail } from '@/long-text/contract';
import { StudioFileName } from '../../../Subtitle/SubtitleStudio/StudioControls';
import { useLongTextPage, type PageDialog } from '../page-context';
import './dialogs.css';

export type DialogOf<K extends PageDialog['kind']> = Extract<PageDialog, { kind: K }>;

/** Studio's dialog widths (design §3.5); literal classes so Tailwind generates them. */
const WIDTHS = {
  420: 'sm:max-w-[420px]',
  520: 'sm:max-w-[520px]',
  540: 'sm:max-w-[540px]',
  560: 'sm:max-w-[560px]',
  720: 'sm:max-w-[720px]',
} as const;
export type DialogWidth = keyof typeof WIDTHS;

export interface DialogRequest<K extends PageDialog['kind']> {
  /** The request while the dialog is open. */
  request: DialogOf<K> | null;
  /** The request on screen: the open one, or the last one while the dialog closes. */
  shown: DialogOf<K> | null;
  /** The open document; while the dialog closes, the last one it showed (FK-PIT-0150). */
  detail: DocumentDetail | null;
}

/**
 * The page dialog of `kind`. `onOpen` runs during render once for every new request, to reset the
 * dialog's own state; a `back` dialog returning is the same request and keeps it. A dialog about the
 * open document (`bound`) closes when another document becomes the open one.
 */
export function useDialogRequest<K extends PageDialog['kind']>(
  kind: K,
  onOpen?: (request: DialogOf<K>, detail: DocumentDetail | null) => void,
  { bound = true }: { bound?: boolean } = {},
): DialogRequest<K> {
  const page = useLongTextPage();
  const request = page.dialog?.kind === kind ? (page.dialog as DialogOf<K>) : null;
  const [shown, setShown] = useState<DialogOf<K> | null>(null);
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const [held, setHeld] = useState<DocumentDetail | null>(null);
  if (request && request !== shown) {
    setShown(request);
    setOpenedFor(page.activeId);
    onOpen?.(request, page.detail);
  }
  if (request && page.detail !== held) setHeld(page.detail);

  const moved = !!request && bound && page.activeId !== openedFor && request === shown;
  const { closeDialog } = page;
  useEffect(() => {
    if (moved) closeDialog();
  }, [moved, closeDialog]);

  return { request, shown: request ?? shown, detail: request ? page.detail : held };
}

interface DialogFrameProps {
  open: boolean;
  width: DialogWidth;
  icon: ReactNode;
  title: string;
  /** The document the dialog is about, after the title ("导出译文 · guide.md"). */
  name?: string;
  testId: string;
  /** While true the dialog stays open: Esc, the close button and the overlay do nothing. */
  busy?: boolean;
  /** The element focused when the dialog opens (design §3.5). */
  initialFocus?: () => HTMLElement | null | undefined;
  /** Replaces returning focus to the opener, for a dialog that hands over to another one. */
  onClosed?: () => void;
  /** Wraps the sections in a form, so Enter in a field submits. */
  onSubmit?: () => void;
  /** Controls under the title that stay in place while the body scrolls. */
  toolbar?: ReactNode;
  /** The buttons; a dialog without any (the library) has no footer. */
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * The compact dialog of the page (design §3.5): `ScrollableDialog animateSize`, 12px header, body and
 * footer, a 16px fade on the scrolling body, and focus returned to the opener after closing.
 */
export function DialogFrame({ open, width, icon, title, name, testId, busy = false, initialFocus, onClosed, onSubmit, toolbar, footer, children }: DialogFrameProps) {
  const page = useLongTextPage();
  // Header and footer are items of the dialog's grid: without `min-w-0` a long document name in the
  // title would widen its column and push every section past the dialog's edge.
  const sections = <>
    <ScrollableDialogHeader className="min-w-0 p-3">
      <DialogTitle className="lt-dialog-title">
        {icon}
        <span className="lt-dialog-title-text">{title}</span>
        {name && <span className="lt-dialog-title-name"><StudioFileName name={name} /></span>}
      </DialogTitle>
      {toolbar}
    </ScrollableDialogHeader>
    <ScrollableDialogContent className="lt-dialog-content" fadeMaskHeight={16}>{children}</ScrollableDialogContent>
    {footer && <ScrollableDialogFooter className="flex min-w-0 flex-wrap items-center justify-end gap-2 p-3">{footer}</ScrollableDialogFooter>}
  </>;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit?.();
  };
  return <ScrollableDialog animateSize open={open} maxWidth={WIDTHS[width]} contentClassName="lt-dialog"
    onOpenChange={next => { if (!next && !busy) page.closeDialog(); }}
    onOpenAutoFocus={event => {
      event.preventDefault();
      initialFocus?.()?.focus();
    }}
    onCloseAutoFocus={event => {
      event.preventDefault();
      if (onClosed) onClosed();
      else page.restoreFocus();
    }}>
    {onSubmit
      ? <form className="contents" data-testid={testId} noValidate onSubmit={submit}>{sections}</form>
      : <div className="contents" data-testid={testId}>{sections}</div>}
  </ScrollableDialog>;
}

/** A short note inside a dialog: neutral information, a warning before a destructive choice, or an error. */
export function DialogNote({ tone, children, testId }: { tone: 'info' | 'warning' | 'error'; children: ReactNode; testId?: string }) {
  const Icon = tone === 'info' ? Info : AlertCircle;
  return <div role={tone === 'error' ? 'alert' : undefined} className="lt-dialog-note" data-tone={tone} data-testid={testId}>
    <Icon aria-hidden="true" />
    <p>{children}</p>
  </div>;
}
