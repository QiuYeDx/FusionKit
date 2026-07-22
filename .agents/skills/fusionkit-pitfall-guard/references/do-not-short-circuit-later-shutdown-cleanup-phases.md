# FK-PIT-0051: Do not short-circuit later shutdown cleanup phases

## Area

Electron / shutdown lifecycle

## Triggers

shutdown,cleanup,firstFailure,??=,short-circuit,all-settled

## Symptoms

- A manager failure in the first shutdown phase prevents media, server, or
  registry cleanup from running.
- The first rejection is reported correctly, but native sessions, temporary
  files, capabilities, or registry state remain live.
- Happy-path shutdown tests pass while only the failure path leaks resources.

## Root cause

`??=` and other short-circuiting assignments do not evaluate their right-hand
side once the left-hand side is non-nullish. Code such as
`firstFailure ??= await settlePhase(...)` therefore skips the entire phase
after an earlier failure, even though the intent was only to preserve the
first error.

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

## Avoid

- Do not put `await`, cleanup calls, or other required side effects on the
  right-hand side of `??=`, `||=`, `&&`, or a conditional expression whose
  branch can be skipped after an earlier failure.
- Do not stop shutdown after quiesce failure merely because that failure is the
  one that must be returned.
- Do not replace phased ownership order with one undifferentiated concurrent
  shutdown when later cleanup depends on earlier quiescence.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/sessionLifecycle.test.ts
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Inject a failure in the first quiesce target and assert that every later media,
server, and registry target is still called in order, while shutdown rejects
with the original first failure.

## Related files

- `electron/main/local-subtitle/session-lifecycle.ts`
- `test/local-subtitle/sessionLifecycle.test.ts`
- `electron/main/local-subtitle/main-runtime.ts`
