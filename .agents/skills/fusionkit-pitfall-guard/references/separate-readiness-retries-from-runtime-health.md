# FK-PIT-0038: Separate readiness retries from runtime health

## Area

Local inference / Node HTTP state machine and process generation lifecycle.

## Triggers

readiness, health, 503, reusable, restart, single-active, first await,
concurrent inference, process generation.

## Symptoms

- A `/health` timeout or 503 stays `reusable` after the process was already
  ready, so inference is sent to a generation whose health check failed.
- Health and inference run concurrently; one call taints the client while the
  other still returns `sessionDisposition: reusable`.
- Two calls both pass a preflight busy check because the active ticket is only
  assigned after file open, network setup or another `await`.
- A cancelled request returns `/health=ok` and the next task reuses a process
  whose native inference work has not fully settled.

## Root cause

Startup polling and runtime health use the same error disposition even though
they represent different process states. The HTTP client also treats
single-active as an inference-only optimization instead of a linearization
boundary for every operation that can observe or change generation health.

## Do

- Expose distinct startup readiness and ready-state health operations.
- Allow only explicitly classified startup failures, such as connect failure,
  timeout or 503, to remain retryable within a bounded Supervisor startup loop.
- After ready, make any health transport/timeout/HTTP/schema failure require a
  new process generation.
- Claim one shared readiness/health/inference ticket synchronously before the
  first `await`, and release only the ticket owned by that call.
- Recheck ticket identity and session disposition before returning success.
- Treat mid-request inference abort, timeout, transport, protocol and cleanup
  failures as restart-required. Pre-request abort may remain reusable.
- Restart after cancellation even when the old process later reports healthy.

## Avoid

- Do not use one generic `health()` method for both unready polling and runtime
  liveness unless the caller must pass an explicit, validated phase.
- Do not let health bypass the same active-operation boundary as inference.
- Do not assign the busy ticket after `open()`, `stat()`, HTTP creation or any
  other asynchronous step.
- Do not let `/health=ok` stand in for a cancellation quiescence protocol that
  the upstream runtime does not provide.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/serverHttpClient.test.ts
```

Cover startup 503/timeout remaining reusable, ready-state 503/timeout tainting,
health-vs-health and health-vs-inference busy behavior, pre-request abort,
mid-request abort, success disposition recheck, and a new client/process
generation succeeding after restart-required failure.

## Related files

- `electron/main/local-subtitle/server-http-client.ts`
- `electron/main/local-subtitle/server-contract.ts`
- `electron/main/local-subtitle/server-supervisor.ts`
- `test/local-subtitle/serverHttpClient.test.ts`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/fix/2026-07-17_local-subtitle-transcriber_restart-server-after-cancel.md`
