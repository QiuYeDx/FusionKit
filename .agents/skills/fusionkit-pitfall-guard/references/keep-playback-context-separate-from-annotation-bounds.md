# FK-PIT-0111: Keep playback context separate from annotation bounds

## Area

Local subtitle listening tools / human feedback interpretation.

## Triggers

Listening notes, playback padding, manual seek, word tail, truncated syllable, annotation JSON, exact timing claims.

## Symptoms

A reviewer says a short region contains the previous word's tail, and an agent infers that a subtitle ended before that region. The playback actually includes surrounding context or the reviewer manually sought to an earlier point.

## Root cause

The review region describes what to investigate; it does not describe everything the reviewer heard. A v1 export omitted playback settings, and qualitative comments were mistakenly treated as precise acoustic boundaries.

## Do

- Treat free listening notes as qualitative evidence unless the user explicitly supplies exact boundaries.
- Show the concern interval and requested playback interval separately.
- Preserve request origin, padding and speed when available, with an explicit request-only label. Manual seeking is not captured by a playback request.
- Import old judgments without inventing missing playback history.
- Correct earlier timing conclusions when scope ambiguity is discovered; do not make the user repeat useful qualitative work.

## Avoid

- Do not assume an unchanged default setting without evidence.
- Do not infer exact tail location from a note associated with a small region.
- Do not equate a successful play request with proof that its complete range was heard.

## Validation

On 2026-09-05 the user clarified that they freely sought forward/backward to find complete speech. C-late-2's 20.15-20.84 s concern would request 19.15-21.84 s with default context, but actual historical listening remains unknown. The precise tail-overrun claim was withdrawn. v2 imports preserve all eight original judgments and mark missing history null; browser interaction is still unverified due to local URL policy.

## Related files

- `scripts/local-subtitle/benchmark/listening-review.html`
- `scripts/local-subtitle/benchmark/build-listening-review.mjs`
- `docs/v0.2.11/subtitle-quality-harness/phase6-forced-alignment.md`
