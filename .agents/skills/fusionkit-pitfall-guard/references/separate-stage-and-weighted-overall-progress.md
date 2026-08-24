# FK-PIT-0095: Keep task progress scoped to the meaningful long-running stage

## Area

Frontend / staged task progress

## Triggers

progress bar, i/n, completedWindows, totalWindows, stageProgress, overallProgress, transcription-only progress, percentage mismatch

## Symptoms

- A task shows `6/32`, a stage percentage, and an overall percentage even though only transcription takes meaningful time.
- Fast preparation, model transition, post-processing, and export stages display short-lived progress bars that add visual noise.
- Users cannot tell which of several percentages is the useful transcription estimate.

## Root cause

Window counts and `stageProgress` describe completion inside transcription, while `overallProgress` is a weighted state-machine projection across every stage. Exposing both domains in the compact task list makes valid backend values look contradictory and gives fast stages more visual weight than their duration warrants.

## Do

- Keep the full staged payload in the backend for execution and diagnostics.
- In the local-subtitle task list, return a progress display only while task status is `transcribing`.
- When valid `completedWindows/totalWindows` values exist, derive the sole displayed percentage from that fraction; otherwise fall back to `stageProgress`.
- Bind the bar and the single percentage label to the same clamped value. An aligned `i/n` window count may remain beside it.
- Hide the entire progress row during queued, preparation, model-loading, post-processing, export, cancellation, and terminal states.

## Avoid

- Do not show both stage and weighted overall percentages in the compact queue.
- Do not bind the bar to `overallProgress` while labeling it with transcription window counts.
- Do not change backend stage weights just to simplify renderer presentation.
- Do not leave a 0%/100% progress row flashing during fast non-transcription stages.

## Validation

- Cover a weighted example such as `6/32`, transcription `19%`, and overall `39%`, asserting that the display contains only `19%`.
- Cover invalid window counts falling back to clamped `stageProgress`.
- Verify every non-transcription status returns no progress display.
- Verify that the label and bar both reference the same `percent` field.
- Run:
  - `vitest run src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.test.ts`
  - `vitest run src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberPage.test.ts`

## Related files

- `electron/main/local-subtitle/production-executor.ts`
- `src/type/localSubtitle.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/LocalSubtitleTaskQueue.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.ts`
