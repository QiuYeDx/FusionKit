# FK-PIT-0040: Stream native progress without capture overflow

## Area

Native media processes, FFmpeg progress, long-running local inference preparation.

## Triggers

`FFmpeg`, `-progress`, `stdoutMaxBytes`, `outputExceeded`, long media, streamed stdout.

## Symptoms

- Short conversions pass while long media is terminated after a repeatable duration.
- The process reports `outputExceeded` even though every progress line is valid.
- Raising the capture limit only delays the failure and increases memory use.

## Root cause

Machine-readable progress is proportional to task duration, while captured diagnostics
must have a fixed memory bound. Treating the complete progress stream as retained stdout
eventually exhausts any finite capture limit.

## Do

- Separate stdout `capture` and `stream` modes in the native process contract.
- In stream mode, forward chunks to a bounded line parser and discard them after parsing.
- Bound each unfinished line and callback failure, not the legitimate lifetime byte total.
- Keep stderr diagnostics bounded and require the process `close` event before cleanup.
- Test streamed output larger than the normal capture cap without allocating it all at once.

## Avoid

- Do not solve long progress by choosing a larger arbitrary stdout buffer.
- Do not send a truncated retained chunk to the progress parser.
- Do not disable stderr bounds or treat `exit`/`kill()` as a close confirmation.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/mediaProcess.test.ts test/local-subtitle/mediaNormalizer.test.ts
node_modules/.bin/tsc --noEmit
```

Confirm capture mode still terminates excessive diagnostics, stream mode retains zero
stdout bytes, all progress chunks reach the parser, and cleanup waits for real close.

## Related files

- `electron/main/local-subtitle/media-process.ts`
- `electron/main/local-subtitle/media-normalizer.ts`
- `test/local-subtitle/mediaProcess.test.ts`
- `test/local-subtitle/mediaNormalizer.test.ts`
