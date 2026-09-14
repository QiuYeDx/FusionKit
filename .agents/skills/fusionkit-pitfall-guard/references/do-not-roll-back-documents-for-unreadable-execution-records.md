# FK-PIT-0156: Do not roll back documents for unreadable execution records

## Area

Subtitle persistence / recovery

## Triggers

current previous generation, private snapshot, incompatible execution version, missing trace

## Symptoms

Validate private execution semantics at recovery and inspection so a bad trace cannot silently select older task state.

## Root cause

DocumentRepository tries previous.json after a current generation fails validation. Adding strict private execution records to the outer snapshot schema makes a missing or future-version record look like an invalid document commit. This can hide retained translations or select an older recovery request even though the current document is readable. This case concerns record semantics within a checksum-valid document commit; corruption of the outer JSON bytes or generation checksum still follows the repository whole-generation recovery policy.

## Do

- Keep the bounded private record bag readable independently of each record's supported schema and semantic integrity.
- Validate a record against its track/task identity, version, base digest and frozen request digests when inspecting or resuming it. Return an explicit record error while preserving current document content.
- Validate new or changed records strictly before publication; tolerant reads do not authorize writing credentials or invalid requests.
- Keep record bases and published requests immutable, with actual request additions in the same transaction as inFlight state.
- Freeze every batch's static request at admission, including batches that have not started. Preserve actual dynamic context before sending and compare transport serialization with saved bytes on recovery.
- Distinguish task-row cleanup from retained translation provenance. Removing the last track reference clears the current record; previous generations and external backups are separate lifetimes.

## Avoid

- Do not catch a private record semantic error by selecting a previous document generation.
- Do not regenerate historical system prompts from current source code, or describe API serialization failures as malformed model output.
- Do not return the entire private table in ordinary document pagination.
- Do not run tokenization of every frozen batch again before each individual batch; validate the whole plan at admission/recovery and only the current request during execution.

## Validation

Use real temporary repository files to simulate a valid current document with missing, mismatched, structurally invalid and unsupported-version records. Assert the current document revision remains selected, independent edits retain the unreadable record, and trace/resume return explicit errors. Test that new malformed writes are rejected and that task removal/restart retains the track record.

Capture exact HTTP bodies before a real Electron process interruption and after recovery, including prior AI translations and previously unstarted batches. Use an isolated profile and a local provider fixture; close all owned processes.

## Related files

- `src/subtitle-studio/execution-record-contract.ts`
- `electron/main/subtitle-studio/document-repository.ts`
- `electron/main/subtitle-studio/execution-records.ts`
- `electron/main/subtitle-studio/execution-view.ts`
- `test/subtitle-studio/execution-record.test.ts`
- `test/subtitle-studio/translation-recovery.test.ts`
- `test/subtitle-studio/translation-recovery-ui.test.ts`
