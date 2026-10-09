import { useCallback, useRef, useState, type Dispatch, type DragEvent, type KeyboardEvent, type RefObject, type SetStateAction } from "react";
import { getFilePathFromFile } from "@/utils/filePath";

// Composer behaviour shared by the home page and the floating panel, so both inputs work the same way.

const INPUT_HISTORY_KEY = "fusionkit-input-history";
const INPUT_HISTORY_MAX = 50;

function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(INPUT_HISTORY_KEY);
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Up and Down recall sent messages (newest first) when the caret is at the start or end of a
 * single-line draft, and keep stepping while a recalled message is unedited; going past the newest
 * restores the draft. The history is kept across sessions and shared by every composer.
 */
export function useInputHistory(input: string, setInput: Dispatch<SetStateAction<string>>, inputRef: RefObject<HTMLTextAreaElement | null>) {
  const index = useRef(-1);
  const draft = useRef("");
  const recalled = useRef<string | null>(null);
  const show = (text: string) => { recalled.current = text; setInput(text); };

  const remember = useCallback((text: string) => {
    index.current = -1;
    draft.current = "";
    recalled.current = null;
    const history = readHistory();
    if (history[history.length - 1] === text) return;
    history.push(text);
    try { localStorage.setItem(INPUT_HISTORY_KEY, JSON.stringify(history.slice(-INPUT_HISTORY_MAX))); } catch { /* history then lasts until reload */ }
  }, []);

  /** Returns true when the key recalled history and the caller should not handle it further. */
  const onHistoryKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || input.includes("\n")) return false;
    const element = inputRef.current;
    const browsing = index.current >= 0 && input === recalled.current;
    if (event.key === "ArrowUp") {
      const history = readHistory();
      if (!history.length || (!browsing && element && element.selectionStart !== 0)) return false;
      event.preventDefault();
      if (index.current === -1 || !browsing) { index.current = -1; draft.current = input; }
      index.current = Math.min(index.current + 1, history.length - 1);
      show(history[history.length - 1 - index.current]);
      return true;
    }
    if (event.key === "ArrowDown" && index.current >= 0) {
      if (!browsing && element && element.selectionStart !== element.value.length) return false;
      event.preventDefault();
      index.current -= 1;
      const history = readHistory();
      if (index.current < 0) { recalled.current = null; setInput(draft.current); }
      else show(history[history.length - 1 - index.current] ?? draft.current);
      return true;
    }
    return false;
  };

  return { remember, onHistoryKey };
}

/** Dropping files on the composer appends their paths to the draft, each in backticks. */
export function useFileDropInput(setInput: Dispatch<SetStateAction<string>>, inputRef: RefObject<HTMLTextAreaElement | null>) {
  const [isDragOver, setIsDragOver] = useState(false);
  const depth = useRef(0);
  const stop = (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); };
  const dropHandlers = {
    onDragEnter: (event: DragEvent) => {
      stop(event);
      depth.current += 1;
      if (event.dataTransfer.types.includes("Files")) setIsDragOver(true);
    },
    onDragOver: stop,
    onDragLeave: (event: DragEvent) => {
      stop(event);
      depth.current -= 1;
      if (depth.current <= 0) { depth.current = 0; setIsDragOver(false); }
    },
    onDrop: (event: DragEvent) => {
      stop(event);
      setIsDragOver(false);
      depth.current = 0;
      const paths = Array.from(event.dataTransfer.files).map((file) => getFilePathFromFile(file)).filter((path): path is string => !!path);
      if (!paths.length) return;
      const pathText = paths.map((path) => `\`${path}\``).join(" ");
      setInput((previous) => {
        const trimmed = previous.trimEnd();
        return trimmed ? `${trimmed} ${pathText}` : pathText;
      });
      inputRef.current?.focus();
    },
  };
  return { isDragOver, dropHandlers };
}
