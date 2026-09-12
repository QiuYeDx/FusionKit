# FK-PIT-0147: Keep background reconciliation separate from foreground activity

## Area

Frontend / event-driven document readers

## Triggers

translation progress, global busy, disabled flash, silent refresh, queued click

## Symptoms

Repository events must update content silently without borrowing foreground loading state or dropping explicit actions.

## Root cause

Subtitle Studio routed every repository change through the same run/load wrapper used by explicit user operations. That wrapper toggled whole-page activity, cleared notices and copy feedback, and reread the current body for unrelated document events. A one-operation guard also discarded a user click arriving during an automatic load.

## Do

Use one bounded reader coordinator with coalesced background invalidations and a foreground queue. A background read preserves the rendered data and feedback; an explicit action acquires visible busy state and runs after the current reader. Re-read the current body only when its revision changes. Keep query identity, observed revisions, deletion tombstones and component-lifetime guards when applying results. New events during a read request a subsequent read.

## Avoid

Do not use CSS opacity or loading skeleton suppression to hide the underlying busy transitions. Do not remove the single-reader guard or silently drop the pending user action. Do not clear notices, copied state, track selection or the preview merely because another document progressed.

## Validation

Run refresh-coordinator.test.ts and the actual gated acceptance-live-refresh-ui.test.ts. Observe disabled/aria-busy mutations during controlled translation batches, count body reads for current and unrelated documents, and test slow-reader navigation, query changes, scrolling, focus, copy feedback, dialogs and deletion/unmount barriers. UI evidence must use the current renderer/main/preload build.

## Related files

- src/services/subtitle-studio/refresh-coordinator.ts
- src/pages/Tools/Subtitle/SubtitleStudio/index.tsx
- test/subtitle-studio/refresh-coordinator.test.ts
- test/subtitle-studio/acceptance-live-refresh-ui.test.ts
- join-library-refresh-before-opening-task-documents.md
