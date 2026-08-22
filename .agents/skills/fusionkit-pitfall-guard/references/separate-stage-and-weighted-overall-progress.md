# FK-PIT-0095: Separate stage and weighted overall progress

## Area

Frontend / staged task progress

## Triggers

progress bar, i/n, completedWindows, totalWindows, stageProgress, overallProgress, weighted stages, percentage mismatch

## Symptoms

- A task shows `6/32` beside `39%`, making the percentage or progress bar look mathematically wrong.
- The backend progress payload is internally valid, but the UI places two different progress domains next to each other without labels.
- Users cannot tell whether the bar represents the current stage or the entire multi-stage task.

## Root cause

Window counts describe completion inside the transcription stage, while `overallProgress` is a weighted projection across preparation, model loading, transcription, post-processing, and export. For example, transcription may occupy only the 30–80% range, so `6/32` can legitimately coexist with `39%` overall.

## Do

- Treat `stageProgress` and `overallProgress` as separate named values.
- When valid `completedWindows/totalWindows` values exist, derive the displayed stage percentage directly from that fraction so the two stage indicators agree.
- Label both percentages when they differ, for example `6/32 · Stage 19% · Overall 39%`.
- Bind the progress bar to the explicitly labeled percentage it represents.
- Clamp display values and test boundary/invalid-count fallbacks.

## Avoid

- Do not present `i/n` and weighted `overallProgress` as if they share one denominator.
- Do not change backend stage weights merely to make an unlabeled renderer display look plausible.
- Do not hide which progress domain drives the bar.

## Validation

- Cover a weighted example such as `6/32`, stage progress near `19%`, and overall progress `39%`.
- Verify that the label and bar both reference the intended derived display model.
- Run:
  - `vitest run src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.test.ts`
  - `vitest run src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberPage.test.ts`

## Related files

- `electron/main/local-subtitle/production-executor.ts`
- `src/type/localSubtitle.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/LocalSubtitleTaskQueue.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.ts`
