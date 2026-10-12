# FK-PIT-0190: Keep legacy scroll classes on the Radix viewport

## Area

Frontend / Radix ScrollArea migration

## Triggers

replace overflow-y auto with ScrollArea,native scrollbar,scrollbar-gutter stable,StudioScrollFade,studio-reader,studio-library-scroll,max-height ScrollArea does not scroll,display table wrapper,scrollTop is 0,flex fill viewport

## Symptoms

After swapping a native `overflow-y: auto` container for `ScrollArea`, tests or code that set `scrollTop` on the old class see `0`; a list capped with `max-height` on the ScrollArea root grows with its content instead of scrolling; a flex-filled list never scrolls; rows shift right by the old scrollbar width; long rows widen the whole list.

## Root cause

`ScrollArea` splits one element into Root (positioning) and Viewport (the actual scroller, with inline `overflow: scroll`, `size-full`). The old class usually moves to the Root, which never scrolls. The viewport's `height: 100%` resolves to `auto` under a root that only has `max-height`, and under a flex item whose container has no definite height. Radix also wraps content in `display: table; min-width: 100%`. The native `scrollbar-gutter: stable` gutter (8 px from the global `::-webkit-scrollbar`) disappears because Radix hides native scrollbars.

## Do

- Put the legacy scroll class (`.studio-reader`, `.studio-library-scroll`, `.studio-materials-picker-body`, `.studio-scroll-fade-viewport`) and its `aria-busy` on the viewport via `viewportProps` / `viewportRef`; put grid or flex placement on the Root (`.studio-reader-area`).
- Cap height on the viewport (`viewportProps.style.maxHeight` or a `max-h-*` viewport class), not on the Root.
- To fill a flex column, make Root a flex column and give the viewport `flex: 1 1 auto; height: auto; min-height: 0` (`StudioScrollFade fill`).
- Override the wrapper locally: `.your-viewport > div { display: block !important; }` (or `[&>div]:block!`).
- Recreate the old gutter as right padding on the wrapper and narrow the overlay scrollbar into it, so row insets and geometry tests stay unchanged.
- For lists that need edge fades, use `StudioScrollFade` (ScrollArea inside), with `--studio-scroll-fade-surface` matching the panel background.

## Avoid

- Do not put `max-h-*` on the `ScrollArea` className and expect it to scroll.
- Do not override `display: table` globally; scope it to the migrated viewport.
- Do not drop the gutter padding and let the overlay scrollbar cover row actions.

## Validation

FUSIONKIT_STUDIO_E2E=1 node node_modules/vitest/vitest.mjs run test/subtitle-studio/library-ui.test.ts test/subtitle-studio/vertical-layout.test.ts test/translation-knowledge/materials-layout-electron.test.ts test/translation-knowledge/workspace-layout-electron.test.ts --maxWorkers=4 --minWorkers=1

## Related files

- src/components/ui/scroll-area.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/StudioScrollFade.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/StudioLibrary.tsx (document list)
- src/pages/Tools/Subtitle/SubtitleStudio/index.tsx (cue reader)
- src/pages/Tools/Subtitle/SubtitleStudio/StudioMaterialsFields.tsx (material picker)
