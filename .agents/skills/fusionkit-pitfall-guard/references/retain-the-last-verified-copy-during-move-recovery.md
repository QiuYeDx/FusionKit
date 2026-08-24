# FK-PIT-0047: Retain the last verified copy during move recovery

## Area

Node transactional file moves, managed resource imports, and cleanup recovery.

## Triggers

Move import, hard-link quarantine, unlink rejection, missing source, source
replacement, cleanup retry, last verified copy.

## Symptoms

- A move reports failure after removing the source and rollback then deletes the
  managed copy as well.
- A hidden source quarantine survives while the job is reported as completed.
- Shutdown succeeds even though source recovery is still unresolved.

## Root cause

An unlink callback can fail after changing filesystem state, and a missing path
does not prove deletion because the same inode may have been renamed. Treating
that ambiguity as success or immediately rolling back the verified destination
can either leak an owned hard link or delete the last known-good bytes.

## Do

- Create an identity-bound source quarantine before removing the original name.
- Verify that a successful remover actually reaches `ENOENT`; reject no-op
  removers.
- On ambiguous failure, retain both the source recovery receipt and the verified
  managed commit.
- Rediscover quarantines only by stable object/content identity inside the
  verified parent directory.
- Restore the source first, then remove the managed commit; make shutdown retry
  both steps and reject while either remains unresolved.

## Avoid

- Do not infer deletion from two missing pathnames.
- Do not discard a source receipt after restore fails.
- Do not roll back the last verified copy while source recovery is ambiguous.
- Do not overwrite a replacement that appeared at the original source path.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/modelManager.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

Cover no-op removal, unlink-then-reject, source-path replacement, quarantine
rediscovery, repeated shutdown, and successful restore-before-managed-rollback.

## Related files

- `electron/main/local-subtitle/model-manager.ts`
- `test/local-subtitle/modelManager.test.ts`
