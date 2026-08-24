# FK-PIT-0053: Bind warm process epochs to owners and timer tokens

## Area

Electron local inference process reuse and cleanup lifecycle.

## Triggers

zero-lease warm epoch, process reuse, idle timeout, releaseOwner, model smoke,
load identity switch, stale callback, background cleanup failure

## Symptoms

- Releasing an unrelated owner kills a process still reusable by another live
  owner, or the last real owner cannot clean it because an old smoke owner
  remains recorded.
- An idle callback captured before same-epoch reacquire retires the process now
  serving a new lease.
- Owners from a finalized epoch leak into the next epoch, or compatible active
  lease owners are missing after a process restart.
- A background idle cleanup failure is either swallowed or incorrectly changes
  an already completed task into `cleanup_failed`.
- A real contract test expects the private session to disappear immediately on
  task lease release even though warm reuse is now intentional.

## Root cause

Lease authority, owner interest, process-epoch identity, and task cleanup were
treated as one lifetime. A zero lease count only says that no caller currently
has invocation authority; it does not prove the loaded process has no compatible
future consumer or that background retirement completed.

## Do

- Let task lease release preserve a compatible `ready/leaseCount=0` epoch for a
  bounded idle interval.
- Register resident owners only for inference epochs; model-load smoke must not
  become a warm resident.
- Clear residents only after the current epoch finalizes successfully. When an
  active lease restarts an epoch, register every active compatible inference
  lease owner, not only the request that triggered restart.
- Retire an incompatible load identity before starting its new epoch.
- Guard idle callbacks with both the captured epoch object and a timer token;
  clear or supersede the token on reacquire and every re-arm.
- Keep task-private media/window/artifact cleanup task-scoped. Latch background
  runtime cleanup failure on the Supervisor, reject later acquire, and allow
  explicit shutdown to retry without rewriting completed task state.
- Update real tests to assert warm ready first, then use owner release or shutdown
  before asserting private session removal.

## Avoid

- Do not equate `leaseCount === 0` with `state === unloaded`.
- Do not keep one unscoped owner set across smoke and inference epochs.
- Do not validate stale idle callbacks by epoch number alone; same-epoch
  reacquire also invalidates a callback.
- Do not claim that an idle warm epoch strictly guarantees one model load per
  batch; that requires a separate batch pin or shared admission contract.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/serverSupervisor.test.ts \
  test/local-subtitle/serverSupervisor.real.test.ts \
  test/local-subtitle/productionExecutor.test.ts
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Cover sequential lease reuse, same-epoch and older-epoch stale callbacks, smoke
followed by inference, idle retirement followed by a new epoch, multi-owner
re-registration after restart, incompatible identity, idle cleanup fault retry,
and immediate cleanup after the final resident owner release.

## Related files

- `electron/main/local-subtitle/server-supervisor.ts`
- `electron/main/local-subtitle/production-executor.ts`
- `test/local-subtitle/serverSupervisor.test.ts`
- `test/local-subtitle/serverSupervisor.real.test.ts`
- `test/local-subtitle/productionExecutor.test.ts`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
