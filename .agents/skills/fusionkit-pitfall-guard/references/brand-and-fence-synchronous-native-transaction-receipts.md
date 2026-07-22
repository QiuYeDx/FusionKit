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
- A failed finalize restores the victim but is still mislabeled as an unclosed cleanup failure.
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
- Fence same-method and cross-terminal synchronous reentry; restore `open` only after a failed terminal operation.
- Keep `begin -> Registry activate -> finalize/rollback` in one synchronous event-loop segment.
- On activation failure, rollback before returning the activation error.
- On finalize failure, attempt Registry revoke and rollback independently; report cleanup/cancel failure only when required cleanup did not reliably converge.
- Require begin failure atomicity: before throwing or returning an invalid receipt, restore victim/partial state and release every backup and handle.
- Require rollback to restore both the victim (or prior absence) and the exact partial leaf for identity-bound Exporter cleanup.
- Retain retry or crash-recovery authority when native rollback cannot complete.
- Fail closed before directory resolution or partial creation when no validated backend exists.

## Avoid

- Do not type the trusted dependency as `Pick<Coordinator, "begin">` or accept a raw callback.
- Do not insert `await`, cancellation checks, user callbacks, or promise settlement between native commit and Registry activation.
- Do not let `finalize()` or `rollback()` reenter either terminal method while it is running.
- Do not call a path-only fallback when native loading or platform primitives are unavailable.
- Do not call a fully recovered failed commit `cleanup_failed`; reserve that code for cleanup that did not reliably settle.
- Do not discard an open native receipt after rollback failure without handing it to bounded recovery ownership.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/overwriteTransaction.test.ts \
  test/local-subtitle/subtitleExporter.test.ts \
  test/local-subtitle/productionExecutor.test.ts
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Cover structural and prototype spoofing, subclass rejection, request mutation,
pending/resolved/rejected thenables, same/cross terminal reentry, receipt method
mutation, existing and absent victims, Registry revoke throw/false, rollback failure,
late cancellation, and repeated real-Registry reads. These contract tests do not
replace target-platform hostile-parent and packaged native validation.

## Related files

- `electron/main/local-subtitle/overwrite-transaction.ts`
- `electron/main/local-subtitle/subtitle-exporter.ts`
- `test/local-subtitle/overwriteTransaction.test.ts`
- `test/local-subtitle/subtitleExporter.test.ts`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
