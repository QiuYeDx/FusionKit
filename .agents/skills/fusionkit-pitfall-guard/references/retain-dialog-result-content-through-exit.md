# FK-PIT-0150: Retain result content through dialog exit

## Area

Frontend / Radix dialogs / multi-step results.

## Triggers

Result dialog flashes its previous form while closing; empty shell during exit; step-dependent dialog width changes on dismiss.

## Symptoms and cause

Radix keeps closed content mounted for its exit animation. Clearing result data or resetting the form at the same time as open=false changes the visible exiting tree. An export result can become its 600px settings form again for 200ms; a library result can become an empty shell.

## Do

Separate open/operation authority from the visible exit receipt. For an existing controller, close by setting open=false and reset configuration/results on the next explicit open. For a nullable result that also drives open, keep the last result only as an exit render snapshot; only live state controls open and no snapshot may replay requests. Keep stale-response and mounted guards. Restore focus after dismissal, respecting handoff to another still-open dialog.

Verify during the closed animation itself: the same result title remains, settings controls do not reappear, and the tree eventually unmounts. Then reopen with a new request and verify old result content/configuration does not leak. A final screenshot after unmount cannot prove exit continuity.

## Avoid

Do not delay operation cancellation or access revocation just to keep the exit visually intact. Do not use a setTimeout to guess when the transition ends, or forcibly skip the animation to hide data-lifetime bugs.

## Evidence and related files

Subtitle Studio I7, 2026-09-13. StudioExport resets on open; index.tsx retains a presentation-only resultReceipt. test/subtitle-studio/result-feedback-ui.test.ts observes the closed phase. See docs/features/subtitle-studio/modules/module-feedback/design.md and records/2026-09-13-feedback-closeout.md for final validation.
