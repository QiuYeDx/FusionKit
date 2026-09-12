# FK-PIT-0148: Capture native drop authority before queuing reader work

## Area

Electron / native File drag admission

## Triggers

FileList, webUtils, drag event, first await, queued action, rejected Promise

## Symptoms

Capture OS-backed File paths synchronously in the originating drop event before deferring UI reconciliation.

## Root cause

Changing run(action) to a queued reader action moved the native File bridge inside a later microtask or behind a slow background read. Although the handler copied the FileList, the bridge no longer captured native authority in the original drop event. A captured Promise can also reject while waiting for the reader, before the queued action attaches its rejection handler.

## Do

Apply mounted/busy/operation guards first. Call the dedicated preload File bridge synchronously from the drop event; preload uses webUtils.getPathForFile before its first await and invokes only its fixed internal channel. Immediately observe both Promise outcomes, then queue the result processing and UI refresh. The queued action and retry callback retain the result, never the File objects or unvalidated renderer paths. Media controller admission follows the same synchronous-capture contract.

## Avoid

Do not await preference hydration, a reader lock or runtime startup before invoking the fixed File bridge. Do not trust File.path or expose a generic internal invoke method. Do not leave a rejecting Promise unobserved while waiting for unrelated background work.

## Validation

media-drop.test.ts verifies synchronous native extraction, rejects synthetic/forged input, and proves the internal channel is absent from generic IPC. The actual slow-reader native-drop scenario in acceptance-live-refresh-ui.test.ts removes the backing input immediately after the event and proves capture occurs before the reader is released. Transcription controller tests check the same first-await ordering.

## Related files

- electron/preload/subtitle-studio-api.ts
- src/pages/Tools/Subtitle/SubtitleStudio/index.tsx
- src/services/subtitle-studio/transcription-controller.ts
- test/subtitle-studio/media-drop.test.ts
- test/subtitle-studio/acceptance-live-refresh-ui.test.ts
- keep-preload-internal-ipc-out-of-public-invoke.md
