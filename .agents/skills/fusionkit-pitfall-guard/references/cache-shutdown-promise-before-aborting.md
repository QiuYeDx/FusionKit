# FK-PIT-0046: Cache shutdown Promise before aborting

## Area

Node cancellation lifecycle, resource jobs, and app shutdown.

## Triggers

`AbortController`, abort listener, reentrant shutdown, shared Promise, Promise
identity, owner release.

## Symptoms

- Two callers entering an idempotent `shutdown()` receive different Promises.
- An abort listener synchronously reenters `shutdown()` while the outer call is
  still constructing its composite cleanup operation.
- Cleanup still finishes, but callers observe inconsistent completion or retry
  state because one operation was never stored as the authoritative shutdown.

## Root cause

`AbortController.abort()` dispatches abort listeners synchronously. If
`shutdown()` aborts active work before assigning its shared Promise field, an
abort listener can call `shutdown()` again and create a second operation.

## Do

- Create and cache the authoritative shutdown Promise before calling any
  operation that can synchronously invoke user or subsystem callbacks.
- Let abort listeners and concurrent callers observe that same Promise.
- Keep shutdown reentrant and test strict Promise identity, not only eventual
  resolution.
- Apply the same ordering to owner-release wrappers when callbacks can reenter
  composite lifecycle methods.

## Avoid

- Do not assign `#shutdownOperation` only after iterating active controllers and
  calling `abort()`.
- Do not assume abort notification is deferred to a future microtask.
- Do not treat two independently successful cleanup Promises as equivalent to
  one idempotent lifecycle operation.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/resourceJob.test.ts
node_modules/.bin/tsc --noEmit
```

Cover an abort listener that synchronously calls `shutdown()` and assert that
the outer call, the reentrant call, and later concurrent calls receive the exact
same Promise object.

## Related files

- `electron/main/local-subtitle/resource-job.ts`
- `test/local-subtitle/resourceJob.test.ts`
