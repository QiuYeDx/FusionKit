# FK-PIT-0090: Classify closed radio groups before segmented-control migration

## Area

Frontend / segmented controls

## Triggers

SegmentedControl,radio group,ButtonGroup,quick suggestion,command buttons,tabs

## Symptoms

A mechanical button-group migration makes navigation look like a form control,
turns independent commands into one selected value, or prevents a free-form
field from keeping a value outside its suggestion list.

## Root cause

Visual grouping does not establish radio semantics. A segmented control models
one value selected from a finite set; tabs navigate views, command groups invoke
independent actions, and suggestion buttons may only fill an unrestricted input.

## Do

- Migrate finite, mutually exclusive configuration values to `SegmentedControl`.
- Keep tool configuration consumers behind `ToolRadioButtonGroup` so size,
  keyboard behavior, and accessibility stay centralized.
- Preserve page tabs, task action groups, and free-input suggestion buttons.
- Audit both explicit radio primitives and hand-written selected button styles.

## Avoid

- Do not classify every adjacent set of buttons as a radio group.
- Do not replace a suggestion list when its backing input accepts arbitrary text.
- Do not infer semantics only from `ButtonGroup` or `default`/`outline` variants.

## Validation

```text
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run src/components/qiuye-ui/segmented-control.test.tsx src/pages/Tools/_shared/ui/ToolRadioButtonGroup.test.tsx src/pages/Tools/_shared/ui/segmentedControlConsumers.test.ts --reporter=dot
node_modules/.bin/vite build --mode=test
```

In Electron, verify selection, Arrow/Home/End focus movement, disabled items, and
narrow-layout overflow. Confirm task command buttons and settings navigation do
not expose radio semantics.

## Related files

- `src/components/qiuye-ui/segmented-control.tsx`
- `src/pages/Tools/_shared/ui/ToolRadioButtonGroup.tsx`
- `src/pages/Setting/components/`
- `src/pages/Tools/`
