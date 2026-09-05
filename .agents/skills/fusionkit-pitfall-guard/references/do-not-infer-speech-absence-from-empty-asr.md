# FK-PIT-0106: Do not infer speech absence from empty ASR output

## Area

Local subtitles / speech evidence / ASMR quality assessment.

## Triggers

Empty transcript, missing quiet speech, whispers, ASMR, Silero VAD, valid timestamps, speech coverage.

## Symptoms

A complete-duration empty server response passes structural tests, while the user reports audible words without subtitles. Tightening hallucination filters can increase missing speech.

## Root cause

The current raw gate classifies speech from the presence of transcript text. This validates a response contract but provides no independent acoustic evidence. The same VAD exclusion and the resulting empty ASR response are not independent confirmations of silence.

## Do

- Distinguish response validity, speech evidence and transcription accuracy.
- Describe the current empty-response acceptance honestly until an acoustic evidence service exists; do not claim this review implemented one.
- Compare independently obtained speech candidates with transcript coverage, including regions the first VAD excluded.
- Treat missing detector evidence as unknown, not measured silence.
- For ASMR, compare bounded regions using original audio, wider context and a relaxed/no-VAD candidate; keep nonverbal sounds distinct from words.
- Record uncertain regions and preserve original text before replacement.
- Verify the provenance of existing SRT/LRC files before attributing them to FusionKit.

## Avoid

- Do not force text into every empty interval or equate sound energy with speech.
- Do not use subtitle display duration as proof that every word was recognized.
- Do not label an LRC start-time gap as an omitted sentence without audio review.
- Do not copy energy thresholds calibrated on separated vocals to unprocessed binaural audio.

## Validation

Existing post-processor tests establish the current empty-response contract. A future quality change must cover actual silence, quiet words, nonverbal ASMR sounds, missing detector data and bounded recovery. Real audio listening/A-B is required to claim recall improvement; source-read statistics are insufficient.

## Related files

- `electron/main/local-subtitle/subtitle-post-processor.ts`
- `electron/main/local-subtitle/production-executor.ts`
- `test/local-subtitle/subtitlePostProcessor.test.ts`
- `docs/v0.2.11/subtitle-quality-harness/finesub-review-and-proposal.md`
