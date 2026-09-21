# Settle empty transcription only after cleanup

- **ID:** FK-PIT-0166
- **Area:** Electron / transcription task lifecycle
- **Triggers:** no_content, no_speech_detected, terminal state, batch pin, cleanup_failed, empty subtitle

## Symptoms

A completed inference with no usable text appears as a retryable failure, or a neutral no-content result hides a later capability or batch-runtime cleanup failure. Renderer polling or automatic translation snapshots can also remain active when a new terminal state is only added to the backend.

## Root cause

The post-processor historically expresses an empty validated transcript with an error code. Mapping every thrown error to failure loses the product distinction. Publishing a new immutable terminal state before releasing resources prevents subsequent cleanup exceptions from becoming failures: the state machine rejects the second terminal transition.

## Do

- Classify only the actual validated post-processor's precise `no_speech_detected` result. A missing or malformed response, incomplete inference graph, or quality failure remains an error.
- Preserve cancellation and cleanup-failure priority. Release task capabilities and the required batch slice before publishing a no-content terminal receipt; retain a batch pin while queued siblings still need it.
- Recheck cancellation, owner and lease authority after asynchronous cleanup. Do not momentarily publish a neutral outcome that will need retracting.
- Keep `no_content` free of output artifacts, document IDs, errors and pending translation handoffs. Do not create placeholder subtitle files.
- Trace all consumers of terminal status: IPC schemas, queue progression, idle/polling, removal, finished-record clearing and translation snapshot ownership.
- Describe what the recognizer produced, not whether the source acoustically contains speech. See [FK-PIT-0106](do-not-infer-speech-absence-from-empty-asr.md).

## Avoid

- Classifying based on an arbitrary object carrying the same code, or any empty array before validation.
- Releasing resources only after publishing an irreversible terminal state.
- Encouraging same-settings retry, CPU retry, or automatic translation when there is no subtitle content.
- Editing the frozen Studio native compatibility copy instead of the actual Studio transcription executor.

## Validation

Cover no-content and mixed batches; usable and invalid transcript responses; cancellation during cleanup; task/batch release failures; output and translation suppression; snapshot release; renderer polling cessation and finished-record clearing. Run actual Electron UI assertions in both tools, while recording whether the native runtime or terminal queue was controlled.

## Related files

- `electron/main/local-subtitle/production-executor.ts`
- `electron/main/local-subtitle/job-manager.ts`
- `electron/main/subtitle-studio/transcription/transcript-executor.ts`
- `electron/main/subtitle-studio/transcription/task-service.ts`
- `src/services/local-subtitle/localSubtitlePostActionService.ts`
- `src/services/subtitle-studio/transcription-controller.ts`
- `docs/v0.3.1/2026-09-21-transcription-no-content.md`
