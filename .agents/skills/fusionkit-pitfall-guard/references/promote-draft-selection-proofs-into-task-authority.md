# FK-PIT-0072: Promote draft selection proofs into task authority

## Area

Electron / draft-to-task capability lifecycle

## Triggers

probe record, streamId, draft LRU, batch queue, task retry, media_changed

## Symptoms

A queued task with a valid explicit media selection fails later with
`media_changed` after the user probes another batch, even though the selected
file and media runtime did not change.

## Root cause

Draft probe records are bounded, replaceable metadata. A queue may retain more
committed tasks than the draft probe LRU retains records, especially when the UI
allows preparing the next batch while earlier tasks are still waiting. If task
execution looks up its explicit `streamId` only in the draft cache, a later
probe can evict authority that the already committed task still requires.

## Do

- Keep draft probe records bounded and replaceable.
- During atomic enqueue, validate the selected opaque ID against owner, file
  token, exact input identity, runtime generation, and the current draft record.
- Copy only the selected track proof plus bounded table/duration signatures into
  a task-owned main-process record keyed by owner and task ID.
- Roll the task binding back when capability or publication commit fails.
- Retain the binding while a failed task remains retryable; release it after a
  non-retryable terminal outcome, task removal, owner release, or shutdown.
- Re-probe at execution and compare input identity, runtime generation,
  duration, track table signature, and selected track signature before decode.

## Avoid

- Do not increase the draft LRU limit as a substitute for task ownership.
- Do not persist raw selectors, paths, file tokens, or probe metadata in the
  renderer.
- Do not release a selected-track proof when a failed task can still be retried.
- Do not retain the entire draft track table per task when a bounded signature
  and the selected track proof are sufficient.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/mediaNormalizer.test.ts test/local-subtitle/jobManager.test.ts
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Cover draft LRU overflow after task binding, stale/forged/cross-owner IDs,
enqueue rollback, retry retention, non-retryable terminal release, owner release,
and shutdown.

## Related files

- `electron/main/local-subtitle/media-normalizer.ts`
- `electron/main/local-subtitle/job-manager.ts`
- `test/local-subtitle/mediaNormalizer.test.ts`
- `test/local-subtitle/jobManager.test.ts`
