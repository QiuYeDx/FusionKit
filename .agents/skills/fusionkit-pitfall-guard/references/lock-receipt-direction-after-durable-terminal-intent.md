# FK-PIT-0060: Lock receipt direction after terminal execution can mutate state

## Area

Node/Electron native transactions, persistent journals, and crash recovery.

## Triggers

rollback_pending, finalize_pending, durable intent, terminal retry, recovery
journal, post-mutation finalize throw, same-direction retry, process crash

## Symptoms

- Native rollback persists its recovery intent, then a later rename, unlink, or
  sync fails.
- Native finalize mutates the victim backup or journal, then a later cleanup,
  sync, or proof step fails.
- The JavaScript receipt treats the throw as if nothing happened and returns to
  `open`.
- A caller invokes the opposite terminal even though the previous call may have
  crossed that terminal's mutation boundary.
- In-process retry and crash recovery choose opposite terminal directions for
  the same transaction.

## Root cause

The wrapper modeled every thrown terminal call as failure-before-state-change.
Filesystem transactions can cross a mutation or durable decision point before
throwing, so the error preserves retryability but cannot restore the prior
choice of terminal direction. Protocol v4 makes both directions durable by
renaming `.open` to `.rollback` or `.finalize` before namespace convergence.

## Do

- Persist the composite rollback or finalize decision before invoking the
  matching native terminal operation.
- Publish the matching `.rollback` or `.finalize` marker before that terminal's
  first namespace mutation, then retain it until durable settled state is
  acknowledged.
- Move the wrapper receipt to the corresponding pending state only after the
  backend method was actually invoked and threw; a reentry rejection before
  invocation must leave the prior state unchanged.
- Repeated calls from `finalize_pending` or `rollback_pending` may continue only
  the same terminal.
- Reject the opposite terminal from the pending state.
- Make native retries and fresh-process recovery converge from journal phase plus
  the observed owned layout; never repeat a completed swap solely from stale
  in-memory phase.
- If acknowledgement unlink succeeded but a later sync/proof failed, retry
  acknowledgement from durable settled state and accept exact `not_found`.
- Preserve the activated Artifact Registry commit direction when finalize retry
  remains pending; hand that combined state to the future composite owner.
- Keep the composite recovery owner responsible for both native journal state and
  Artifact Registry activation/revoke state.
- Test failure before and after each namespace syscall separately, plus a real
  fresh-child exit and recovery in a different process.

## Avoid

- Do not reset an invoked terminal attempt to `open` merely because it threw.
- Do not infer that an exception means the durable intent rename or namespace
  syscall had no effect.
- Do not permit finalize after rollback has become durable.
- Do not revoke and rollback after a backend-invoked finalize failure.
- Do not let a GC finalizer reverse `finalize_pending` into rollback.
- Do not infer finalize or rollback direction from layout after restart; use the
  persisted composite decision and reject a conflicting terminal marker.
- Do not let a GC finalizer stand in for reportable recovery ownership.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/overwriteTransaction.test.ts \
  test/local-subtitle/overwriteNativeBackend.test.ts \
  test/local-subtitle/subtitleExporter.test.ts \
  test/local-subtitle/productionExecutor.test.ts
node --test scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.test.mjs
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Cover rollback throwing after durable intent, finalize throwing before and after
mutation, both pending states, opposite-terminal rejection, pre-invocation
reentry state preservation, same-terminal retry, existing/absent victim
recovery, terminal-marker acknowledgement retry, and a second fresh-process
acknowledgement returning `not_found` without another namespace mutation.

## Related files

- `electron/main/local-subtitle/overwrite-transaction.ts`
- `electron/main/local-subtitle/overwrite-native-backend.ts`
- `electron/main/local-subtitle/subtitle-exporter.ts`
- `native/local-subtitle-overwrite/src/addon.cc`
- `scripts/local-subtitle/overwrite-native/build-test-addon-macos-arm64.mjs`
- `scripts/local-subtitle/overwrite-native/run-addon-recovery-integration.mjs`
- `test/local-subtitle/overwriteTransaction.test.ts`
- `test/local-subtitle/subtitleExporter.test.ts`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
