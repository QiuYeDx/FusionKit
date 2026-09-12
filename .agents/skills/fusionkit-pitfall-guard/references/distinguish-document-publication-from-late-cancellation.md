# FK-PIT-0135: Distinguish document publication from late cancellation

## Area

Subtitle Studio / document creation / durable publication / cancellation.

## Triggers

document sink, repository.create, current pointer, post-publish fsync, late cancellation, duplicate completion.

## Symptoms

A final transcript creates a document, but a later cancellation or directory-sync error makes the caller report that no result exists. Retrying with a new UUID then creates a duplicate. Cleanup after an uncertain creation can also erase an already published document.

## Root cause

The filesystem publication point and asynchronous method completion are different events. A guard after `await create()` cannot undo a published pointer. An undifferentiated catch cannot tell prepublication failure from a failure while confirming durability.

## Do

- Allocate one document identity for the logical operation and keep it on retry.
- Check owner/generation and cancellation at admission and immediately before invoking the pointer rename. This is the cancellation cutoff; a rename already issued may complete.
- Track successful publication separately from durability confirmation. Preserve the document and return an explicit uncertain-durability receipt when later syncing fails.
- Reconcile retries against the same creation identity and current tombstone. A cached success must not revive a deleted document.
- Bind pending cleanup to the exact app-created directory. Never adopt or delete an unrelated orphan merely because its UUID path matches.
- Suppress delivery to a revoked owner without changing the persisted commit into a new retryable creation.

## Avoid

- Do not append a cancellation check after a successful commit and call the document absent.
- Do not delete a published directory because a subsequent sync or observer failed.
- Do not label an uncertain receipt as fully durable or claim automatic restart recovery from in-memory coalescing.

## Validation

Run `repository-creation.test.ts`, `transcription-document-sink.test.ts`, and `transcription-document-producer.test.ts` under `test/subtitle-studio/`. Cover faults before publication, after rename, pending cleanup failure, concurrent calls, payload drift, tombstones, and cancellation during final task/batch cleanup and after publication.

## Related files

- `electron/main/subtitle-studio/document-repository.ts`
- `electron/main/subtitle-studio/transcription/document-sink.ts`
- `electron/main/subtitle-studio/transcription/document-producer.ts`
