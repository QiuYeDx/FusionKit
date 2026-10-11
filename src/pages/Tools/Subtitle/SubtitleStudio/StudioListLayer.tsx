import type { ComponentProps, SyntheticEvent } from 'react';
import { PopoverContent } from '@/components/ui/popover';

const stop = (event: SyntheticEvent) => event.stopPropagation();

/**
 * Pointer and mouse handlers that keep a layer's events inside it. React events bubble along the
 * component tree, not the DOM: a popover portalled to <body> from inside the cue list still reaches
 * the list's handlers, whose selection takes focus, which closes the popover. Spread these on any
 * layer or control rendered inside the list.
 */
export const isolateListEvents = {
  onMouseDown: stop, onPointerDown: stop, onPointerUp: stop, onPointerMove: stop, onClick: stop, onDoubleClick: stop, onContextMenu: stop,
} as const;

/** Calls the layer's own handler too, then stops the event there. */
function isolated<P extends object>(props: P): P {
  const own = props as unknown as Record<string, ((event: SyntheticEvent) => void) | undefined>;
  const merged: Record<string, unknown> = { ...own };
  for (const [name, stopHere] of Object.entries(isolateListEvents)) {
    merged[name] = (event: SyntheticEvent) => { own[name]?.(event); stopHere(event); };
  }
  return merged as unknown as P;
}

/** A popover opened from inside the cue list: its events stay in it. */
export function StudioListPopoverContent(props: ComponentProps<typeof PopoverContent>) {
  return <PopoverContent {...isolated(props)} />;
}
