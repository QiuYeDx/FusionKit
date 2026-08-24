# FK-PIT-0056: Do not enable path-only overwrite across replaceable directories

## Area

Node atomic artifact writes, Electron output capabilities, and filesystem races.

## Triggers

overwrite, atomic rename, parent replacement, directory identity, TOCTOU, dirfd,
openat, renameat, source output, custom output

## Symptoms

- A final directory check passes, but an awaited target inspection leaves time for
  another process to replace the parent before path-based `rename`.
- Artifact activation rejects the new file after commit, yet a file remains in the
  replacement directory.
- A pre-existing same-name file in the replacement directory is atomically replaced
  and cannot be recovered by deleting the newly written artifact afterward.

## Root cause

An absolute path plus a previously observed `dev` / `ino` / `birthtimeMs` does not
anchor later filesystem syscalls to that directory object. Node's path-based APIs do
not expose the cross-platform dirfd/openat/renameat transaction needed to prove that
the checked directory and the commit directory are the same object.

## Do

- Keep the shared schema and standalone exporter behavior separate from the set of
  conflict policies admitted by the production Job Manager and Executor.
- Admit only `index` while final writes rely on path-based operations. Enforce the
  gate before capability resolution/reservation in Job Manager and again at the
  direct Executor boundary.
- For a future overwrite implementation, use a directory-handle-relative native
  transaction with no-follow/reparse checks, recoverable target backup, atomic
  replacement, activation, and identity-bound rollback on every target platform.
- Test both source and custom production requests and prove rejected overwrite
  requests leave input/output drafts revocable and publish no tasks.

## Avoid

- Do not treat commit-time re-resolution or post-commit Artifact Registry rejection
  as proof that overwrite preserved a victim file.
- Do not claim that deleting an identity-matching new final restores the old target;
  atomic replace has already removed the old directory entry.
- Do not expose standalone path-based overwrite through another production caller
  without reopening this gate and its platform-specific proof.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/jobManager.test.ts \
  test/local-subtitle/jobManagerIpc.test.ts \
  test/local-subtitle/productionExecutor.test.ts \
  test/local-subtitle/subtitleExporter.test.ts
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Confirm source and custom overwrite fail before capability consumption, while index
still commits normally. Standalone overwrite tests are component behavior evidence,
not hostile-directory-replacement security evidence.

## Related files

- `electron/main/local-subtitle/job-manager.ts`
- `electron/main/local-subtitle/production-executor.ts`
- `electron/main/local-subtitle/subtitle-exporter.ts`
- `test/local-subtitle/jobManager.test.ts`
- `test/local-subtitle/jobManagerIpc.test.ts`
- `test/local-subtitle/productionExecutor.test.ts`
- `test/local-subtitle/subtitleExporter.test.ts`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
