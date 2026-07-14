# FK-PIT-0012: Keep Radix radio items as full interactive surfaces

## Area

Frontend / accessibility

## Triggers

RadioGroup,segmented control,roving tabindex,pointer interception,Home End

## Symptoms

A visually expanded label around an sr-only Radix radio can intercept clicks and break roving focus; style the primitive itself and verify keyboard semantics in Electron.

## Root cause

Radix owns selection, focus, and roving-tabindex behavior on the primitive
`RadioGroup.Item`. Making that item `sr-only` and expanding a surrounding
`label` creates two different interactive surfaces: pointer events land on the
visible text while keyboard focus remains on a tiny hidden element. The wrapper
can also interfere with Radix collection focus bookkeeping. Radix arrow-key
support does not by itself prove that a product-specific Home/End contract is
implemented.

## Do

- Render each segmented option as the actual `RadioGroupItem` and style that
  primitive to the full visible button dimensions.
- Put label text inside the primitive and make decorative descendants
  `pointer-events-none` when appropriate.
- Let Radix manage arrow keys and roving tabindex; explicitly implement any
  additional required keys such as Home/End at the group boundary.
- Validate clicks, the single `tabindex="0"`, focus movement, `data-state`, and
  the visible selected style in Electron.

## Avoid

- Do not put an `sr-only` Radix item inside a visually expanded label or button.
- Do not test only `aria-checked`; focus can still be unreachable or remain on
  the wrong item.
- Do not assume Home/End are covered because ArrowLeft/ArrowRight work.
- Do not use a forced Playwright click to hide pointer interception failures.

## Validation

```text
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts -t 'route-aware audio transcription' --reporter=dot
```

Confirm that a normal click succeeds, exactly one radio has `tabindex="0"`,
ArrowRight moves selection and focus, Home selects the first item, End selects
the last item, and the narrow layout has no horizontal overflow.

## Related files

- `src/components/ui/radio-group.tsx`
- `src/pages/Tools/Audio/AudioTranscriber/index.tsx`
- `test/e2e.spec.ts`
