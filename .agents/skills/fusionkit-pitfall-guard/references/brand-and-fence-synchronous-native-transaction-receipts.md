# FK-PIT-0057: Brand and fence synchronous native transaction receipts

## Area

Node/Electron native filesystem transactions, Artifact Registry activation, and rollback orchestration.

## Triggers

Synchronous receipt, structural `Pick<begin>`, thenable, terminal reentry,
Registry activation, native addon, victim backup, rollback.

## Symptoms

- A raw or async `begin` adapter bypasses Coordinator request/receipt validation.
- Native bytes change after an invalid thenable has already been rejected.
- A backend synchronously reenters `finalize()` or `rollback()` and executes two terminal operations.
- Cancellation or an awaited check splits native commit from Registry activation.
- A backend-invoked finalize throws after mutation, then orchestration revokes the
  Registry artifact and attempts the opposite rollback direction.
- A begin/rollback failure loses the only authority capable of restoring the victim.

## Root cause

TypeScript structural typing and `void` return declarations do not create a runtime
trust boundary. A transaction also spans two authorities: the native filesystem
receipt and the main-process Artifact Registry. Without an unforgeable Coordinator,
a synchronous no-await commit segment, an in-progress terminal fence, and explicit
failure atomicity, either side can settle while the other remains recoverable or
active.

## Do

- Accept only a runtime-branded, exact-prototype Coordinator at the Exporter boundary.
- Snapshot exact request keys and identities before invoking the backend.
- Reject every pending, resolved, or rejected thenable immediately and absorb its later rejection.
- Fence same-method and cross-terminal synchronous reentry. A rejection before
  backend invocation leaves state unchanged; once a terminal backend method is
  invoked, a throw enters the corresponding `finalize_pending` or
  `rollback_pending` state and rejects the opposite direction.
- Keep `begin -> Registry activate -> finalize/rollback` in one synchronous event-loop segment.
- On activation failure, rollback before returning the activation error.
- On backend-invoked finalize failure, retry finalize with the same receipt. If
  it remains pending, preserve the activated Registry commit direction and hand
  both authorities to recovery ownership; do not revoke and rollback.
- Require begin failure atomicity: before throwing or returning an invalid receipt, restore victim/partial state and release every backup and handle.
- Require rollback to restore the victim (or prior absence) and converge cleanup of the exact new inode. A native backend must remove it through the retained directory handle; only an adapter that still proves the authorized path names that same directory may restore the partial for identity-bound Exporter cleanup.
- If native rollback restores the victim but cannot remove the exact new partial, retain a retryable cleanup-pending receipt instead of reporting success or discarding the directory handle.
- Retain retry or crash-recovery authority when native rollback cannot complete.
- Fail closed before directory resolution or partial creation when no validated backend exists.

## Avoid

- Do not type the trusted dependency as `Pick<Coordinator, "begin">` or accept a raw callback.
- Do not insert `await`, cancellation checks, user callbacks, or promise settlement between native commit and Registry activation.
- Do not let `finalize()` or `rollback()` reenter either terminal method while it is running.
- Do not turn a pre-invocation reentry rejection into a pending state.
- Do not revoke or roll back an artifact after finalize backend execution has
  locked the receipt to `finalize_pending`.
- Do not call a path-only fallback when native loading or platform primitives are unavailable.
- Do not call a fully recovered failed commit `cleanup_failed`; reserve that code for cleanup that did not reliably settle.
- Do not discard a rollback-pending native receipt after rollback failure without
  handing it to bounded recovery ownership, and do not reopen finalize.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/overwriteTransaction.test.ts \
  test/local-subtitle/overwriteNativeBackend.test.ts \
  test/local-subtitle/subtitleExporter.test.ts \
  test/local-subtitle/productionExecutor.test.ts
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Cover structural and prototype spoofing, subclass rejection, request mutation,
pending/resolved/rejected thenables, same/cross terminal reentry, receipt method
mutation, both pending directions, pre-invocation state preservation, existing
and absent victims, same-direction retry, rollback failure, late cancellation,
and repeated real-Registry reads. These contract tests do not
replace target-platform hostile-parent and packaged native validation.

## Related files

- `electron/main/local-subtitle/overwrite-transaction.ts`
- `electron/main/local-subtitle/subtitle-exporter.ts`
- `test/local-subtitle/overwriteTransaction.test.ts`
- `test/local-subtitle/subtitleExporter.test.ts`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
