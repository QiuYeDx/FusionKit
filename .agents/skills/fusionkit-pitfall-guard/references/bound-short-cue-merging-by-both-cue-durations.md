# FK-PIT-0114: Bound short cue merging by both cue durations

## Area

Local subtitles / default output shaping.

## Triggers

Early subtitle, concatenated sentence, short cue merge, repeated utterance.

## Symptoms

A several-second decoder cue is merged with its next cue because the combined interval fits the maximum display duration. The next cue's words then appear seconds before its original onset. Several repeated cues can also become one caption with repeated text inside it.

## Root cause

The former canMergeShortCues checked the gap, combined length/capacity and terminal punctuation, but did not check that either input was short. Missing punctuation in ASR output allowed independent readable utterances to be joined. Presentation merging does not provide evidence for moving later words earlier.

## Do

- Preserve adjacent segment-only cues whenever their semantic relationship is unknown, regardless of duration, gap or script. The former 1000 ms / 300 ms guard was an interim mitigation, superseded by `sentence_readable_v2` on 2026-09-05; see FK-PIT-0116. Future joins need explicit textual and timing evidence.
- Keep normalized identical cues separate. Preserve real repetition and each occurrence's timing; do not delete repeated speech as a formatting fix.
- Verify the final serialized output through the default production executor, not only an isolated comparator or diagnostic report.
- Compare raw text and final text to prove no word loss or duplication. Clearly distinguish decoder errors from errors introduced by output shaping.

## Avoid

- Do not call every pair fitting a seven-second combined interval short cues.
- Do not infer absent sentence boundaries from absent punctuation alone.
- Do not claim ASR accuracy improved merely because final cue count increased or output changed.

## Validation

The phase12 follow-up removes the remaining unsupported short-cue merger entirely. Production-executor SRT/LRC tests preserve independent sub-second utterances; no extra inference is introduced. The earlier measurements below describe the preceding mitigation, not the current merge policy.

On 2026-09-05, replay of 22 stored real large-v3 responses through before/after production shaping generated and parsed 88 SRT/LRC files. Six outputs preserved previously merged boundaries after the fix; all retained the same non-whitespace text. One B local VAD response stopped exposing its later response word 3.67 seconds early. The original A/B/C 30-second outputs did not change, so their ASR issues remain unresolved. 177 relevant tests and TypeScript checks passed; the new production-executor test reads the exported SRT to confirm independent cues without extra inference.

## Related files

- `electron/main/local-subtitle/subtitle-post-processor.ts`
- `test/local-subtitle/subtitlePostProcessor.test.ts`
- `test/local-subtitle/productionExecutor.test.ts`
- `docs/v0.2.11/subtitle-quality-harness/phase9-default-transcription-fixes.md`
