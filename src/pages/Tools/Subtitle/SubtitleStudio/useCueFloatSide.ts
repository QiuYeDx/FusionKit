import { useLayoutEffect, useRef } from 'react';

/** Space between a floating layer and what it belongs to. */
const GAP = 4;

/**
 * Places a layer that floats beside a cue row being edited (the editor's hints, the retimed cue's
 * waveform) below its anchor, or above it when only the space above fits it inside the reader. The
 * layer never takes part in the row's layout, so opening an editor never moves the rows under it.
 * Writes the side to the layer's data-side; CSS positions it.
 */
export function useCueFloatSide(layer: HTMLElement | null | undefined, anchor: () => Element | null | undefined) {
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  useLayoutEffect(() => {
    if (!layer) return;
    const target = anchorRef.current();
    const place = () => {
      const view = layer.closest('[data-slot=scroll-area-viewport]');
      if (!target || !view) { layer.dataset.side = 'bottom'; return; }
      const box = target.getBoundingClientRect(), frame = view.getBoundingClientRect();
      // The sticky table header covers the top of the reader.
      const top = Math.max(frame.top, view.querySelector('thead')?.getBoundingClientRect().bottom ?? frame.top);
      const need = layer.offsetHeight + GAP;
      layer.dataset.side = frame.bottom - box.bottom < need && box.top - top >= need ? 'top' : 'bottom';
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(layer);
    if (target) observer.observe(target);
    return () => observer.disconnect();
  }, [layer]);
}
