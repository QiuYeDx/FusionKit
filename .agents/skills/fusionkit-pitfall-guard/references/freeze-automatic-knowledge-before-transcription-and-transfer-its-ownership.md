# FK-PIT-0159: Freeze automatic knowledge before transcription and transfer its ownership

## Area

Automatic subtitle translation / pending intent / knowledge lifetime

## Triggers

automatic translation, transcription handoff, pending intent, initialize, frozen selection, queue references

## Symptoms

An automatic task can silently use later library edits or ordinary translation after restart if only its normal handoff understands knowledge. Purge can miss material held before a document exists, and completed queue records can retain unbounded private material after their leases are released.

## Root cause

Transcription starts before there are subtitle cues or translation batches. The original startup initializer consumes pending intents before normal handoff. A provider execution snapshot cannot represent this earlier phase, and the ASR owner, pending document and provider each have different lifetimes.

## Do

- Capture a bounded, immutable, cue-free material closure under the same gate as permanent clearing. Bind its preparation policy to the matching/execution policy. Validate target-language agreement at the request boundary; English transcription output has source language `en` regardless of the audio language.
- Give pre-document captures their own reference identity. Share a single material object across one transcription batch, with one reference-counted lease. Never invent document, track or execution IDs before admission.
- Atomically publish the source document with its pending knowledge intent before releasing queue references. Clear material and credentials from terminal in-memory records. A late ASR owner release does not revoke an already-published document's automatic translation authorization.
- Use the same knowledge preparation path in startup initialization and normal handoff. Read only frozen materials. Pending restart materializes a visible task without credentials or network; admitted recovery restores exact saved requests.
- Persist an explicit failed task for conflicts, damaged material or insufficient capacity. Retain the source, show that automatic translation needs attention, and never fall back to the ordinary planner.
- Extend current/previous safety inventories and maintenance labels to include preparation material. Keep initialization/locking ownership explicit; no shared gate should wait on a provider.

## Avoid

- Do not create fake batches merely to reuse the execution snapshot schema.
- Do not copy a 4 MiB capture twenty times into a batch or leave terminal records holding it indefinitely.
- Do not test only handoff while initialization still takes the old ordinary path.
- Do not treat a controlled native-runtime fixture as coverage of production task-service leases. High-risk fixture entries must still be reviewed individually through the production rule.

## Validation

Use real temporary repositories and production task-service tests for capture rejection, cancellation, delayed admission/shutdown, multi-file reference transfer, owner release after publication, conflicting transcripts, unknown policies and corrupt pending snapshots. Verify frozen requests after library edits and restart, and verify purge refuses unknown or retained references. Keep cross-domain maintenance integration in the knowledge integration tests rather than importing the whole maintenance service into Studio's isolated dependency root. Use isolated Electron/local HTTP fixtures for UI and actual requests; close owned services.

## Related files

- `src/translation-knowledge/automatic-snapshot-contract.ts`
- `electron/main/subtitle-studio/automatic-knowledge.ts`
- `electron/main/subtitle-studio/transcription/task-service.ts`
- `electron/main/subtitle-studio/translation-service.ts`
- `electron/main/subtitle-studio/document-repository.ts`
- `test/subtitle-studio/automatic-knowledge-capture.test.ts`
- `test/subtitle-studio/transcription-task-service.test.ts`
- `test/translation-knowledge/automatic-service.test.ts`
- `test/translation-knowledge/automatic-electron.test.ts`
