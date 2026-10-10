import { useEffect, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { AArrowDown, AArrowUp, ChevronLeft, ChevronRight, Expand, Maximize2, Minimize2, Shrink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isLocalEscape } from '../../_shared/useToolPageEscape';
import { StudioIconButton } from './StudioControls';

/** Reading text sizes for the expanded preview; see `data-reader-size` in studio.css. */
const READER_SIZES = 4;
const DEFAULT_READER_SIZE = 1;
const READER_SIZE_KEY = 'fusionkit-studio-reader-size';

function storedReaderSize() {
  try {
    const value = Number(localStorage.getItem(READER_SIZE_KEY) ?? DEFAULT_READER_SIZE);
    return Number.isInteger(value) && value >= 0 && value < READER_SIZES ? value : DEFAULT_READER_SIZE;
  } catch { return DEFAULT_READER_SIZE; }
}

const exitFullscreen = () => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); };
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const TRANSITION_CLASS = 'studio-preview-transition';

/**
 * Morphs the preview between its place in the page and the expanded view
 * (see `.studio-preview-transition` in studio.css): the panel grows or
 * shrinks while the rest of the page cross-fades. Snapshots keep their
 * natural size, so text never stretches.
 */
function morph(update: () => void) {
  if (reducedMotion() || !document.startViewTransition) { update(); return; }
  const root = document.documentElement;
  root.classList.add(TRANSITION_CLASS);
  const transition = document.startViewTransition(() => flushSync(update));
  void transition.finished.catch(() => {}).finally(() => root.classList.remove(TRANSITION_CLASS));
}

const nextFrames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/**
 * The window resizes when it enters or leaves full screen, which a view
 * transition cannot span; fade the expanded view out and back in around it.
 */
async function dipAround(element: HTMLElement | null | undefined, change: () => Promise<void>) {
  if (!element || reducedMotion()) { await change().catch(() => {}); return; }
  const out = element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-in', fill: 'forwards' });
  await out.finished.catch(() => {});
  try { await change(); await nextFrames(); } catch { /* Denied or already left; fade back in. */ }
  element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'cubic-bezier(.22, 1, .36, 1)' });
  out.cancel();
}

/** Makes everything beside the path from `region` up to `root` inert while the region covers it. */
function inertOutside(region: HTMLElement, root: HTMLElement) {
  const changed: HTMLElement[] = [];
  for (let node: HTMLElement | null = region; node && node !== root; node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement?.children ?? [])) {
      if (sibling === node || !(sibling instanceof HTMLElement) || sibling.inert) continue;
      sibling.inert = true;
      changed.push(sibling);
    }
  }
  return () => { for (const element of changed) element.inert = false; };
}

export type StudioPreviewExpansion = ReturnType<typeof useStudioPreviewExpansion>;

/**
 * The preview can cover the window (and optionally the screen) in place, so
 * the cue list keeps its selection, edits, scroll position and tools. Escape
 * leaves full screen first, then the expanded view, after any inner layer.
 */
export function useStudioPreviewExpansion(rootRef: RefObject<HTMLElement | null>, regionSelector: string, available: boolean) {
  const [expanded, setExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [readerSize, setReaderSize] = useState(storedReaderSize);

  useEffect(() => { if (!available) setExpanded(false); }, [available]);
  useEffect(() => {
    const sync = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => { document.removeEventListener('fullscreenchange', sync); exitFullscreen(); };
  }, []);
  useEffect(() => {
    if (!expanded) { exitFullscreen(); return; }
    const root = rootRef.current;
    const region = root?.querySelector<HTMLElement>(regionSelector);
    const restoreInert = root && region ? inertOutside(region, root) : undefined;
    const localEvents = new WeakSet<KeyboardEvent>();
    const capture = (event: KeyboardEvent) => { if (event.key === 'Escape' && isLocalEscape(event)) localEvents.add(event); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || event.defaultPrevented || localEvents.has(event)) return;
      // Consumed here, so the tool page does not navigate back as well.
      event.preventDefault();
      if (document.fullscreenElement) void dipAround(region, () => document.exitFullscreen());
      else morph(() => setExpanded(false));
    };
    window.addEventListener('keydown', capture, true);
    window.addEventListener('keydown', onKey);
    return () => {
      restoreInert?.();
      window.removeEventListener('keydown', capture, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [expanded, rootRef, regionSelector]);

  return {
    expanded, fullscreen, readerSize,
    toggleExpanded: () => morph(() => setExpanded(value => !value)),
    toggleFullscreen: () => {
      const region = rootRef.current?.querySelector<HTMLElement>(regionSelector);
      void dipAround(region, () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
    },
    changeReaderSize: (step: 1 | -1) => setReaderSize(value => {
      const next = Math.min(READER_SIZES - 1, Math.max(0, value + step));
      try { localStorage.setItem(READER_SIZE_KEY, String(next)); } catch { /* Size stays for this session. */ }
      return next;
    }),
  };
}

/** Header controls: the expand toggle, plus reading tools while expanded. */
export function StudioPreviewExpandControls({ expansion, onPreviousDocument, onNextDocument }: {
  expansion: StudioPreviewExpansion;
  onPreviousDocument?: () => void;
  onNextDocument?: () => void;
}) {
  const { t } = useTranslation();
  const { expanded, fullscreen, readerSize } = expansion;
  return <>
    {expanded && <>
      <span className="studio-preview-expand-divider" aria-hidden="true" />
      <StudioIconButton data-testid="studio-preview-previous-document" label={t('studio:preview_view.previous_document')} disabled={!onPreviousDocument} onClick={onPreviousDocument}><ChevronLeft /></StudioIconButton>
      <StudioIconButton data-testid="studio-preview-next-document" label={t('studio:preview_view.next_document')} disabled={!onNextDocument} onClick={onNextDocument}><ChevronRight /></StudioIconButton>
      <StudioIconButton data-testid="studio-preview-text-smaller" label={t('studio:preview_view.text_smaller')} disabled={readerSize <= 0} onClick={() => expansion.changeReaderSize(-1)}><AArrowDown /></StudioIconButton>
      <StudioIconButton data-testid="studio-preview-text-larger" label={t('studio:preview_view.text_larger')} disabled={readerSize >= READER_SIZES - 1} onClick={() => expansion.changeReaderSize(1)}><AArrowUp /></StudioIconButton>
      <StudioIconButton data-testid="studio-preview-fullscreen" aria-pressed={fullscreen} label={t(fullscreen ? 'studio:preview_view.exit_fullscreen' : 'studio:preview_view.fullscreen')} onClick={expansion.toggleFullscreen}>{fullscreen ? <Shrink /> : <Expand />}</StudioIconButton>
    </>}
    <StudioIconButton data-testid="studio-preview-expand" aria-pressed={expanded} label={t(expanded ? 'studio:preview_view.collapse' : 'studio:preview_view.expand')} onClick={expansion.toggleExpanded}>{expanded ? <Minimize2 /> : <Maximize2 />}</StudioIconButton>
  </>;
}
