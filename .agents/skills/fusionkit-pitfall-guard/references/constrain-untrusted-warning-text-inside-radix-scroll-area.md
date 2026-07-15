# FK-PIT-0020: Constrain untrusted warning text inside Radix ScrollArea

## Area

Frontend / Radix ScrollArea / diagnostic and warning UI.

## Triggers

- Long warning, error, model, provider, or path diagnostics.
- Unbroken text such as `model_batch_failed:...`, Base64-like data, URLs, hashes, or generated identifiers.
- A card appears contained in the page but a `ScrollableDialog` clips metrics or content horizontally.
- `document.documentElement.scrollWidth` is normal while an internal ScrollArea still overflows.

## Symptoms

- A Badge or inline-flex warning surface extends beyond its ToolPanel or the viewport.
- Adding `truncate` or `max-w-full` to the text does not stop the parent flex/grid item from expanding.
- In a Radix ScrollArea, the viewport's internal `display: table` wrapper adopts the diagnostic text's max-content width, so sibling metric grids become wider than the dialog.
- Page-level overflow assertions pass even though the dialog has an internal horizontal scroll or clipped content.

## Root cause

Warning strings are runtime data and have no reliable word boundaries or length limit. Inline Badge defaults (`whitespace-nowrap`, `shrink-0`, intrinsic width) are unsuitable for complete diagnostics. Radix ScrollArea also inserts an internal table-like wrapper to measure content; a long unbreakable descendant can enlarge that wrapper unless every relevant ancestor is shrinkable and the wrapper is locally constrained.

## Do

- Render complete diagnostics in a block/list card, not a single-line Badge.
- Apply `min-w-0`, `w-full`, and `max-w-full` to flex/grid descendants and `overflow-wrap:anywhere` plus `whitespace-pre-wrap` to the text.
- Use `overflow-hidden` on the warning surface as a final containment boundary, while keeping the text visible through wrapping rather than truncation.
- In a non-horizontal `ScrollableDialog`, locally override `[data-slot=scroll-area-viewport] > div` to block/full-width/min-width-zero when runtime text can affect intrinsic width.
- Test `scrollWidth <= clientWidth + 1` on the page, the warning container, and the ScrollArea viewport itself.
- Inspect an Electron screenshot after the global preload loading screen exits; verify metric cards and fixed Footer controls as well as the warning text.

## Avoid

- Do not put arbitrary diagnostics into the default Badge structure.
- Do not rely on `truncate`, tooltip-only access, or `max-w-full` without fixing ancestor min-width.
- Do not enable horizontal scrolling for a confirmation dialog whose content should naturally wrap.
- Do not treat a clean document-level overflow check as proof that nested ScrollAreas are safe.

## Validation

```text
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run <warning model/component tests>
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts -t '<warning dialog scenario>'
```

Confirm in both code and screenshots:

- long unbroken diagnostics wrap;
- all metric columns remain visible;
- the dialog viewport has no horizontal overflow;
- Header/Footer remain fixed and the warning list scrolls vertically.

## Related files

- `src/pages/Tools/Rename/NameTranslator/components/PlanWarningsList.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/ApplySummaryPanel.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/RiskConfirmDialog.tsx`
- `src/components/qiuye-ui/scrollable-dialog.tsx`
- `test/e2e.spec.ts`
