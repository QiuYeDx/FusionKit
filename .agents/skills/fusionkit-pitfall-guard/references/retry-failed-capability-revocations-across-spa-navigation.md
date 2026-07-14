# FK-PIT-0010: Retry failed capability revocations across SPA navigation

## Area

Electron / frontend capability lifecycle

## Triggers

AudioIpcResult, revoke, ok:false, file token, capability, SPA navigation, owner cleanup

## Symptoms

Treat IPC failure results separately from rejections and retain failed revocation handles for retry because SPA route changes do not release the webContents owner.

## Root cause

Electron renderer helpers often return a discriminated `AudioIpcResult`, so a
main/preload failure resolves the Promise with `{ ok: false }` instead of rejecting it.
Code that only catches exceptions therefore treats a failed revoke as success. Clearing
the renderer token first then loses the only handle that can release the main-process
entry. A hash-route transition unmounts the component but keeps the same webContents,
so owner-release cleanup does not run until the window closes.

## Do

- Check both Promise rejection and `response.ok` for every cleanup IPC.
- Treat `{ ok: true, data: { revoked: false } }` as successful idempotent cleanup; the
  token may already have been consumed or revoked.
- Put the token in a renderer-level pending-revocation queue before clearing UI state.
- Retain the queue across component unmounts, retry transient failures with bounded
  backoff, and stop after the capability expiry time.
- Flush pending revocations when the relevant tool mounts or another cleanup begins.
- Keep main revoke owner-bound and keep its internal channel outside generic invoke.

## Avoid

- Do not rely on `catch` alone for a result-union IPC API.
- Do not discard a token before another runtime owner has retained it for retry.
- Do not assume React unmount, hash navigation, or SPA route replacement releases the
  Electron sender owner.
- Do not treat `revoked: false` as a retryable failure when the IPC result itself is OK.

## Validation

```text
node_modules/.bin/vitest run src/services/audio/audioServices.test.ts test/audio/audioFile.test.ts test/audio/audioIpcService.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

Cover a resolved `{ ok: false }`, a rejected preload call, an idempotent
`{ ok: true, revoked: false }` retry, and owner isolation in main.

## Related files

- `src/services/audio/audioRuntimeConfigService.ts`
- `src/pages/Tools/Audio/SpeechSynthesizer/index.tsx`
- `electron/main/audio/audio-file.ts`
- `electron/main/audio/ipc.ts`
- `test/audio/audioFile.test.ts`
- `test/audio/audioIpcService.test.ts`
