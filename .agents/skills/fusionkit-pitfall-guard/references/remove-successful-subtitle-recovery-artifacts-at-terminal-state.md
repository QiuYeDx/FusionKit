# FK-PIT-0104: Remove successful subtitle recovery artifacts at terminal state

## Area

Subtitle translation / recovery artifact lifecycle / Windows cleanup.

## Triggers

`fusionkit-task-*.fusionkit.completed`, `.fusionkit.completed.json`, completed
task, clear completed, temporary file residue, hidden file extension

## Symptoms

- A successfully translated subtitle leaves a
  `fusionkit-task-*.fusionkit.completed.json` file in the output directory.
- Windows Explorer hides the final `.json` extension, so the completion summary
  appears to be a `*.fusionkit.completed` subtitle fragment.
- The file disappears only after the user clears the completed task from the
  visible queue.

## Root cause

The success cleanup removed the manifest and partial recovery subtitles but
intentionally retained a path-free completion summary. Task deletion used the
broader cleanup set, so the two terminal paths had inconsistent filesystem
semantics. The completion summary had no runtime recovery consumer and became
user-visible residue rather than useful recovery state.

## Do

- Keep manifest, completed, remaining, and error artifacts while a task is
  running or recoverably failed.
- After the final translated subtitle is committed, remove every task-owned
  recovery artifact, including the completion summary, before publishing the
  resolved event.
- Keep the committed final subtitle outside the cleanup set.
- Retry only transient Windows deletion failures with a bounded backoff.
- Retain task-deletion cleanup for artifacts produced by older app versions and
  for retrying a prior cleanup failure.

## Avoid

- Do not persist a successful-task marker in the user's output directory unless
  a concrete recovery consumer requires it.
- Do not make queue deletion the normal cleanup trigger for completed work.
- Do not delete failed or cancelled checkpoints that are still needed for
  resume.
- Do not treat a filename shown without `.json` in Explorer as proof that it is
  the completed subtitle artifact; inspect the actual extension first.

## Validation

```text
node node_modules/vitest/vitest.mjs run test/translation/base-translator.test.ts \
  test/translation/subtitle-translation-ipc-service.test.ts
node node_modules/typescript/bin/tsc --noEmit --pretty false
git diff --check
```

Cover successful final output preservation, absence of all five recovery
artifact paths after success, failed-task checkpoint retention, and legacy
artifact cleanup when a completed queue item is deleted.

## Related files

- `electron/main/translation/class/base-translator.ts`
- `electron/main/translation/recovery-artifacts.ts`
- `electron/main/translation/checkpoint.ts`
- `test/translation/base-translator.test.ts`
- `test/translation/subtitle-translation-ipc-service.test.ts`
