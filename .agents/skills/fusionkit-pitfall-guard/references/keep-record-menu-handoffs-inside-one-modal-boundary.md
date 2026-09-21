# Keep record menu handoffs inside one modal boundary

- Area: Frontend / Radix dialogs and menus
- Triggers: nested DropdownMenu, dialog handoff, reject, pointer-events none, fixed footer error, focus restoration

## Symptoms

After selecting a menu action that closes a record dialog, all dialogs disappear but the workspace cannot be clicked. Playwright reports that html intercepts pointer events. Separately, a fixed-footer save can fail below the visible scroll position, or a maintenance preview can close to a detached menu item.

## Root cause

A modal DropdownMenu inside an already modal Dialog creates overlapping pointer/focus locks. An async action can unmount the outer dialog while the menu is finishing its own close. The original menu trigger also disappears when switching from record details to a separate maintenance preview. Fixed footer controls do not imply that body errors are visible.

## Do

- Within an existing modal record dialog, use a non-modal DropdownMenu; the outer Dialog continues to own the modal boundary. Keep menu keyboard navigation and Escape behavior.
- On a dialog-to-dialog handoff, leave focus in the newly opened dialog. Capture a connected workspace fallback for a maintenance preview whose original trigger will disappear.
- Scroll and focus the readable error after a failed fixed-footer action, retaining the draft and allowing a real retry.
- Test menu dismissals that also close the dialog, not only opening and closing the menu itself.

## Avoid

- Do not globally clear body.style.pointerEvents or force-click through a lock; another legitimate modal may still be open.
- Do not add arbitrary delays to business actions to make menu animations finish.
- Do not make standalone menus non-modal by default; this guidance concerns menus already inside a modal boundary.

## Validation

Run the native entry-dialogs-electron test against the current production renderer. Check copy, reject, archive and restore, assert that body/html pointer interaction recovers, cancel a maintenance preview and assert focus returns to the list, and inject one save failure followed by a real successful retry. Inspect the actual error screenshot and long-content footer geometry.

## Related files

- src/pages/TranslationKnowledge/KnowledgeRecordDialog.tsx
- src/pages/TranslationKnowledge/index.tsx
- src/pages/TranslationKnowledge/KnowledgeSidebar.tsx
- test/translation-knowledge/entry-dialogs-electron.test.ts
