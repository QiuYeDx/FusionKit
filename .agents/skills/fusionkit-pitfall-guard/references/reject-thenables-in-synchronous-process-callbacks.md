# FK-PIT-0043: Reject thenables in synchronous process callbacks

## Area

Node child-process streaming, Electron main-process error containment.

## Triggers

`void` callback, async callback, thenable, `unhandledRejection`, stdout parser, child `close` race.

## Symptoms

- An async stdout parser rejects outside the surrounding `try/catch`.
- Electron main receives an unhandled rejection even though callback invocation is guarded.
- The child closes before the rejection microtask and the process result is incorrectly successful.
- Pending callback Promises accumulate for a long progress stream.

## Root cause

TypeScript permits a function returning a value or Promise where a `void` callback is expected.
Synchronous `try/catch` only observes invocation errors, and waiting for arbitrary callback Promises
would make bounded process settlement depend on caller-controlled asynchronous work.

## Do

- Keep machine-progress parsing synchronous when the process contract declares a `void` callback.
- Detect any returned thenable immediately, mark a stable callback failure, and stop the child.
- Attach a rejection handler to the thenable so its later settlement cannot become unhandled.
- Apply the same forwarding helper to capture and stream modes.
- Test pending, resolved and rejected thenables against a child that can close immediately.

## Avoid

- Do not assume the `void` return type forbids an `async` callback at compile time.
- Do not wait indefinitely for callback Promises during child close.
- Do not mark failure only when the Promise rejects; `close` can win that race.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/mediaProcess.test.ts
node_modules/.bin/tsc --noEmit
```

Confirm capture and stream callbacks map synchronous throws and every thenable to
`STDOUT_CALLBACK_FAILED`, absorb later rejection, request termination, and still require real child
`close` for cleanup authority.

## Related files

- `electron/main/local-subtitle/media-process.ts`
- `test/local-subtitle/mediaProcess.test.ts`
