# FK-PIT-0039: Serialize process-epoch close and finalization

## Area

Electron / local inference lifecycle

## Triggers

child close,process epoch,finalize,session cleanup,startup retry,unexpected exit

## Symptoms

- A child `close` wakes both the passive close observer and an active
  `retireEpoch()` path, so diagnostics finish or recursive session cleanup runs
  twice.
- A transient cleanup failure is retried concurrently instead of leaving a
  faulted generation for an explicit later shutdown retry.
- An early close while the process is still starting aborts the owning request,
  so the bounded fresh-port/session launch retry cancels itself.
- A ready process closes while its HTTP client is stuck, but the active result
  never settles because the observer only records the exit.

## Root cause

The child event emitter, request state machine, and teardown caller observe the
same process epoch through independent asynchronous continuations. Treating
each continuation as an owner of cleanup creates duplicate finalization. It
also loses the lifecycle phase: an expected or pre-readiness close has
different request semantics from an unexpected close after readiness.

## Do

- Give every process epoch one idempotent retirement promise and one shared
  finalization attempt.
- Let `close` record immutable close information first. Route unexpected close
  cleanup back through the same retirement function used by cancel, idle,
  owner release, and shutdown.
- During `starting`, let the startup loop classify the close and decide whether
  to retry with a fresh session, port, private path, and process epoch.
- During `ready`, synchronously fence the active request, abort its transport,
  force a stable crash result if necessary, and retire the epoch.
- Finish diagnostics and delete the identity-bound session only after child
  `close`, which is the stdio-drain boundary.
- If session cleanup fails, keep the epoch faulted and retry only through a
  later explicit retirement/shutdown call; do not permit respawn meanwhile.
- If quarantine rename succeeds but recursive removal fails, let the same
  opaque session proof rediscover only the matching `.cleanup-*` directory by
  stored filesystem identity. Do not mistake a missing original path for a
  completed deletion.
- Track successful deletion in module-private state. Before that proof exists,
  a missing root with no identity-matching quarantine must fail closed rather
  than return an idempotent `removed:false` result.

## Avoid

- Do not call the raw finalizer independently from both a `close` observer and
  `retireEpoch()`.
- Do not treat `exit`, `kill()` returning true, HTTP abort, or health success as
  proof that stdio is drained or native work is gone.
- Do not abort the active operation merely because its newly spawned child
  closed before readiness; doing so suppresses the supervisor's safe retry.
- Do not clear a faulted epoch or session proof after unconfirmed close or
  cleanup failure.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/serverSupervisor.test.ts
node_modules/.bin/tsc --noEmit
```

Cover early-close startup retry with a different session/endpoint, runtime
close force-settlement, concurrent cancel/close, SIGTERM to SIGKILL, late stderr
before cleanup, unconfirmed close preserving the session, and a cleanup failure
that succeeds only on a later shutdown retry.

## Related files

- `electron/main/local-subtitle/server-supervisor.ts`
- `electron/main/local-subtitle/server-session.ts`
- `test/local-subtitle/serverSupervisor.test.ts`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
