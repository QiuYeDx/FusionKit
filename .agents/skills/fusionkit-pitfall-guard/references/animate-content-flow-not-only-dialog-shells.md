# Animate content flow, not only dialog shells

- Area: Frontend / Motion / Radix Accordion
- Triggers: accordion flash, passive siblings jump, measured dialog, forceMount, popLayout, conditional gap, nested height

## Symptoms

The dialog frame smoothly changes height, but disclosure contents appear immediately and push following controls to their final positions. Closing a conditional region can still jump by 8–16px after its content fades away.

## Root cause

- Radix Collapsible temporarily sets its Content DOM node's `transitionDuration` to `0s` and `animationName` to `none` while measuring on open/close. A CSS grid transition on that same node is interrupted by the forced layout.
- Animating the dialog shell does not interpolate the real document-flow footprint of a child. `popLayout` removes outgoing content from flow immediately; its own local height needs an owner.
- `open && children` removes a force-mounted disclosure's children before they can fade out.
- Parent `gap`, Tailwind `space-y`, and conditional `:last-child` margins change outside the animated region. They are not included in a content-only height interpolation.
- Starting a new parent spring for each measured frame of an already moving child adds a second chase animation.

## Do

- Keep Radix semantics on its outer Content and put the native Motion height box inside it. Measure an independent natural inner box; animate the actual outer `height` and the inner opacity without scaling text.
- Preserve disclosure children, or mount expensive lists on first expansion and retain them until the containing component unmounts. Mark closed content inert and aria-hidden immediately.
- Give keyed swaps and conditional regions their own measured flow footprint. Retain their wrappers until both presence exit and height-to-zero finish. Check the latest target before accepting an animation completion, including rapid reversal.
- Group optional regions with stable adjacent controls. Put their spacing inside the animated stage using padding. Keep edge compensation and `:last-child` structures stable.
- Count independently moving descendants by their DOM markers; ignore exiting/hidden trees that no longer contribute to flow. A steady open ancestor follows measured animated geometry directly, while its own explicit open/close always owns an interpolation.
- Treat the whole dialog's `h-full` stage as a size opt-out: it is constrained by the outer shell, not a natural-height ruler.
- Filter empty strings when deciding whether a conditional stage has content. `React.Children.toArray('')` contains one item; it must not preserve a padding-only stage.
- Use `layout="position"` for discrete list reorder, and a measured local list wrapper for the downstream controls. A list item's transform does not animate the list's occupied height.

## Avoid

- Declaring a motion fix verified because only the dialog's outer rectangle has intermediate heights.
- Adding `layout` to every control or scaling entire forms to hide a flow jump.
- Removing wrappers on the shorter opacity completion while height is still shrinking.
- Disabling a parent's own closing animation merely because its child is also moving.
- Letting CSS transitions and Motion write the same height.

## Validation

Run `FUSIONKIT_DIALOG_CONTENT_MOTION_E2E=1` with `test/dialog-content-motion.electron.test.ts` against a current test build. Sample the content's actual height, opacity, and a stable following element's y relative to the same natural body. Cover normal/reduced motion, nested expansion, rapid reversal, parent close during child motion, and optional fields including their final gap removal. Verify no text scale, no second shell chase, and a middle-of-animation native screenshot. Keep `test/dialog-motion.electron.test.ts` for shell, exit, scrolling and draft regressions.

## Related files

- `src/components/qiuye-ui/dialog-motion.tsx`
- `src/components/qiuye-ui/animated-scrollable-dialog.tsx`
- `src/components/ui/accordion.tsx`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioDisclosure.tsx`
- `src/pages/TranslationKnowledge/KnowledgeDisclosure.tsx`
- `test/dialog-content-motion.electron.test.ts`
