# FK-PIT-0019: Reuse the source UI component when matching another page

## Area

Frontend / component reuse

## Triggers

match another page,same style,Radio group,ButtonGroup,visual baseline,duplicate CSS

## Symptoms

Two controls satisfy broad requirements such as equal widths and joined borders,
but still differ in height, font, padding, colors, rounding, or responsive layout.
The target page and the new page drift because each owns a separate visual
implementation.

## Root cause

The implementation treats a screenshot or a list of CSS properties as the
contract instead of tracing the target page to its actual component tree. An
approximation can pass isolated tests while missing variants, size tokens,
compound selectors, and future design-system changes inherited by the source.

## Do

- Locate the exact component composition used by the page named as the visual
  baseline.
- Extract that composition into the nearest shared ownership boundary when both
  pages need the same control.
- Migrate the baseline page and all consumers to the shared component so there
  is only one visual implementation.
- Add semantics such as `radiogroup`, roving tabindex, and keyboard navigation
  inside the shared component without introducing consumer-specific visual CSS.
- In Electron, compare the baseline and consumer component structure and
  computed visual signature, then check narrow-layout overflow.

## Avoid

- Do not create a feature-local component that imitates the target with copied
  height, font, gap, border, or radius classes.
- Do not call controls consistent merely because each one passes an isolated
  "no gap" assertion.
- Do not leave the baseline page on one implementation and the new page on a
  second implementation with matching CSS today.

## Validation

```text
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run src/pages/Tools/_shared/ui/ToolRadioButtonGroup.test.tsx --reporter=dot
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts -t 'subtitle and audio radio groups share the same ButtonGroup baseline' --reporter=dot
git diff --check
```

Confirm that both pages render the same shared `data-slot="button-group"` and
small `data-slot="button"` structure, selected/unselected computed signatures
match, adjacent options are connected, and neither group nor option overflows.

## Related files

- `src/components/ui/button-group.tsx`
- `src/components/ui/button.tsx`
- `src/pages/Tools/_shared/ui/ToolRadioButtonGroup.tsx`
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
- `src/pages/Tools/Audio/`
- `test/e2e.spec.ts`
