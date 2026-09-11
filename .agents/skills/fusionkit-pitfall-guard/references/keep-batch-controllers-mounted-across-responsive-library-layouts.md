# FK-PIT-0127: Keep batch controllers mounted across responsive library layouts

## Area
Frontend / responsive layout / asynchronous lifecycle

## Triggers
Batch result lost, resize, dialog unmount, conditional aside, portal, debounced selection.

## Symptoms
Resizing across the desktop breakpoint removes a running batch dialog and its results although main-process work continues. Selecting a displayed page during a debounced search can also select items from the previous query scope.

## Root cause
Operation state lived inside a replaceable desktop/mobile library branch. Query input changed before displayed rows were replaced, but old selection controls stayed active.

## Do
Keep batch controllers and dialogs mounted at the stable page level; portal only their triggers into responsive library slots. Preserve committed operation results across layout, revision and configuration changes. Track the loaded query separately from the input query and disable stale-result actions until the matching snapshot arrives. Keep preview and batch selection independent, clear selection on search/filter changes, and retain it on pagination/sort.

For a master checkbox that means all matching documents, derive its state with the same predicate as the main-process query, including selected items outside the visible page. A status update can move selected documents out of the filter: scoped deselection must retain those hidden selections, while an explicit clear-selection action can clear the whole set. All open menu items must honor loading state. Keep operation limits explicit and preserve the prior selection when a request exceeds them.

Selection-dependent controls should reuse a stable footer slot when inserting a panel would move the document list. Preserve pagination and jump navigation in that slot, and measure both footer height and list geometry through empty, partial and full selection. Long-running controllers still stay outside replaceable layout branches.

## Avoid
Do not rely on mounted guards alone: they prevent React writes after unmount but do not deliver the continuing operation's result. Do not discard submitted results only because a current form identity has changed. Do not use loading tests that miss the debounce interval or only resize idle screens.

## Validation
In isolated Electron, perform a batch and resize 1280 to 786 and back while retaining its result. Open the narrow library with the keyboard, verify search focus, cross-page selection and no stale-query actions. Inspect final screenshots and stop validation-owned services. Freeze source and test files during dev-renderer runs because Vite can reload for non-production file changes too.

## Related files
- src/pages/Tools/Subtitle/SubtitleStudio/index.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/StudioLibrary.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/StudioTranslation.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/StudioExport.tsx
- test/subtitle-studio/library-ui.test.ts