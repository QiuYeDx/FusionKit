# FK-PIT-0152: Separate navigation intent from loaded preview

## Area
Frontend / async document navigation

## Triggers
Delayed current-row highlight, document switch, global disabled flash, rapid clicks, stale preview.

## Symptoms
Selecting a document waits for its body to load and disables unrelated controls; early clicks can overwrite the latest choice.

## Root cause
The current row was derived only from the loaded page, while navigation used the same global activity lock as mutations. Background-reader isolation alone (FK-PIT-0147) does not make explicit navigation responsive.

## Do
Store the requested document immediately, independently of loaded data. Keep navigation on the existing single-reader coordinator, but give it local pending/error state and a generation guard. Skip superseded queued jobs; fence both foreground and background results before applying them. Invalidate navigation when a mutation takes authority or the target is deleted. Preserve revision and lifetime checks. Keep old preview controls inert while loading; preserve loading content through a short opacity exit and honor reduced motion. Failed navigation retains the requested target and offers retry.

## Avoid
Do not remove reader serialization, turn a failed request into an apparently successful old preview, or dim/disable the entire tool for document navigation. Do not use CSS alone to conceal the global activity transition.

## Validation
Use a real main/preload reader with deliberately delayed responses. Check immediate row highlight, enabled unrelated controls, intermediate queued clicks skipped, latest result winning, failure/retry and deletion barriers. Run translation-background-refresh and context-menu regressions; inspect final loading and dense-list screenshots.

## Related files
- src/pages/Tools/Subtitle/SubtitleStudio/index.tsx
- src/services/subtitle-studio/refresh-coordinator.ts
- test/subtitle-studio/library-navigation-ui.test.ts
- test/subtitle-studio/acceptance-live-refresh-ui.test.ts
