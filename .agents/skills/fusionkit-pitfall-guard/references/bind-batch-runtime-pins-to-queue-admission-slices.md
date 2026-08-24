# FK-PIT-0054: Bind batch runtime pins to queue admission slices

## Area

Electron local inference job queues, batch execution, and runtime residency.

## Triggers

batch pin, queue admission, retry, sibling task, active cancel, cleanup failure,
owner release, shutdown, model smoke, incompatible load

## Symptoms

- A completed task releases the runtime pin before its queued sibling starts,
  allowing model smoke, an incompatible load, or idle retirement into the gap.
- Cancelling one task or reporting a task-scoped cleanup failure closes the pin
  even though the same admitted execution wave still has runnable siblings.
- A failed task retains a pin for its entire retry lifetime, so abandoned retry
  authority keeps a native process resident indefinitely.
- Owner release or shutdown closes a pin before the active executor has settled,
  racing task-private cleanup and stale child leases.
- The first task is cancelled while a shared pin acquisition is pending, so its
  task signal aborts or releases the acquisition that a queued sibling still owns.
- Shutdown starts while an incompatible epoch is still retiring, but startup is
  not tracked until spawn begins; shutdown returns and a late session is created.

## Root cause

The persisted batch record, an individual task, and one queue admission were
treated as the same lifetime. A batch can outlive several retry admissions, while
one admission can contain several consecutive sibling tasks that require an
uninterrupted exact-load-identity reservation. Shared acquisition was also tied
to a task signal instead of the slice signal, and startup tracking began only
after an incompatible epoch had already entered asynchronous retirement.

## Do

- Claim one opaque runtime slice per queue admission before executing its first
  task; keep it across consecutive runnable siblings from that admission.
- Acquire the native pin lazily after media normalization and exact runtime
  verification, then keep task leases as children of that pin.
- Drive the shared pin acquisition with the slice signal. A task signal may stop
  only that task's wait; one slice-owned continuation stores or releases the pin.
- Keep the slice after active task cancellation or a task-scoped cleanup failure
  when a runnable sibling remains; cancellation may restart the epoch without
  surrendering the exact identity reservation.
- Close the slice after the admission has no runnable siblings, after a
  batch/session-scoped fence, or after owner release and shutdown have settled
  the active executor.
- Give every retry a new admission and therefore a new slice. Failed task retry
  authority must not retain the old pin.
- Compare the complete server load proof before reusing a pin, including runtime
  root/target and server artifact path, size, hash, version, signature, and id.
- Make pin close revoke child leases and fence an active child request so stale
  lease handles cannot invoke inference.
- Publish the Supervisor's authoritative start operation before calling the
  ensure/retirement path. Recheck the lease and signal after incompatible epoch
  retirement and immediately before creating a new private session.

## Avoid

- Do not store a runtime pin on the long-lived batch record.
- Do not close the pin merely because one task was cancelled or returned a
  task-scoped `cleanup_failed` / `cancel_failed` result.
- Do not compare only runtime generation and artifact id when reusing a pin.
- Do not release a pending pin from two independent Promise continuations.
- Do not pass the current task signal to a shared pin acquisition or clear the
  pinned identity merely because that task stopped waiting.
- Do not register startup only inside the spawn path after old-epoch retirement.
- Do not retire a pinned epoch through idle or `last_owner` shutdown paths.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/jobManager.test.ts \
  test/local-subtitle/productionExecutor.test.ts \
  test/local-subtitle/serverSupervisor.test.ts
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Cover consecutive siblings, task cancel and cleanup failure, retry admission,
pending lazy acquisition, exact proof drift, child lease revocation, owner release,
terminal shutdown, and rejection of nonterminal retirement while pinned.

## Related files

- `electron/main/local-subtitle/job-manager.ts`
- `electron/main/local-subtitle/production-executor.ts`
- `electron/main/local-subtitle/server-supervisor.ts`
- `test/local-subtitle/jobManager.test.ts`
- `test/local-subtitle/productionExecutor.test.ts`
- `test/local-subtitle/serverSupervisor.test.ts`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
