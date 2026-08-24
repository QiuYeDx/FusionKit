# FK-PIT-0093: Settle in-flight subtitle requests before reporting failure

## Area

Subtitle translation concurrency, token usage accounting, checkpoint recovery.

## Triggers

`Promise.all`, concurrent slices, first rejection, in-flight model request,
token usage, `task-failed`, checkpoint.

## Symptoms

- A concurrent subtitle task reports fewer API requests or tokens than the provider billed.
- The failed-task event and checkpoint disagree with requests visible in provider logs.
- Usage changes after the renderer already moved the task into the failed queue.

## Root cause

`Promise.all` rejects as soon as one worker fails. Other workers that already sent model
requests continue running, so immediately freezing usage, checkpoint state, and the
failure event omits responses that settle afterward.

## Do

- Stop workers from claiming new fragments after the first failure.
- Await all already-started workers with `Promise.allSettled`.
- Record usage before parsing each returned model response.
- Only after all workers settle, flush the checkpoint and emit `task-failed`.
- Test with one early rejection and one later successful in-flight response.

## Avoid

- Do not treat the first rejected worker as proof that no more billable responses can arrive.
- Do not emit terminal usage while request promises remain active.
- Do not cancel sibling requests unless the provider transport and cancellation accounting
  contract are explicit and tested.

## Validation

```text
node_modules/.bin/vitest run test/translation/base-translator.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

The concurrent failure test must show both the failed response usage and the later
successful in-flight response usage in the final task and failure event.

## Related files

- `electron/main/translation/class/base-translator.ts`
- `electron/main/translation/usage.ts`
- `test/translation/base-translator.test.ts`
