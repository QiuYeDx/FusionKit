# FK-PIT-0031: Do not treat subtitle parse-back as transcript validity

## Area

Local inference / whisper.cpp / subtitle output acceptance.

## Triggers

parse-back passed, repeated subtitle lines, decoder loop, hallucination,
timestamp beyond media duration, incomplete transcript, whole-file inference.

## Symptoms

- Generated SRT and LRC parse back successfully but contain tens or hundreds of
  consecutive copies of one sentence.
- The last timestamp reaches the media end while most later speech was never
  transcribed, or a cue extends beyond the real media duration.
- Language detection, backend verification and formatter round-trip all pass,
  so a PoC is reported as successful even though the artifact is unusable.
- Removing duplicate cues makes the file shorter but cannot recover the speech
  that the decoder skipped while it was stuck.

## Root cause

Parse-back proves only that FusionKit serialized and parsed its own cue data
without structural loss. It says nothing about whether upstream inference
covered the audio or produced non-degenerate text. A long whole-file
`whisper-server` request can enter a repeated decoder state while still
returning valid `verbose_json`, monotonically increasing timestamps and HTTP
200. Backend-dependent numerical differences can change the severity without
making the issue GPU-only.

## Do

- Validate raw upstream segments before formatting or dropping invalid cues.
- Check positive-duration, monotonic, non-overlapping and media-bounded
  timestamps with an explicit tolerance.
- Measure normalized consecutive repetition by both cue count and covered
  duration. Treat a long run as a quality failure requiring inspection or
  retry, not as ordinary repeated dialogue.
- Keep backend/runtime readiness separate from transcript validity in PoC
  reports and progress ledgers.
- Replay suspicious intervals as bounded independent windows. If the same
  backend recognizes the window correctly, investigate whole-file decoder
  state, chunking and merge policy before changing the model or backend.
- Preserve raw results only in ignored local storage and commit a sanitized
  failure summary.

## Avoid

- Do not call `srtParseBack=true` or `lrcParseBack=true` a content-quality pass.
- Do not spot-check only the first few segments; decoder loops often begin at a
  later internal window boundary.
- Do not fix a stuck transcript by deduplicating output. That hides the symptom
  and permanently drops unrecognized audio.
- Do not blame Metal, FFmpeg or silence from one artifact without comparing raw
  JSON, another backend and bounded-window replays.

## Validation

For every PRE/QA real-sample run, record:

```text
raw segment count and normalized unique-text count
longest consecutive repeated run (cue count and duration)
zero/negative-duration, overlap and out-of-media-bound counts
first/last covered timestamp versus probed media duration
bounded-window replay results for every detected degenerate region
```

Require both structural SRT/LRC parse-back and transcript-validity checks. A
heuristic flag may require manual review for legitimate choruses, but it must
never be silently converted into a pass.

## Related files

- `scripts/local-subtitle/whisper-server/run-poc.mjs`
- `scripts/local-subtitle/whisper-server/subtitle-smoke.mjs`
- `docs/v0.2.11/local-subtitle-transcriber/poc/pre004-macos-arm64-results.json`
- `docs/v0.2.11/local-subtitle-transcriber/fix/2026-07-17_local-subtitle-transcriber_whole-file-decoder-repetition.md`
