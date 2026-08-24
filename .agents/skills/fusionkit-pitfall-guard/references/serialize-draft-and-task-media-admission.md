# FK-PIT-0087: Serialize draft and committed media admission

## Area

Electron / local subtitle media admission / renderer draft state

## Triggers

- `probeMedia`, `verifyRuntime`, `normalizeTask`, `materializeWindow`
- adding a file while transcription is running
- starting another task while one task is active
- existing draft metadata returns to loading
- active task fails with `limit_exceeded`

## Symptoms

- Appending one file resets the format, duration, and audio-track metadata of every existing draft row.
- A new draft probe or enqueue-time runtime verification starts while an active task is between PCM window operations.
- The active task's next media operation is rejected with `limit_exceeded`, even though no content or versioned size limit was exceeded.
- The failure appears nondeterministic because whichever operation enters the single-owner gate first survives.
- After the product UI removes batches, repeated small submissions can still hit a hidden legacy batch-count limit.

## Root cause

The renderer treated any `selectedFiles` array change as a new collection and rebuilt every probe and audio-selection record. Independently, the main media normalizer enforced one active operation per owner with a fail-fast second-operation rejection. Draft probes, enqueue verification, normalization, and PCM window operations share that owner, so normal product actions were misclassified as limit violations. A separate session-registry limit still counted internal batches even after the UI became a flat task queue, creating another user-invisible route to the same error code.

## Do

- Reconcile draft probe state by stable `fileToken`; retain existing ready/error metadata and explicit stream selections, and probe only newly added files.
- Keep the native media concurrency limit at one active operation per owner.
- Put later same-owner operations into a bounded, abort-aware wait queue rather than failing the second operation.
- Abort both active and queued operations on owner release or fault, and include queued settlements in shutdown cleanup.
- Report actual queue saturation as retryable `resource_busy`; reserve `limit_exceeded` for versioned file, duration, stream-count, byte, and response-budget limits.
- Bound flat sessions by total task count. Keep any internal batch cap only as a defensive ceiling and derive artifact capacity from the task cap so a refactor cannot silently expand resource budgets.
- Test both directions: draft behind task work and committed task work behind a draft probe.

## Avoid

- Do not reset all probe maps or audio-stream choices when one file is appended.
- Do not increase native media concurrency to hide the race.
- Do not expose an internal batch-count ceiling as a product-level task failure after batches have been removed from the UI.
- Do not retry `limit_exceeded` blindly in the renderer or suppress it globally; real bounded-content violations must remain terminal and visible.
- Do not let queued operations survive owner release or shutdown cleanup.

## Validation

- Run the media-normalizer tests covering serialized probes, committed preparation behind a draft probe, bounded queue saturation, and owner release.
- Run the transcriber model/page tests proving appended files preserve existing metadata and selections.
- Run the session-registry test proving more than ten flat submissions work while the total task bound still rejects true overflow.
- Run Job Manager and production executor regressions because enqueue runtime verification and PCM window operations use the same normalizer.
- Run TypeScript, preload bundle validation, and the root renderer/main/preload Vite test build.
- In Electron, start a transcription, append another file, then start the new ready task; confirm the original task never changes to `failed / limit_exceeded`.

## Related files

- `electron/main/local-subtitle/media-normalizer.ts`
- `electron/main/local-subtitle/job-manager.ts`
- `electron/main/local-subtitle/production-executor.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/index.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.ts`
- `test/local-subtitle/mediaNormalizer.test.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.test.ts`
