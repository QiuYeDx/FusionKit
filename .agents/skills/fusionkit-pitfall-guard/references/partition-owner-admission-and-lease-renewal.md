# FK-PIT-0052: Partition owner admission and lease renewal

## Area

Electron main-process job queues and capability lease lifecycle.

## Triggers

multi-owner FIFO, pending enqueue, retry admission, capability renewal, TTL,
owner release, head-of-line blocking, hung Promise

## Symptoms

- Owner A has a slow or hung capability operation and owner B cannot enqueue,
  execute, or renew before its lease expires.
- Releasing an owner removes its queued tasks but a pending or ready admission
  still blocks the app-global FIFO.
- A single renewal timer is re-armed only after every owner settles, so a slow
  owner silently stretches another owner's renewal interval.
- `waitForOwnerIdle(B)` observes unrelated work from owner A.

## Root cause

The app-global execution order, owner-local capability serialization, renewal
cadence, and owner cleanup were represented by one Promise tail or timer. These
concerns have different ownership: FIFO orders admitted work globally, while
capability authority and TTL belong to one owner session.

## Do

- Claim an app-global admission ticket synchronously before the first await.
- Keep capability operation tails and active counts partitioned by owner.
- Store one renewal timer per owner and re-arm only that owner from its callback.
- On owner release, settle or discard pending and ready admissions as well as
  removing queued runs.
- Make owner-idle checks count only matching enqueue, admission, execution, and
  capability operations.
- During shutdown, attempt every timer cancellation, retain the first failure,
  and leave failed handles available for a later retry.
- Test two renewal cycles for owner B while owner A's renewal Promise remains
  pending.

## Avoid

- Do not use one global capability Promise tail for unrelated owners.
- Do not let one completed owner callback re-arm or reset every owner's timer.
- Do not treat removing runs from the visible queue as equivalent to settling
  their admission ticket.
- Do not let a released owner's pending retry hold later owners behind it.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/jobManager.test.ts
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Cover async admission completion order, pending enqueue/retry owner release,
per-owner idle, one owner renewal hanging while another renews twice, timer
cancellation retry, and app-global task execution order.

## Related files

- `electron/main/local-subtitle/job-manager.ts`
- `test/local-subtitle/jobManager.test.ts`
- `electron/main/local-subtitle/authorizations.ts`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
