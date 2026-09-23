# FK-PIT-0171: Keep Motion dialog exit on a stable DOM ref

## Area

Frontend / Motion / Radix dialogs / Electron visual verification.

## Triggers

motion.create(DialogContent), Radix Slot refs, forceMount, AnimatePresence, usePresence, closed dialog remains mounted, pointer-events none, animate-out, zoom-out, duration-200, reduced motion still animates, safeToRemove, width and height animation completion.

## Symptoms

During the 2026-09-23 measured-dialog work, Electron reproduced a closed result dialog that remained mounted for more than five seconds. It had `data-state="closed"`, an exiting marker, `inert` and `aria-hidden`, but still had opacity 1, no running animation, and retained the body's pointer lock. Adding an explicit top-level `forwardRef` did not fix it.

Subsequent frame sampling caught two different failures: a size animation's completion removed the surface before any closed frame painted, and existing shadcn CSS exit animations introduced scale even though the Motion implementation animated only dimensions, opacity and vertical position. A final screenshot could not establish either failure.

A further reduced-motion run confirmed that the media preference was true and the Accordion's computed transition was none, yet the dialog root still changed size across roughly 20 sampled frames over 0.2 seconds. The extra tween was on the dialog root, not the Accordion.

## Root cause

The observed stack used Motion 12.38.0, Radix Dialog 1.1.15 and React 19.1.1. Radix's internal `SlotClone` creates composed callback refs during rendering. With `motion.create(DialogContent)`, those slots sit between Motion's ref and the actual DOM node. A Radix render can detach and reattach that ref, remounting the Motion VisualElement. Its mount-time update overwrites the previous presence context; `ExitAnimationFeature` can then see the same false presence value twice and skip the exit transition and completion. A correct presence marker alone does not prove that Motion ran the exit.

There are two independent ownership conflicts. Existing `animate-out` / `zoom-out` CSS can still control the transform while Motion animates the surface. Also, `onAnimationComplete` fires for size/open updates as well as closure; testing only the current `!present` flag can mistake an earlier animation's completion for the close animation.

Disabling CSS animations alone is insufficient. The shared Dialog's `duration-200` also sets `transition-duration: 200ms`; when no narrower transition property is set, the default is `all`. CSS then interpolates the width/height values written by Motion a second time, even when Motion's reduced-motion duration is zero. This was the direct cause of the 20-frame reduced-motion failure.

Preference reactivity was a separate issue: the installed Motion hook initializes a React state value from the media preference without subscribing that component to later preference changes. The project now uses `useReducedMotionPreference`, backed by `useSyncExternalStore` and a media-query change subscription, for these surfaces. That improves live preference changes; it was not the cause of the confirmed run where the preference was already true and CSS continued tweening.

## Do

- Keep Radix's dialog, focus and dismissal primitives, but render a native `motion.div` through `DialogContent forceMount asChild` and `DialogOverlay forceMount asChild`. Motion should own the final DOM ref, absorbing external ref changes rather than sitting above Radix's internal slots. Keep `asChild` to one element and put the close control inside that element.
- Give the animated surface and overlay explicit `animation: 'none'` **and** `transition: 'none'` when Motion owns their dimensions and enter/exit. Check computed CSS and frame transforms; utility-class ordering is not proof that legacy animation or transition rules have stopped. A duration utility can enable a transition even without a visible `transition-all` class.
- For explicit `usePresence` lifecycle control, animate named `open` / `closed` variants. Call `safeToRemove` only when presence is false **and** the completion definition is `closed`. Do not also register an unused `exit` animation that can leave a second unfinished presence participant.
- Keep the last measured width and height in the `closed` variant as well. Omitting dimensions can animate them back to underlying CSS defaults during the fade; this incident's first close trace grew a 240px result toward 596px. Assert stable dimensions on attached closed frames, not just retained text.
- Keep open/closed business authority immediate. Retain only the visual presentation needed for the exit, make exiting content inert and hidden from accessibility, and restore focus after the actual surface unmounts.
- Distinguish the first entrance from later dimension changes. A newly mounted dialog should acquire its measured size without an extra size tween; subsequent natural-content changes can animate numeric width and height.
- Use the reactive project preference hook so toggling reduced motion while a dialog is mounted updates its transitions. Verify both the preference value and all relevant ancestors' computed transition/animation properties before assigning a reduced-motion failure to the hook.

## Avoid

- Do not assume an explicit wrapper `forwardRef` stabilizes refs created deeper in Radix's tree.
- Do not fix a stuck dialog with a timeout, force unmount, or disabled exit effect; these conceal lifecycle defects and may leave modal locks or broken focus recovery.
- Do not call `safeToRemove` from every animation completion or from any callback that merely observes `!present`.
- Do not combine Motion's transform with the dialog's previous CSS zoom animation, or treat `data-state="closed"` as evidence of visible exit continuity.
- Do not infer that reduced motion is honored because the inner Accordion has `transition: none`, or that `animation: none` also disables CSS transitions on the outer dialog.

## Validation

Use `test/dialog-motion.electron.test.ts` with the task's isolated Electron profile and built renderer. Sample the dialog, header, footer, viewport and transform in the same animation frame. Verify intermediate width/height values, unchanged text scale, retained result content throughout closure, at least one attached closed frame, eventual detachment, released body pointer/scroll locks and connected focus restoration. Include reduced motion, quick reopen/close, conditional parent removal, and closure immediately following a size change. Reduced motion should complete without waiting for a visible-duration transition.

For reduced motion, record `matchMedia` state plus root and Accordion `transition-property`, `transition-duration` and `animation-name`. Check that size changes settle directly rather than merely faster, and toggle the preference while the surface remains mounted to exercise the subscription independently.

Development evidence was captured under ignored `test-results/dialog-motion/frames.json`, `failure.json` and `failure.png`; these files are overwritten by later runs. The hanging exit, premature removal, unexpected scale and root CSS tween despite reduced motion were reproduced during this incident. The final frame test and five related Electron workflows passed; see `docs/features/subtitle-studio/records/2026-09-23-measured-dialog-motion.md` for the validation record.

## Related files

- `src/components/qiuye-ui/animated-scrollable-dialog.tsx`
- `src/components/qiuye-ui/dialog-motion.tsx`
- `src/components/qiuye-ui/scrollable-dialog.tsx`
- `src/components/ui/dialog.tsx`
- `src/hooks/use-reduced-motion.ts`
- `test/dialog-motion.electron.test.ts`
- [FK-PIT-0150: Retain result content through dialog exit](retain-dialog-result-content-through-exit.md)
- [FK-PIT-0168: Keep record menu handoffs inside one modal boundary](keep-record-menu-handoffs-inside-one-modal-boundary.md)
