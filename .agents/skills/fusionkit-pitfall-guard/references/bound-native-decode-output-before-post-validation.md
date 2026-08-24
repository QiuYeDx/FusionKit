# FK-PIT-0042: Bound native decode output before post-validation

## Area

Native media normalization, disk-space safety, FFmpeg process contracts.

## Triggers

`ffprobe` duration, `-t`, `-fs`, disk exhaustion, short-reported duration,
post-hoc WAV validation, normalized PCM limits.

## Symptoms

- Disk preflight passes for a short reported duration, but FFmpeg writes a much larger PCM.
- A corrupt or adversarial container consumes available disk before WAV inspection rejects it.
- A source reports one duration while a much longer normalized output receives a valid brand.

## Root cause

Probe metadata is untrusted input and only supports estimation. A global post-hoc file-size or
duration check runs after the expensive write, so it cannot protect disk capacity or prove that
the decoded timeline stayed within the probed boundary.

## Do

- Derive a bounded duration plus a small versioned tolerance from the trusted probe result.
- Pass both FFmpeg output duration and byte limits (`-t` and `-fs`) before the output target.
- Keep a small process-cap sentinel beyond the accepted duration boundary so an exact global-limit
  input can succeed while a longer stream cannot be silently truncated to the largest valid value.
- Reserve disk from the enforced byte cap, not only from the optimistic estimate.
- Inspect the completed WAV and reject an actual frame duration or file size that reaches or
  exceeds the trusted cap; a clean FFmpeg exit is not proof that truncation did not occur.
- Keep the global PCM/duration limits as a second independent ceiling.

## Avoid

- Do not treat `ffprobe format.duration` as authoritative resource accounting.
- Do not rely only on timeout or a 12 GiB parse-back guard to prevent disk exhaustion.
- Do not accept a valid WAV header as proof that the full selected timeline was decoded.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/mediaNormalizer.test.ts test/local-subtitle/pcmWindow.test.ts
node_modules/.bin/tsc --noEmit
```

Cover a source that reports a short duration while the fake decoder writes through the configured
boundary. Assert exact `-t`/`-fs` argv, rejection before branding, complete session cleanup, and the
rounded maximum-duration frame boundary.

## Related files

- `electron/main/local-subtitle/media-normalizer.ts`
- `electron/main/local-subtitle/pcm-window.ts`
- `test/local-subtitle/mediaNormalizer.test.ts`
- `test/local-subtitle/pcmWindow.test.ts`
