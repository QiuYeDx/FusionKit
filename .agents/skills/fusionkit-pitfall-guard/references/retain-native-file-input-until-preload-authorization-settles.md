# FK-PIT-0098: Retain native file input until preload authorization settles

## Area

Electron renderer/preload file selection and capability authorization.

## Triggers

`input type=file`, `webUtils.getPathForFile`, `authorization_expired`, `input.value = ""`, Windows file picker, Playwright `setInputFiles`.

## Symptoms

- A file selected through the real Windows picker fails with `authorization_expired`.
- The same file succeeds when Playwright injects it with `setInputFiles`.
- The renderer receives a `File`, but preload observes an empty result from `webUtils.getPathForFile(file)`.
- Retrying the picker does not help while the upload component keeps the same reset timing.

## Root cause

Electron binds filesystem path authority to the native `File` retained by the file input. Clearing `input.value` immediately after starting an asynchronous contextBridge call can revoke that authority before preload calls `webUtils.getPathForFile`. Playwright's injected file lifetime can differ from the real Windows picker and produce a false-positive integration result.

## Do

- Await the complete file consumer/authorization Promise before clearing the input.
- Keep the input's original `FileList` alive until preload and main have returned the authorization result.
- Clear in `finally` after settlement so the same file can still be selected again after success or failure.
- Add a lifecycle regression test that proves the input remains populated while authorization is pending.
- In Electron validation, observe `getPathForFile` after the React change handler has returned, not only at event capture time.

## Avoid

- Do not call `input.value = ""` immediately after invoking an async `onFiles` callback.
- Do not treat Playwright `setInputFiles` success alone as proof that the native Windows picker works.
- Do not work around the failure by exposing raw renderer-controlled paths or opening preload-internal IPC channels to a generic bridge.
- Do not keep the input populated permanently; reset it after authorization settles to preserve same-file retry behavior.

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

## Related files

- `src/pages/Tools/_shared/ui/ToolFileDropZone.tsx`
- `src/pages/Tools/_shared/ui/ToolFileDropZone.test.ts`
- `electron/preload/local-subtitle-api.ts`
- `electron/preload/subtitle-translation-api.ts`
