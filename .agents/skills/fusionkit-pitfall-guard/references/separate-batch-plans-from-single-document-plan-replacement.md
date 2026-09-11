# FK-PIT-0126: Separate batch plans from single-document plan replacement

## Area
Subtitle Studio / batch admission / export memory

## Triggers
forgetOwner, batch planning, planId invalidation, per-file results, export bytes.

## Symptoms
Preparing the second document invalidates the first document's plan. Raising the plan-count limit to compensate can retain many complete subtitle output buffers at once.

## Root cause
Single-document TranslationService and ExportService deliberately replace an owner's previous plan. That lifecycle is incompatible with preparing a set of files before confirming one batch.

## Do
Use a distinct bounded owner-scoped batch plan. Keep document references, explicit per-document tracks, shared options and summary/content digests. At admission or publication, verify each revision and return each result independently. Build one output buffer at a time, require the checked losses, and use indexed atomic publication into one native-authorized directory. Preserve single-document frozen-output semantics and existing task checkpoint/scheduler behavior.

## Avoid
Do not loop single-document prepare calls and assume all returned plan IDs remain valid. Do not reuse one track ID for different documents, silently accept format losses, auto-overwrite same names, or report partial work as complete. Do not describe request-level FIFO as whole-document sequential execution.

## Validation
Run batch-service, IPC and library-ui tests: plan replacement isolation, stale revisions, expiry/owner revocation, duplicate execution, partial failures, directory cancellation, per-file track selection and same-name protection. Verify persisted admitted tasks survive restart without automatic external requests.

## Related files
- electron/main/subtitle-studio/batch-service.ts
- src/subtitle-studio/batch-contract.ts
- test/subtitle-studio/batch-service.test.ts
- test/subtitle-studio/library-ui.test.ts