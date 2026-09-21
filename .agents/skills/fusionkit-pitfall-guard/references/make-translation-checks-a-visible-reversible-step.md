# Make translation checks a visible, reversible step

## Area

Frontend / Subtitle Studio translation dialogs

## Triggers

check and estimate, inline result appended below viewport, dialog header height, trial result reopening, late plan after dismissal

## Symptoms

The user clicks a check action but its result appears below the visible form. A tall two-line header has a top-aligned close icon and unrelated settings controls. Closing a trial result loses the only viewing surface, so reopening accidentally sends another model request.

## Root cause

Form editing, inspection, execution intent and result presentation share one rendering branch. A button sets data without moving focus to a visible result. Dismissing a surface does not necessarily cancel an asynchronous plan, while clearing its data can destroy a useful receipt or flash an empty exit animation.

## Do

- Keep the translation configuration header compact; place source context and reusable settings in the form. Measure the title and close-control centers, not just header padding.
- Give the materials title and its summary a shared top-aligned content column, separate from a taller action button. Validate narrow card consumers as well as the wide dialog.
- Open the check surface immediately, with loading, local error/retry and result states. Keep the source form mounted, preserve draft/scroll state, and restore focus after dismissal.
- Preserve existing plan identity, expiry, owner and library-generation checks when offering start from the review surface. Partial readiness still requires an explicit start action.
- Separate viewing an existing trial result from running a new trial. Cancelling during planning must invalidate the intent before a late plan can submit; cancellation during an admitted trial may still return a useful partial result.
- Keep a presentation-only snapshot through the close animation; it must not grant authority to submit.

## Avoid

- Appending important feedback below the fold without focus or a visible surface.
- Putting unrelated selectors beside a dialog title or shrinking button targets for visual alignment.
- Assuming a backend cancel call is effective before a plan claim exists.
- Reusing a trial button for viewing a result when it actually sends another request.
- Reporting check failures both in the modal and as a persistent background-page error.

## Validation

Run the materials-layout and trial Electron scenarios with `FUSIONKIT_KNOWLEDGE_E2E=1`. Cover loading, local error/retry, Escape, focus/scroll restoration, long labels, partial batches, closing during a delayed plan, and reopening trial results without another provider request. Supplement with translation-session tests and the real Studio boundary checker.

## Related files

- `src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslation.tsx`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslationReview.tsx`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioMaterialsFields.tsx`
- `src/services/subtitle-studio/translation-session.ts`
- `test/translation-knowledge/materials-layout-electron.test.ts`
- `test/translation-knowledge/trial-electron.test.ts`
- [FK-PIT-0150](retain-dialog-result-content-through-exit.md)
- [FK-PIT-0163](bind-translation-plan-authority-to-session-claims-and-current-draft-identity.md)
