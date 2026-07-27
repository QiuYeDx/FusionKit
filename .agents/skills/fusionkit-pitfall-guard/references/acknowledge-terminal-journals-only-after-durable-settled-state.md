# FK-PIT-0064: Acknowledge terminal journals only after durable settled state

## Area

Node/Electron durable native transactions

## Triggers

terminal marker,acknowledge,nativeState,pending,settled,not_found,persistence uncertainty

## Symptoms

Deleting a terminal journal before settled state is durably confirmed turns a crash into pending plus not_found and strands recovery.

## Root cause

The terminal journal is the only durable proof that a namespace operation has
converged but has not yet been acknowledged by the composite owner. If native
code unlinks that marker before the owner has durably stored
`nativeState=settled`, a crash can leave the repository at `pending` while the
next recovery sees `not_found`. The owner must fail closed, but it has also lost
the evidence needed to make progress.

## Do

- Rename `.open` to the decision-specific `.finalize` or `.rollback` marker
  before converging the namespace, and retain that marker afterward.
- Persist schema-v2 `nativeState=settled` and confirm the write before calling
  receipt or module-level `acknowledge`.
- Treat persistence failures as uncertain: retain the marker, record, and
  directory fence, then retry the exact settled write before acknowledgement.
- Keep native finalizers direction-neutral while the journal is still `.open`.
  They may continue an already-armed terminal marker, but only the persisted
  main-process decision may choose finalize or rollback for an open receipt.
- Accept `acknowledge: not_found` only when the durable record was already
  settled. This covers a crash after unlink without weakening pending recovery.
- Interpret `recover: not_found` as completion only for the narrow
  `rollback_unpublished + not_started` preclaim state.

## Avoid

- Do not acknowledge merely because finalize or rollback returned success.
- Do not publish an in-memory settled state as acknowledgement authority when
  its repository write threw.
- Do not convert `pending` or `retry_failed` plus `recover: not_found` into
  success or release the recovery fence.
- Do not delete a preclaim after native begin has started or when preclaim
  persistence may have completed despite an error.
- Do not let environment teardown or receipt GC turn an open journal into a
  rollback marker; the repository may already contain `finalize_committed`.

## Validation

```text
node node_modules/vitest/vitest.mjs run \
  test/local-subtitle/overwriteTransaction.test.ts \
  test/local-subtitle/overwriteRecoveryOwner.test.ts \
  test/local-subtitle/overwriteNativeBackend.test.ts \
  test/local-subtitle/subtitleExporter.test.ts
node --test scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.test.mjs
node --test scripts/local-subtitle/overwrite-native/build-addon-windows-x64.test.mjs
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
git diff --check
```

Cover settled-write failure before acknowledgement, retry after persistence
uncertainty, acknowledgement `not_found` after a deletion retry, pending
recovery `not_found`, not-started preclaim `not_found`, and begin-started
handoff release. Native fresh-process tests must also abandon an open receipt
and prove both persisted decisions remain available afterward.

## Related files

- `electron/main/local-subtitle/overwrite-recovery-owner.ts`
- `electron/main/local-subtitle/overwrite-transaction.ts`
- `native/local-subtitle-overwrite/src/addon.cc`
- `native/local-subtitle-overwrite/src/addon-win32.cc`
- `test/local-subtitle/overwriteRecoveryOwner.test.ts`
- `scripts/local-subtitle/overwrite-native/run-addon-recovery-integration.mjs`
