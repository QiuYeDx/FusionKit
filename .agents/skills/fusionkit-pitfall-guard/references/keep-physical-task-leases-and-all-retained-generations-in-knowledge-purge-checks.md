# FK-PIT-0157: Keep physical task leases and all retained generations in knowledge purge checks

## Area

Subtitle knowledge / maintenance concurrency

## Triggers

purge, execution records, current previous, cancellation, late provider response, reference inventory

## Symptoms

Permanent clearing needs a fresh serialized inventory of current and previous records plus physical provider leases; skipped corrupt or deleted remnants must remain unknown, never zero references.

## Root cause

A visible task list does not describe every retained copy of knowledge. A previous document generation or an unreferenced private record can still contain it. Cancellation removes logical task ownership before an uncooperative provider settles; deleting a document may even remove its directory during that interval. A cached index keyed only by repository events also misses publications whose notification failed.

## Do

- Inspect current and previous pointers independently, including every private execution record, and deduplicate records without erasing distinct resource revisions.
- Treat corrupt pointers/records, unknown policies, extra generations, symlinks, interrupted deletion and exhausted scan budgets as unknown references. Return explicit blockers; never silently skip them.
- Merge physical run leases until the run promise settles, even after cancellation, task cleanup or document deletion.
- Serialize formal admission/resume with the final fresh inventory and permanent-clear commit using one shared gate. Hold no gate while waiting for a provider response; keep lock ordering explicit.
- Resolve an already-published maintenance receipt before a new scan can reject its idempotent replay.
- Keep preview work bounded and recheck owner/cache limits after asynchronous scans.
- Collection deletion must expand the selected collections to their actual members in the main process at the preview generation. Include expanded entries in task-reference inspection: a task can retain only a child entry. Never implement direct deletion as a hidden archive commit followed by purge, because cancellation or a blocked purge would already have changed user data.
- Additive request fields must pass both the public IPC schema and the service schema. Exercise preload → registered handler → service in contract tests; direct service tests alone cannot detect a stale strict IPC schema rejecting the real UI request.

## Avoid

- Do not use a list API that deletes remnants, selects only one fallback generation or hides unavailable documents as a safety inventory.
- Do not conclude zero references from a disconnected or failed inventory supplier.
- Do not equate task-row cleanup with deleting execution provenance or all local historical copies.
- Do not recompile knowledge from the current library during recovery. Validate frozen selection, compiled scopes and request bodies against one another.

## Validation

Use temporary real repositories for current/previous references, orphan records, unsupported versions and policies, corrupt files, symlinks, deletion remnants and scan limits. Test a new admission between maintenance preview and commit, gate serialization, and receipt retries after inventory failure. Hold an uncooperative local provider, cancel/delete its document, and prove the lease remains until actual settlement. Verify retained references and purge blockers in an isolated Electron profile. Close all owned processes.

## Related files

- `electron/main/subtitle-studio/document-repository.ts`
- `electron/main/subtitle-studio/knowledge-translation.ts`
- `electron/main/subtitle-studio/translation-service.ts`
- `electron/main/translation-knowledge/service.ts`
- `electron/main/translation-knowledge/task-gate.ts`
- `src/translation-knowledge/snapshot-contract.ts`
- `test/subtitle-studio/knowledge-references.test.ts`
- `test/subtitle-studio/knowledge-translation.test.ts`
- `test/translation-knowledge/task-maintenance.test.ts`
- `test/translation-knowledge/formal-electron.test.ts`
