# FK-PIT-0169: Separate user source metadata from private file integrity

## Area
Subtitle Studio / Windows source authorization, media probing, transcription and source-directory export.

## Triggers
Playback invalidates a queued file, media_changed, source unavailable, ctime, metadata-only change, original-directory export.

## Symptoms
A still-present input becomes unusable for probing, transcription, lease renewal or source-directory export after an external application updates its metadata.

## Root cause
The user-input comparator tolerated ctime changes only on Darwin. Windows metadata updates can also change ctime without changing the file object, size or mtime. Several media paths used the strict private-file comparator even for user sources: draft ffprobe checks, stream binding and the post-copy source-handle check.

## Do
- Use the same user-input comparator throughout authorization, queue admission/deduplication, renewal, probing, snapshot source reads and persisted source bindings. Match exact object identity, size and content mtime; ctime/atime alone do not prove replacement or content change.
- Keep strict identity checks for owned snapshots, PCM, native resources and model files. Make the input/private distinction explicit when one helper processes both kinds of file.
- Retain pinned parent-directory identity, canonical path and symlink checks. Never refresh a mismatched object or parent identity to make an operation succeed.
- Exercise real filesystem metadata drift. Assert unchanged inode/device/size/mtime and changed ctime; include drift before probe, during copy, while queued, after restart and after export planning.
- Preserve historical migration evidence; document intentional fixes to the current Studio fork separately from the original copied source.

## Avoid
- Do not change the shared strict comparator or ignore size/mtime/object changes.
- Do not fix only the authorization entry point and leave strict source checks downstream.
- Do not use floating-point utimes restoration as proof of metadata-only change: timestamp rounding can change content mtime.
- Do not describe metadata equality as cryptographic content verification. Same-size changes with deliberately restored mtime require a separate content-integrity design.

## Validation
Run the Studio input-identity, source-media-lifecycle, transcription-task-service and acceptance-source-output tests. Include changed/replaced/moved inputs, replaced parents, private-snapshot metadata mutation, and duplicate input capabilities captured across metadata changes. Run TypeScript and the real Studio dependency boundary check.

## Related files
- `electron/main/subtitle-studio/transcription/native/filesystem-object-identity.ts`
- `electron/main/subtitle-studio/transcription/native/media-normalizer.ts`
- `electron/main/subtitle-studio/transcription/task-service.ts`
- `electron/main/subtitle-studio/source-location-service.ts`
- `test/subtitle-studio/helpers/source-metadata.ts`
