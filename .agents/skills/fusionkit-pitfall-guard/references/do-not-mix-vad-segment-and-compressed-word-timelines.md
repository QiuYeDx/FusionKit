# FK-PIT-0032: Do not mix VAD segment and compressed word timelines

## Area

Local inference / whisper.cpp VAD / subtitle timeline normalization.

## Triggers

VAD, token timestamps, word timestamps, compressed timeline, subtitle shifted
early, segment time correct, silence removal, mapped timestamps

## Symptoms

- VAD removes static hallucinations, but later subtitles are shifted earlier by
  the accumulated removed silence.
- A `verbose_json` segment has the correct original-media time while its words
  start near zero or otherwise lie outside that parent segment.
- Merge logic prefers words, reconstructs text and cue time from them, and
  silently overwrites a correct segment timeline.
- SRT/LRC parse-back and monotonic checks still pass because the compressed
  timestamps remain structurally valid.

## Root cause

In the pinned `whisper.cpp v1.9.1` server, VAD segment timestamps are mapped
back to the original media timeline, but token/word timestamps can remain on the
silence-compressed inference timeline. FusionKit's owned-core merger previously
preferred any available words, so it discarded the correct segment time. The
response therefore contains two individually plausible but incompatible time
domains.

## Do

- Force `token_timestamps=false` whenever the v1.9.1 VAD request is enabled;
  renderer input must not be able to override this pairing.
- Normalize VAD output from mapped segment timestamps only.
- Independently require every non-VAD word interval to be valid, ordered and
  contained within its parent segment with a small fixed tolerance.
- Fall back to the parent segment and record a diagnostic when a word timeline
  violates that invariant.
- Keep bounded-window raw transcript gates and controlled shorter-window retry;
  VAD does not replace decoder-loop validation.
- Test with a fixture whose segment is `13.70-17.28 s` while its first word is
  `0-0.44 s`, and require final absolute time to use the segment.

## Avoid

- Do not assume all timestamp fields in one upstream JSON response share a time
  domain.
- Do not repair the shift with one global offset; removed silence accumulates
  non-linearly.
- Do not reconstruct VAD cue text or ownership from compressed words.
- Do not enable a user-facing `VAD + word timestamps` combination until that
  exact runtime path has original-media word mapping and real-sample evidence.
- Do not replace the structured server contract by parsing the standalone VAD
  example's human-readable output; the pinned source and README even disagree
  about its printed time unit.

## Validation

```text
node --test scripts/local-subtitle/whisper-server/supervisor.test.mjs
node --test scripts/local-subtitle/whisper-server/transcript-quality.test.mjs
node scripts/local-subtitle/whisper-server/run-poc.mjs <ignored Metal/CPU arguments>
```

Confirm the VAD multipart request contains `token_timestamps=false`, parsed VAD
segments contain no words, out-of-parent word fixtures increment
`wordTimelineFallbackCount`, silent windows produce no hallucinated cue, later
speech retains original-media time, and the media tail remains covered.

## Related files

- `scripts/local-subtitle/whisper-server/supervisor.mjs`
- `scripts/local-subtitle/whisper-server/transcript-quality.mjs`
- `scripts/local-subtitle/whisper-server/run-poc.mjs`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/poc/pre004-macos-arm64-results.json`
