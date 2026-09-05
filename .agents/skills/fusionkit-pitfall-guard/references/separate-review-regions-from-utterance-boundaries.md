# FK-PIT-0110: Separate review regions from utterance boundaries

## Area

Local subtitles / ASMR listening annotations / alignment diagnostics.

## Triggers

Subsecond VAD candidates, clipped syllables, non_speech with word tails, human listening feedback, missing-cue coverage, recovery windows.

## Symptoms

A reviewer hears only a syllable or word tail in a detector-centered listening region. A non_speech selection includes a note describing a preceding spoken ending. Automation can mistake these observations for complete missing sentences or pure nonverbal negatives.

## Root cause

Detector ranges, playback bounds, model input windows, subtitle display intervals and actual utterance boundaries are different. A valid categorical annotation does not erase the nuance of its free-text note; raw ASR can already contain the words while assigning incorrect timestamps.

## Do

- Validate dataset identity, clip hashes and region geometry before applying exported feedback.
- Preserve the original verdict and note together. Keep partial syllables, mixed speech/noise and uncertainty explicit; do not silently relabel.
- Match the described utterance against existing text before calling it missing recognition.
- Evaluate sentence context around adjacent candidates and retain the window origin when mapping timestamps back.
- Keep human boundaries distinct from experimentally selected context windows. Check a confirmed nonverbal control when evaluating no-VAD recovery.
- Record raw model results separately from production post-processed exports and from human truth.

## Avoid

- Do not cut and decode each 0.2–0.7-second VAD island as an independent sentence.
- Do not delete a whole mixed interval solely because its verdict is non_speech.
- Do not count subtitle-uncovered candidates as missing words or classify larger output as better recall.
- Do not trust a low model-reported no_speech_prob as independent speech proof: the B-first listening negative still received lexical output with a near-zero value.

## Validation

On 2026-09-05, all 3 clip hashes and 8 feedback regions matched. Four wider windows were compared in 8 isolated large-v3 calls. C's described sentence was present already with shifted boundaries; B's confirmed nonverbal candidate still produced a word under VAD, and no-VAD produced repeated breath-like text. These establish failure modes, not an accuracy score or an automatically acceptable replacement.

Follow-up production parser/postprocessor replay retained the B raw 3.84-25.34 second interval as four proportionally timed cues. Smaller display cues did not provide acoustic alignment. Include estimated display timing as a review hint, and inspect serialized output before claiming the postprocessor removed the timing or nonverbal-content problem.

## Related files

- `scripts/local-subtitle/benchmark/build-listening-review.mjs`
- `scripts/local-subtitle/benchmark/listening-review.html`
- `scripts/local-subtitle/benchmark/speech-coverage-diagnostics.mjs`
- `docs/v0.2.11/subtitle-quality-harness/phase4-listening-feedback.md`
