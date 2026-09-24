# FK-PIT-0179: Measure content height before visual transforms

- Area: Frontend / Motion / floating content geometry
- Triggers: scroll at bottom but last item clipped, Popover zoom-in, 95 percent height, getBoundingClientRect, ResizeObserver

## Symptoms

A picker scrolls correctly and reaches its reported maximum, but the last item's title or metadata remains hidden behind a clipping layer. Real-wheel assertions alone pass.

## Root cause

useNaturalHeight measured getBoundingClientRect during Radix Popover's scale(.95) entrance. The cached height was exactly 95 percent of the layout height (1189.4 versus 1252 px in the native reproduction). Ending an ancestor transform does not resize the observed layout box, so ResizeObserver did not correct that cached value. Nested motion regions then preserved the undersized clip and scroll extent. Flex shrink changes alone did not fix it.

## Do

- Measure untransformed layout height with ResizeObserver borderBoxSize; use offsetHeight for initial/fallback measurement. Observe the border box and retain fractional observer sizes.
- Preserve hidden-panel guards, natural inner measurement, and normal motion/exit behavior.
- At scroll end, intersect the last row with every overflow-clipping ancestor, then inspect a screenshot of the actual last row including its metadata. Verify six-row and long-list cases plus a wrapping final title.
- Run shared content-motion regressions for nested expansion, reversals and reduced motion when changing useNaturalHeight.

## Avoid

- Persisting screen-space transformed rectangles as CSS height targets.
- Treating scrollTop == scrollHeight - clientHeight as proof that all content is visible.
- Adding footer spacers, arbitrary delays or globally disabling clipping to conceal the wrong measured height.

## Validation

Build with the root Vite config. Run the native materials-layout and dialog-content-motion tests sequentially. The new last-row assertion fails on the preceding build even though wheel scrolling passes. Review picker-*-wheel-bottom.png and visual-metrics.json; close the isolated profiles.

## Related files

- src/components/qiuye-ui/dialog-motion.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/StudioMaterialsFields.tsx
- test/translation-knowledge/materials-layout-electron.test.ts
- test/dialog-content-motion.electron.test.ts
- references/let-portalled-material-pickers-own-scroll-lock.md

## Follow-up: preserve visible end padding

Complete visibility is still insufficient if the last row ends flush with the viewport. The picker's column-flex children must keep their natural height (flex-shrink: 0); otherwise a shrunken list lets its contents occupy the viewport's trailing padding. Preserve the existing 12px body padding and verify the measured end gap is 11–14px in both six-row and long-list cases. This complements the transform-independent height fix; it does not replace it.
