# FK-PIT-0189: Portalled layers still bubble React events to the list that renders them

## Area

Frontend / React events / Radix portals

## Triggers

popover closes immediately,portal,PopoverContent inside list,focus stolen,onMouseDown bubbles,selection list,React synthetic event bubbling,cue list

## Symptoms

A popover or panel opened from a row or the sticky header of the Subtitle Studio cue list closes as soon as it is clicked, its inputs lose focus, or a click inside it changes the list selection. In the DOM the layer is a child of `<body>`, so DOM-level reasoning says the list cannot see the event.

## Root cause

React synthetic events bubble along the component tree, not the DOM tree. A layer portalled to `<body>` but rendered by a component inside the list still delivers `mousedown` / `pointerdown` / `click` / `contextmenu` to the list's React handlers. The list's selection handler (`useCueSelection`) treats a mouse-down as a click in the list: it commits a selection and focuses the list, and the focus change dismisses the layer.

## Do

- Render popovers opened from inside the cue list with `StudioListPopoverContent` (`src/pages/Tools/Subtitle/SubtitleStudio/StudioListLayer.tsx`), which stops pointer and mouse events at the layer and still calls its own handlers.
- For in-list controls that are not popovers (the find bar in the table header), spread `isolateListEvents` and mark them with the list's `data-cue-control` attribute so selection ignores them.
- Keep keyboard events in mind separately: the list's `onKeyDown` only acts when the list itself is the target, so typing in a layer is safe; a layer's Escape that must not reach page-level handlers should `stopPropagation` itself (as the find bar does).

## Avoid

- Do not hand-write the same seven `onX={event => event.stopPropagation()}` props in each component; they drift (one forgets `onPointerUp` or `onContextMenu`).
- Do not fix it by moving the layer out of the list component when it needs the row's state; isolation keeps the structure.
- Do not stop propagation on the list's own rows or buttons that rely on selection (row play buttons stop only what they must).

## Validation

FUSIONKIT_STUDIO_E2E=1 node node_modules/vitest/vitest.mjs run test/subtitle-studio/cue-audio-ui.test.ts test/subtitle-studio/cue-find-ui.test.ts

## Related files

- src/pages/Tools/Subtitle/SubtitleStudio/StudioListLayer.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/StudioCueAudio.tsx (original-audio panel)
- src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.tsx (find bar header row)
- src/pages/Tools/Subtitle/SubtitleStudio/useCueSelection.ts
