import { useCallback, useRef, type KeyboardEvent } from 'react';
import { shortcutBlocked } from '../hooks/usePageShortcuts';

/** What a key does in the reader (design §4.1). */
export type ReaderKeyAction =
  | { kind: 'move'; step: 1 | -1 }
  | { kind: 'edit' }
  | { kind: 'retranslate' }
  | { kind: 'lock' }
  | { kind: 'menu' }
  | { kind: 'attention'; direction: 'next' | 'previous' }
  /** PageUp, PageDown, Home, End: the user scrolls, which ends following. */
  | { kind: 'scroll' };

type KeyInput = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>;

/**
 * The reader keys: ↑/↓, Enter/F2, R, L, N/Shift+N, F8/Shift+F8, Shift+F10 and the ContextMenu key.
 * No Ctrl+Z, J/K, C or brackets; anything with Ctrl, Cmd or Alt is left alone.
 */
export function readerKeyAction({ key, shiftKey, ctrlKey, metaKey, altKey }: KeyInput): ReaderKeyAction | null {
  if (ctrlKey || metaKey || altKey) return null;
  if (key === 'F8') return { kind: 'attention', direction: shiftKey ? 'previous' : 'next' };
  if (key === 'ContextMenu' || (key === 'F10' && shiftKey)) return { kind: 'menu' };
  if (key === 'n' || key === 'N') return { kind: 'attention', direction: shiftKey ? 'previous' : 'next' };
  if (shiftKey) return null;
  switch (key) {
    case 'ArrowDown': return { kind: 'move', step: 1 };
    case 'ArrowUp': return { kind: 'move', step: -1 };
    case 'Enter':
    case 'F2': return { kind: 'edit' };
    case 'r':
    case 'R': return { kind: 'retranslate' };
    case 'l':
    case 'L': return { kind: 'lock' };
    case 'PageUp':
    case 'PageDown':
    case 'Home':
    case 'End': return { kind: 'scroll' };
    default: return null;
  }
}

/**
 * The reader's key handler, for its focus container (rows and the editor inside it). Keys stay out
 * of the way during IME composition, in fields and while a dialog, menu or popover is open (AC-LT-19-2);
 * the editor handles its own keys, F8 included. `row` is the focused row's index, if a row has focus.
 */
export function useReaderKeyboard(onAction: (action: ReaderKeyAction, row: number | null) => void) {
  const handler = useRef(onAction);
  handler.current = onAction;
  return useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || shortcutBlocked(event.nativeEvent)) return;
    const action = readerKeyAction(event);
    if (!action) return;
    const target = event.target as HTMLElement;
    const row = target.matches('[data-row-index]') ? Number(target.dataset.rowIndex) : null;
    // A button inside the reader keeps Enter and the arrows; row keys need a focused row.
    const rowKey = action.kind === 'edit' || action.kind === 'retranslate' || action.kind === 'lock' || action.kind === 'menu';
    if (row === null && (rowKey || (action.kind === 'move' && target !== event.currentTarget))) return;
    // Native scrolling keys keep working; they only end following.
    if (action.kind !== 'scroll') event.preventDefault();
    handler.current(action, row);
  }, []);
}
