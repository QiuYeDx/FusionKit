# FK-PIT-0051: Do not short-circuit cleanup or mask the primary failure

## Area

Electron shutdown lifecycle / Node atomic publication

## Triggers

shutdown,cleanup,finally,firstFailure,??=,short-circuit,all-settled,partial
directory,lock file,EBUSY,EPERM

## Symptoms

- A manager failure in the first shutdown phase prevents media, server, or
  registry cleanup from running.
- The first rejection is reported correctly, but native sessions, temporary
  files, capabilities, or registry state remain live.
- Happy-path shutdown tests pass while only the failure path leaks resources.
- A failed atomic publication leaves a partial directory or lock file behind,
  and a later retry reports `already running` instead of the original failure.
- Cleanup throws a secondary Windows `EBUSY`/`EPERM` and masks the operation
  error that explains why publication failed.

## Root cause

`??=` and other short-circuiting assignments do not evaluate their right-hand
side once the left-hand side is non-nullish. Code such as
`firstFailure ??= await settlePhase(...)` therefore skips the entire phase
after an earlier failure, even though the intent was only to preserve the
first error.

The same rule applies to `finally` cleanup. Throwing from the first removal or
lock-close attempt skips later cleanup and replaces the primary operation
failure. On Windows, antivirus/indexing may also hold a just-read or just-written
file briefly, so a one-shot recursive removal or atomic rename can fail
transiently even when ownership and destination checks are correct.

## Do

- Await each side-effecting shutdown phase unconditionally and save its result
  in a local variable.
- Preserve the first failure only after the phase has settled, for example
  `const cleanupFailure = await settlePhase(...); firstFailure ??= cleanupFailure`.
- Use `Promise.allSettled` within a phase when sibling owners must all receive
  cleanup attempts.
- Keep the registry/final authority last, but still invoke it after earlier
  failures.
- Test both call order and the original failure identity.
- In atomic publishers, attempt partial-directory removal and lock release
  independently; attach any cleanup failure to the primary error instead of
  replacing it.
- Retry only known transient Windows filesystem errors (`EBUSY`, `EPERM`,
  `EACCES`) for a bounded period, and repeat the exact no-clobber destination
  check before each publication retry.
- Resolve hash/read streams only after their file descriptor has emitted
  `close`; an `end` event alone does not prove Windows can rename the file yet.

## Avoid

- Do not put `await`, cleanup calls, or other required side effects on the
  right-hand side of `??=`, `||=`, `&&`, or a conditional expression whose
  branch can be skipped after an earlier failure.
- Do not stop shutdown after quiesce failure merely because that failure is the
  one that must be returned.
- Do not replace phased ownership order with one undifferentiated concurrent
  shutdown when later cleanup depends on earlier quiescence.
- Do not throw from the first cleanup operation inside `finally`.
- Do not delete an existing destination to make a retry pass, broaden retries
  to semantic errors, or leave a stale lock after a partial publication.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/sessionLifecycle.test.ts
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Inject a failure in the first quiesce target and assert that every later media,
server, and registry target is still called in order, while shutdown rejects
with the original first failure.

For an atomic runtime stager, inject a transient publication/cleanup failure
and assert bounded retry, exact destination no-clobber semantics, removal of
the owned partial directory and lock, and preservation of the primary error.

## Related files

- `electron/main/local-subtitle/session-lifecycle.ts`
- `test/local-subtitle/sessionLifecycle.test.ts`
- `electron/main/local-subtitle/main-runtime.ts`
- `scripts/local-subtitle/runtime/stage-runtime-windows-x64-cuda.mjs`
- `scripts/local-subtitle/runtime/stage-runtime-windows-x64-cuda.test.mjs`
- `scripts/local-subtitle/runtime/run-native002-windows-smoke.mjs`
- `scripts/local-subtitle/runtime/run-native002-windows-smoke.test.mjs`
- `scripts/local-subtitle/runtime/runtime-manifest.mjs`
