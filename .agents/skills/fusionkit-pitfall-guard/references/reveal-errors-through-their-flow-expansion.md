# FK-PIT-0175: Reveal errors through their flow expansion

## Area

Frontend / animated form feedback / scroll visibility / accessibility.

## Triggers

Focused error outside viewport, save failed below fold, fixed modal footer, DialogTransition, scrollIntoView before height expansion.

## Symptoms

A save error has the expected text and keyboard focus, but its final visible region remains below the dialog viewport.

## Root cause

A single requestAnimationFrame scroll runs while the error's animated flow region still has zero or partial height. Browser scrolling clamps to the old scrollHeight; later expansion increases that maximum without correcting the previous position. Focus with preventScroll does not restore visibility.

## Do

- Focus the active error once and correct only the actual ScrollArea viewport.
- Observe the error's own animated region and viewport during this one reveal. Track completion on the region, not unrelated animations elsewhere in the dialog.
- Stop when its flow transition ends and the error is visible; align the top for feedback taller than the viewport.
- Cancel on error replacement/removal, dialog exit, and user wheel, pointer or keyboard interaction. Do not continuously pin the viewport to an old error.
- Ignore Presence's exiting/inert copies when choosing the active alert.

## Avoid

- Treating successful focus as proof the error can be read.
- Solving this with arbitrary delays, scrolling the document instead of the inner viewport, or disabling the feedback animation.

## Validation

In native Electron, inject one failed save from a fixed footer in a narrow record editor, require text, focus and viewport visibility, then retry and verify the draft was preserved and persisted. Save failure geometry and a screenshot for diagnosis.

## Related files

- src/pages/TranslationKnowledge/KnowledgeRecordDialog.tsx
- src/pages/TranslationKnowledge/EntryEditor.tsx
- test/translation-knowledge/entry-dialogs-electron.test.ts
- [FK-PIT-0172: content flow](animate-content-flow-not-only-dialog-shells.md)
