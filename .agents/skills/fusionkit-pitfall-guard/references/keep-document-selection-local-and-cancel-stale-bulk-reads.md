# FK-PIT-0149: Keep document selection local and cancel stale bulk reads

## Area

Frontend / bulk document selection

## Triggers

select all, checkbox delay, global busy, reading flash, pending clear, late selection response

## Symptoms

Selecting checkboxes briefly disables unrelated import/export/preview actions or shows a reading indicator. A slow cross-page selection can restore checkboxes after the user clears them or changes the query.

## Root cause

The local selection action was routed through the foreground document reader wrapper. That wrapper acquired global busy state and reconciled the body even though selection does not modify documents. Removing the wrapper alone also removes the lifetime and ordering protection previously inherited from it.

## Do

Select from an already loaded bounded summary cache synchronously. If a cross-page request is necessary, show pending beside the selection control only. Keep the request single-flight and fence its result by a selection generation, query identity, component lifetime, observed revisions and deletion tombstones. Clear/toggle/query/page/view changes cancel the pending generation. A late finally block must not clear a newer request's pending state. Let clear-selection remain available during pending even when the current selected count is zero.

## Avoid

Do not treat every explicit click as a foreground document operation. Do not borrow the page's disabled/aria-busy state for selection, reread the body, or merely hide the flash with CSS. Do not apply an old list response over a user's newer checkbox intent. Do not remove bounded selection limits or revision checks.

## Validation

Run interaction-workspace-ui.test.ts in actual Electron. Observe disabled/aria-busy/status mutations and body-read counts during cached selection; delay the real list handler for cross-page selection and test clear, toggle, query, remount, deletion and duplicate clicks. Check visible local pending and the existing 100-document bound. Repeat acceptance-live-refresh-ui.test.ts to preserve independent background reconciliation.

## Related files

- src/pages/Tools/Subtitle/SubtitleStudio/index.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/StudioLibrary.tsx
- test/subtitle-studio/interaction-workspace-ui.test.ts
- keep-background-reconciliation-separate-from-foreground-activity.md
