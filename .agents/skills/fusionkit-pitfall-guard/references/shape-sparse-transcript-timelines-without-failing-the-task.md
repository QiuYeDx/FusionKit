# FK-PIT-0096: Shape sparse transcript timelines without failing the task

## Area

Local subtitle inference / raw quality gates / canonical cue shaping.

## Triggers

`transcript_quality_failed`, `overlong_segment`,
`text_cannot_cover_timeline_without_duplication`, sparse speech, ASMR, long
pauses, the same ordinary media file sometimes passes after retry.

## Symptoms

- A valid WAV reaches the end of CUDA inference but fails in `post_processing`.
- Bounded replays recognize every window, yet one natural Whisper segment lasts
  15-22 seconds and repeatedly triggers smaller-window recovery.
- Final shaping fails when only one or two graphemes own a long raw time range,
  because there are not enough text units to fill several maximum-duration cues.

## Root cause

Whisper segment boundaries are decoder timing evidence, not a requirement that
subtitle text remain visible for every millisecond in the interval. Treating the
raw segment-duration limit as transcript corruption conflates inference quality
with presentation policy. Requiring text partitions to cover the entire sparse
interval then leaves only two bad choices: duplicate text or reject valid media.

## Do

- Keep contract, positive-duration, order, overlap, media bounds and degenerate
  repetition as transcript-validity checks.
- Record overlong raw segments for diagnostics, but pass valid text to canonical
  shaping.
- Preserve the accepted segment's interval when no supported internal acoustic
  boundary exists. Display duration and character settings are soft targets.
  Do not split by character count or cap a sparse cue's end by the display budget.
  Retain text once and report the long span for bounded review.
- The earlier estimated split/cap workaround was superseded on 2026-09-05 by
  `sentence_readable_v2`; see FK-PIT-0116 for timing provenance requirements.
- Prove the exact failing media completes inference, shaping, serialization and
  export; a synthetic unit test alone is not enough for this class of failure.

## Avoid

- Do not make `raw duration > 15 seconds` sufficient evidence of hallucination.
- Do not duplicate a short phrase merely to cover a long decoder interval.
- Do not disable timeline and repetition guards to make one sample pass.
- Do not report success after inference only; the canonical export must exist and
  its timestamps must be ordered and media-bounded.

## Validation

- Assess a 22-second valid segment as accepted while reporting it as overlong.
- Preserve a 22-second `うん` segment once at its accepted start/end, with a
  preserved-segment diagnostic and no invented timing. This does not prove that
  speech occupies its whole raw interval.
- Keep malformed, reversed, overlapping, out-of-window and repeated-loop fixtures
  failing closed.
- Run the real sparse-speech media through the Electron workflow and validate the
  exported SRT/LRC timestamp order and final media bound.

## Related files

- `electron/main/local-subtitle/subtitle-post-processor.ts`
- `test/local-subtitle/subtitlePostProcessor.test.ts`
- `electron/main/local-subtitle/production-executor.ts`
