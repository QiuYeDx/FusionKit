# FK-PIT-0091: Scope segmented indicator layout measurement to value changes

## Area

Frontend / Motion layout projection

## Triggers

SegmentedControl,layoutId,layoutDependency,dynamic height,indicator lag,vertical drift

## Symptoms

Removing or inserting a conditional configuration row moves later segmented
controls immediately, while their selected white indicators visibly lag behind
and animate from the old vertical position. Indicators in controls whose values
did not change can appear detached from their tracks.

## Root cause

A Motion element with `layoutId` participates in layout projection whenever it
is measured. Without a `layoutDependency`, every React render can mark it for
measurement, so an unrelated ancestor reflow is mistaken for an indicator
transition. Animating the surrounding content or reserving page-specific space
only masks the shared component defect.

## Do

- Set the indicator's `layoutDependency` to the resolved segmented value.
- Let value changes measure and animate the indicator between options.
- Let unchanged indicators follow ancestor reflow synchronously with their
  tracks.
- Validate by sampling indicator and selected-item rectangles over several
  animation frames while an earlier conditional row disappears.

## Avoid

- Do not add fixed-height placeholders merely to protect indicators below them.
- Do not add page-level content animation as the primary fix for projection
  caused by an unchanged segmented value.
- Do not disable the indicator transition globally; horizontal value changes
  should remain animated.

## Validation

```text
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run src/components/qiuye-ui/segmented-control.test.tsx --reporter=dot
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts -t 'segmented indicators ignore unrelated configuration height changes' --reporter=dot
```

In Electron, switch the subtitle slice mode from custom to normal. During the
resulting height change, verify that the output-location and conflict-policy
indicators stay aligned with their selected options on every sampled frame.

## Related files

- `src/components/qiuye-ui/segmented-control.tsx`
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
- `test/e2e.spec.ts`
