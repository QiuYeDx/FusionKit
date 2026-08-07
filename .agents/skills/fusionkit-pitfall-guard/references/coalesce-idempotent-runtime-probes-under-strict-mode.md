# FK-PIT-0082: Coalesce idempotent runtime probes under React StrictMode

## Area

Electron / React StrictMode / local subtitle runtime preflight

## Trigger

- `pnpm dev` runs the renderer inside `React.StrictMode`.
- A mount effect immediately invokes an Electron IPC runtime probe.
- The native media owner allows only one concurrent operation.
- The environment card reports `FFmpeg: limit_exceeded`, `backend_unverified`, or disables transcription even though the bundled binaries work when launched directly.

## Symptom

- Direct `ffmpeg -version` and `ffprobe -version` checks succeed and produce small, valid output.
- Two identical runtime probes arrive for the same renderer document while the first is still running.
- The second probe is rejected by the native media concurrency guard with `limit_exceeded`.
- The UI generation guard can discard the first successful result and retain the second failure, making the transient concurrency rejection look like a persistent FFmpeg installation problem.

## Root cause

React StrictMode deliberately re-runs mount effects in development. Cleaning up a renderer effect cannot cancel an Electron IPC request that has already crossed the process boundary. If an idempotent, read-only runtime check enters the same per-owner concurrency gate as media work, duplicate development probes can reject each other.

## Do this instead

- Keep the native media concurrency guard intact for decode, normalization, and transcription operations.
- Add a single-flight layer at the read-only runtime-probe IPC boundary.
- Key in-flight probes by the exact owner identity: `webContentsId`, `ownerSessionId`, `senderId`, `processId`, and `frameId`.
- Remove the entry as soon as the shared promise settles so a manual recheck performs a fresh probe.
- Test both behaviors: simultaneous identical probes share one verifier call, while a later probe invokes the verifier again.
- Confirm the real bundled binaries independently before changing output limits or launch behavior.

## Avoid

- Do not increase `maxConcurrentOperationsPerOwner` just to hide duplicate preflight requests.
- Do not permanently cache runtime readiness; hardware, downloaded components, and files can change between checks.
- Do not suppress every `limit_exceeded` error globally; it remains meaningful for actual media operations.
- Do not enlarge stdout/stderr limits when real tool output is far below the configured bounds.

## Validation

- Run the runtime IPC regression test covering duplicate same-owner probes and a later fresh probe.
- Run the local subtitle media runtime/probing tests.
- Run media-process, job-manager IPC, and renderer environment-card tests.
- Run TypeScript checking, preload bundle validation, and the root Vite build.
- After any manual dev launch, stop Electron/Vite and verify no project-owned listener remains.

## Related files

- `electron/main/local-subtitle/runtime-ipc.ts`
- `electron/main/local-subtitle/media-normalizer.ts`
- `src/main.tsx`
- `src/components/LocalSubtitleTranscriber/index.tsx`
- `test/local-subtitle/runtimeIpc.test.ts`
