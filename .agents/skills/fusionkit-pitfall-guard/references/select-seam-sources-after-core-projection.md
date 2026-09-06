# FK-PIT-0119: Select seam sources after core projection

## Area
Local subtitles / overlapping windows / provenance.

## Triggers
leftRaw.at(-1), rightRaw[0], core clipping, repeated sentences every 25 seconds, missing seam candidate.

## Symptoms
The final adjacent cues repeat a phrase, but a planner requiring the raw window's final segment to equal the final left cue rejects the seam without examining it.

## Root cause
Raw overlap context extends beyond each window's owned core. Its last segment may be entirely outside the core and disappear during projection. Raw array position is therefore not final boundary provenance. Related many-to-one observations can span several raw and final cues.

## Do
Retain source mappings through projection and inspect a bounded group around the actual core boundary. Distinguish detecting a relationship from authorizing deletion. Preserve raw observations and report eligibility, evidence rejection and budget skipping separately.

## Avoid
Do not replace at(-1) with another fixed index, delete short clipped cues by duration, equate similar words with repeated speech, or increase request budgets before checking candidate admission.

## Validation
Include a raw trailing segment wholly outside the core, multi-to-one overlap, genuine repeated utterances and orthographic differences. Compare current full-track output before changing semantics; fewer cues are not independent quality evidence.

## Moved seams can expose different unsupported relationships

2026-09-07 pause-aware full-application regression preserved the accepted two new tracks, but reintroduced duplicates at 142480ms and 192480ms in the older full track. All five proposal types rejected both seams even though budgets were available and the selected left raw segment was the actual projected source. One raw phrase crossed the core boundary while ending 1260ms before the input end; another was a whole-phrase one-to-one variant. Do not misdiagnose every seam miss as raw-tail selection or request budget. Separate projection-source identity, raw temporal overlap, segment-group/text admission, and witness evidence. A phase that passes at fixed cuts must be revalidated when those cuts move; fewer overlapping windows alone does not prove fewer final duplicates.

## Related files
- `electron/main/local-subtitle/subtitle-post-processor.ts`
- `electron/main/local-subtitle/cue-overlap-resolver.ts`
- `electron/main/local-subtitle/cue-prefix-overlap-resolver.ts`
- `docs/v0.2.11/subtitle-quality-harness/phase13-cross-window-reconciliation/diagnosis.md`
