# FK-PIT-0073: Namespace recovery artifacts by stable task identity

## Area

Node/Electron task recovery artifacts and capability lifecycle.

## Triggers

same filename, taskId, checkpoint, completed/remaining/error artifact, delete
task, capability release, cleanup retry

## Symptoms

- Two tasks with the same display filename write the same resume or recovery
  artifact leaves even though their queue identities are distinct.
- Deleting one task can remove another task's checkpoint or leave its own
  recovery artifacts on disk.
- Task authority is released before cleanup finishes, so a transient Windows
  file lock cannot be retried against the original authorized directory.

## Root cause

A display filename is not an ownership identity. Once the queue supports
same-name tasks, filename-derived artifact leaves collapse distinct task
lifecycles into one filesystem namespace. Releasing the directory/checkpoint
authority before deletion also discards the proof needed for a safe retry.

## Do

- Derive new recovery artifact namespaces from a stable task identity, using a
  fixed-length hash when filesystem leaf limits or private IDs matter.
- Keep the original filename inside the validated manifest for display and
  recovery rather than depending on the artifact leaf.
- Revalidate the task-bound directory before cleanup and delete each owned
  artifact independently with bounded transient-lock retries.
- Release task and checkpoint authority only after all artifact cleanup has
  succeeded; retain authority when cleanup fails so the same request can retry.
- Keep the committed final output outside the recovery cleanup set.

## Avoid

- Do not key resume/completed/remaining/error leaves only by `fileName`.
- Do not treat queue-level same-name support as complete without checking disk
  artifact names.
- Do not report a task release as successful after partial cleanup, and do not
  let cleanup failure delete or invalidate the final translated subtitle.

## Validation

```text
node_modules/.bin/vitest run test/translation/base-translator.test.ts \
  test/translation/subtitle-translation-recovery-capability.test.ts \
  test/translation/subtitle-translation-ipc-service.test.ts
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Cover two same-name tasks receiving different artifact leaves, a cleanup
failure retaining authority for retry, successful removal of every recovery
artifact, and preservation of the final translated subtitle.

## Related files

- `electron/main/translation/checkpoint.ts`
- `electron/main/translation/recovery-artifacts.ts`
- `electron/main/translation/directory-capability.ts`
- `electron/main/translation/ipc.ts`
- `test/translation/subtitle-translation-ipc-service.test.ts`
