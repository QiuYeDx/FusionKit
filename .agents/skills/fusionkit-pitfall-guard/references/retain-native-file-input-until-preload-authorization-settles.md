# FK-PIT-0098: Preserve picker authority and validate Explorer drag on a supported Electron

## Area

Electron renderer/preload file selection and capability authorization.

## Triggers

`input type=file`, `DataTransfer.files`, `webUtils.getPathForFile`, `authorization_expired`, `input.value = ""`, Windows file picker, Windows Explorer drag, Electron 33, Electron 41, Electron 42, Playwright `setInputFiles`, CDP `Input.dispatchDragEvent`.

## Symptoms

- A file selected through the real Windows picker fails with `authorization_expired`.
- The same file succeeds when Playwright injects it with `setInputFiles`.
- The renderer receives a `File`, but preload observes an empty result from `webUtils.getPathForFile(file)`.
- Retrying the picker does not help while the upload component keeps the same reset timing.
- The picker succeeds, but dragging the same file from Windows Explorer fails with `authorization_expired`.
- A CDP-injected drag succeeds even though a real Explorer drag still fails.
- Moving path resolution into a trusted preload `drop` listener or passing one `File` per synchronous contextBridge call still returns an empty path on Electron 33.4.x for a real Explorer drag.

## Root cause

Electron binds filesystem path authority to the native `File` retained by the file input or drag event. Clearing `input.value` immediately after starting an asynchronous contextBridge call can revoke picker authority before preload calls `webUtils.getPathForFile`.

Explorer drag has a separate runtime compatibility failure. On Windows with Electron 33.4.11, `webUtils.getPathForFile()` returned an empty string for a real Explorer `DataTransfer` file in all tested placements: renderer-to-preload batch calls, one-file synchronous calls, and a trusted preload capture-phase `drop` listener. The same WAV selected through the picker succeeded. Updating the project runtime to Electron 41.10.6 made that unchanged real Explorer drag succeed immediately; Electron 42.7.1 was independently validated as well, but is not required for this fix. Playwright/CDP injected files do not reproduce this runtime failure and therefore produce false positives.

Electron 41 can also return a non-empty `%TEMP%` backing path for long Windows
Shell items. That is a different failure from empty path authority and requires
the original-source recovery described in FK-PIT-0099.

## Do

- Await the complete file consumer/authorization Promise before clearing the input.
- Keep the input's original `FileList` alive until preload and main have returned the authorization result.
- Clear in `finally` after settlement so the same file can still be selected again after success or failure.
- Add a lifecycle regression test that proves the input remains populated while authorization is pending.
- In Electron validation, observe `getPathForFile` after the React change handler has returned, not only at event capture time.
- Use an Electron release where real Windows Explorer `DataTransfer` files are supported; Electron 41.10.6 is the project's pinned and manually validated baseline, while Electron 42.7.1 is also known to work.
- Resolve each native `File` synchronously through a fixed preload method and accumulate only preload-private paths behind a bounded, short-lived, one-time opaque reference.
- Bump the fixed bridge version whenever the renderer API shape changes so a stale preload reloads instead of returning misleading request errors.
- Require one real Windows Explorer drag before accepting the fix; keep CDP drag as an automated smoke test only.

## Avoid

- Do not call `input.value = ""` immediately after invoking an async `onFiles` callback.
- Do not treat Playwright `setInputFiles` success alone as proof that the native Windows picker works.
- Do not work around the failure by exposing raw renderer-controlled paths or opening preload-internal IPC channels to a generic bridge.
- Do not keep the input populated permanently; reset it after authorization settles to preserve same-file retry behavior.
- Do not assume that changing an exposed contextBridge method from `async` to synchronous preserves Explorer drag authority.
- Do not assume that `Array.from`, rest parameters, one-file calls, or a preload capture-phase listener can repair an Electron runtime that returns an empty path for real Explorer files.
- Do not read a drag path through a generic renderer `electronUtils` helper or return it to the renderer; capture and consume it entirely inside the fixed preload bridge.
- Do not accept CDP `Input.dispatchDragEvent` as proof of native Windows Explorer compatibility.

## Validation

```text
node_modules/.bin/vitest run src/pages/Tools/_shared/ui/ToolFileDropZone.test.ts test/local-subtitle/preloadApi.test.ts
node_modules/.bin/tsc --noEmit
```

Electron validation should record all of the following for a real media file:

- at change capture: one selected file and a non-empty `getPathForFile` result;
- after the React handler returns while authorization is pending: still one file and a non-empty path result;
- after authorization settles: the input is cleared;
- the file appears in the local subtitle draft queue without `authorization_expired`.

For a real Windows Explorer drag, additionally record:

- the exact Electron version used by the validation build;
- the fixed preload bridge resolves every original `FileList` item synchronously;
- the renderer receives only the opaque capture reference with the expected bounded file count;
- capture authorization is one-shot and expires without exposing paths;
- the file appears in the draft queue without `authorization_expired`.

## Related files

- `src/pages/Tools/_shared/ui/ToolFileDropZone.tsx`
- `src/pages/Tools/_shared/ui/ToolFileDropZone.test.ts`
- `electron/preload/local-subtitle-api.ts`
- `electron/preload/subtitle-translation-api.ts`
- `package.json`
- `pnpm-lock.yaml`
