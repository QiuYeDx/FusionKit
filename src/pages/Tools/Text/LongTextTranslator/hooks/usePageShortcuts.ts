import { useEffect, useRef } from 'react';

/** Open layers that own the keyboard: dialogs, menus, Select lists and popovers (design §4.1). */
const LAYER_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"]';

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const element = target as HTMLElement;
  return element.isContentEditable || !!element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

/**
 * Whether a visible layer owns the keyboard. A non-modal panel (`aria-modal="false"`: the assistant
 * dock, which can stay pinned open) owns it only while focus is inside it.
 */
export function hasOpenLayer(root: ParentNode = document): boolean {
  const active = document.activeElement;
  return Array.from(root.querySelectorAll(LAYER_SELECTOR))
    .some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
      && (element.getAttribute('aria-modal') !== 'false' || element.contains(active)));
}

/**
 * Whether a page or reader shortcut must stay out of the way: during IME composition, while typing
 * in a field, or while a dialog, menu, list or popover is open. The reader's keys use it too.
 */
export function shortcutBlocked(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229 || isEditableTarget(event.target) || hasOpenLayer();
}

/** Ctrl/Cmd+F without other modifiers. */
export function isFindShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f';
}

/**
 * Page-wide keys: Ctrl/Cmd+F opens the reader's search (with a document open), and pasting text
 * anywhere outside a field opens the paste dialog with it. Inside fields both stay native.
 */
export function usePageShortcuts({ canFind, onFind, onPaste }: {
  canFind: boolean;
  onFind: () => void;
  onPaste: (text: string) => void;
}) {
  const handlers = useRef({ canFind, onFind, onPaste });
  handlers.current = { canFind, onFind, onPaste };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isFindShortcut(event) || !handlers.current.canFind || shortcutBlocked(event)) return;
      event.preventDefault();
      handlers.current.onFind();
    };
    const paste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target) || isEditableTarget(document.activeElement) || hasOpenLayer()) return;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!text.trim()) return;
      event.preventDefault();
      handlers.current.onPaste(text);
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('paste', paste);
    };
  }, []);
}
