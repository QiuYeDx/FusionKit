# FK-PIT-0061: Avoid post-mutation begin throws without recovery handoff

## Area

Node-API filesystem transactions, synchronous begin callbacks, and recovery
ownership.

## Triggers

`begin`, atomic rename, post-rename `fsync`, receipt construction, recovery
journal, begin failure atomicity, GC finalizer

## Symptoms

- The atomic rename succeeds, but a later directory sync throws from `begin()`.
- JavaScript receives no receipt even though the output namespace changed.
- Disposing the unreachable native receipt runs a normal rollback that deletes
  the caller's original partial instead of restoring the pre-begin layout.
- A second rollback failure is swallowed by the GC finalizer and leaves a
  journal with no reportable owner.

## Root cause

A synchronous `begin()` contract has only two safe outcomes: return a reachable
receipt that owns the changed namespace, or throw after restoring the exact
pre-begin state. Once namespace mutation occurs, another fallible operation can
make those outcomes diverge unless a separate durable recovery handoff exists.
A best-effort finalizer cannot provide reportable ownership.

## Do

- Complete every fallible validation, allocation, and receipt construction step
  before the first namespace mutation whenever the documented durability scope
  allows it.
- Keep the post-mutation path non-throwing when process-crash recovery does not
  require an additional sync; document that power-loss durability is separate.
- If a post-mutation failure must be reported, persist an explicit begin-abort
  direction that restores the victim or prior absence while preserving the
  caller-created partial, and hand its exact request ID to a recovery owner.
- Test a real child exit immediately after the namespace mutation and require a
  fresh process to observe the exact journal/layout without guessing a terminal
  decision.

## Avoid

- Do not call a throwable `fsync` after rename and then destroy the only receipt
  in the `begin()` catch path.
- Do not reuse normal terminal rollback for begin compensation when rollback
  intentionally deletes the new partial.
- Do not swallow failed compensation in a GC finalizer and still claim begin
  failure atomicity.
- Do not turn process-crash evidence into a power-loss claim.

## Validation

```text
node --test scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.test.mjs
node scripts/local-subtitle/overwrite-native/run-addon-recovery-integration.mjs --addon <absolute-test-addon-path>
node_modules/.bin/vitest run test/local-subtitle/overwriteTransaction.test.ts test/local-subtitle/subtitleExporter.test.ts
git diff --check
```

Require begin rejection cases to leave the victim and original partial intact
with zero descriptor delta. Separately require a test-only `_exit` immediately
after a successful namespace mutation to leave an exact open journal and return
`decision_required` from a fresh process without changing the namespace.

## Related files

- `native/local-subtitle-overwrite/src/addon.cc`
- `electron/main/local-subtitle/overwrite-transaction.ts`
- `electron/main/local-subtitle/subtitle-exporter.ts`
- `scripts/local-subtitle/overwrite-native/run-addon-recovery-integration.mjs`
