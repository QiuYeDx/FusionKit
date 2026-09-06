# FK-PIT-0120: Trace experimental policy through user task settings

## Area
Local subtitles / rollout / task snapshots.

## Triggers
Experiment fixes a sample, pnpm dev repeats old output, constructor-only strategy, frozen retry config.

## Symptoms
A native experiment produces better subtitles, but users keep obtaining the unchanged default output after updating code.

## Root cause
The improved policy exists only as an internal constructor override. Source availability and experimental acceptance do not make it selectable in a normal task.

## Do
Trace saved preferences, strict IPC, immutable task snapshots, retry cloning, executor selection and task details. Test the task-config route without a constructor override. Distinguish a selectable experimental policy from default rollout and from quality acceptance. State whether a user must create a new task rather than retry an old one.

## Avoid
Do not label experimental output as the current default, silently migrate old tasks, or postpone usability behind repeated sample-specific evidence collection. Known regressions remain open even after the experimental option ships.

## Validation
Legacy missing fields retain the old strategy; unknown IPC values fail. Selection survives reload, reaches the executor and survives ordinary / CPU retries. Compare private real outputs without modifying source media; distinguish archived inference from a fresh run.

## Related files
- src/type/localSubtitle.ts
- src/type/localSubtitleIpc.ts
- electron/main/local-subtitle/job-manager.ts
- electron/main/local-subtitle/production-executor.ts
- docs/v0.2.11/subtitle-quality-harness/phase13-cross-window-reconciliation/pause-product-entry.md

## Authorized default rollout and dependencies
When the user explicitly accepts a phase's known limitations and asks to promote it, update the rollout contract rather than treating the old experimental gate as immutable. Migrate reusable preferences once, preserve later explicit choices and immutable queued-task snapshots, and enforce required dependent settings in both preference normalization and the new-task IPC contract. Test real hydration as well as the initial default; changing a constant alone does not upgrade existing installations.
