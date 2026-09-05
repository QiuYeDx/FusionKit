# FK-PIT-0113: Keep window stability separate from transcription truth

## Area

Local subtitles / candidate review.

## Triggers

Short window, context shift, no-VAD rescue, agreement, raw repeats, short-cue merging.

## Symptoms

A core cue agrees across two contexts while surrounding words vary. A no-VAD pass produces a complete lexical sentence on a nonverbal control. Display shaping merges repeated raw cues so repetition is less obvious in the final cue count.

## Root cause

Changing input context changes the decoder's evidence and language prior; multiple crops of the same audio with the same model are correlated observations, not independent ground truth. Display shaping is a presentation transform and can hide the original segmentation needed for review.

## Do

- Bound the experiment before running it and use fresh processes when comparing VAD modes.
- Compare whole-window text and matching individual cues separately; preserve unmatched additions, empty outputs and lexical differences.
- Map every native timestamp through its own input origin. Keep native overruns visible in diagnostics even if the production pipeline safely clamps them.
- Carry the existing pre-shaping localReview report into any future user review flow; do not reconstruct all risks from merged display cues alone.
- Keep candidates unverified and preserve a nonverbal control. Require actual text and boundary evidence before accepting replacements or promoting ASR names to confirmed translation terminology.

## Avoid

- Do not treat matching starts within 10 ms as 10 ms accuracy without human reference boundaries.
- Do not accept a whole window because one core phrase matches or its output is shorter.
- Do not call an empty ASR result proof of silence, or a structurally valid sentence proof of speech.
- Do not rerun completed inference merely because downstream report validation failed; preserve the response and stay within the request budget.

## Validation

On 2026-09-05, 12 fresh-process large-v3/CUDA requests compared two contexts each for B speech, C core and B nonverbal control, with VAD on/off. C's VAD core cue matched with start spread 10 ms and end spread 270 ms, but an extra response word differed. The tight nonverbal no-VAD window generated a complete lexical sentence. A native 20 ms overrun was preserved in the experiment and correctly clamped with a production warning during replay. Four repeated raw cues became two display cues, while localReview retained the original repeated_text concern. All six candidate comparisons prohibited automatic replacement. Six comparison tests and 93 local-review/postprocessor tests passed; all 12 recorded process IDs had exited, and source/crop fingerprints were unchanged.

## Related files

- `scripts/local-subtitle/benchmark/window-stability.mjs`
- `scripts/local-subtitle/benchmark/window-stability.test.mjs`
- `electron/main/local-subtitle/local-review.ts`
- `electron/main/local-subtitle/subtitle-post-processor.ts`
- `test/local-subtitle/subtitlePostProcessor.test.ts`
- `docs/v0.2.11/subtitle-quality-harness/phase8-window-stability.md`
