# FK-PIT-0103: Keep subtitle model retries bounded and single-owned

## Area

Subtitle translation / model API retries / concurrent fragments

## Triggers

manual retry succeeds, task fails after a short outage, too few retries,
`status: failed`, `server_error`, Retry-After, concurrent slices, retry storm

## Symptoms

- A subtitle task enters the failed queue during a short model-provider outage,
  but immediately succeeds when the user manually resumes it.
- Failure logs show only a small number of tightly spaced attempts.
- Concurrent fragments retry at the same instant and prolong a rate limit or
  overload condition.
- A Responses API HTTP 200 envelope with `status: failed` is treated as a
  permanent invalid response even when its error code is transient.

## Root cause

The task owns a short linear retry loop while provider-envelope failures are
classified separately by an adapter. A transient failure can therefore be
marked permanent before the task policy sees it. Fixed retry intervals also
make every concurrent fragment hit the provider again in lockstep. Adding
retries at both layers would hide the classification problem and multiply the
number of requests.

## Do

- Let exactly one layer own the subtitle fragment retry budget; keep nested
  adapter retries disabled for that call path.
- Use a bounded total-attempt count with abortable exponential backoff and
  jitter, and treat a valid server Retry-After value as a delay floor.
- Classify HTTP status and structured provider code/type together so compatible
  gateways can expose transient failures even when they use an unusual status.
- Retry transient network, timeout, rate-limit, overload, upstream, empty, and
  malformed-response failures while failing fast for authentication,
  permission, invalid request, unsupported value, policy, billing, and quota
  failures.
- Include fragment identity, attempt/total, structured error classification,
  and the next delay in terminal diagnostics.
- Preserve the existing all-settled worker barrier before checkpoint flush and
  terminal task publication.

## Avoid

- Do not stack a task retry loop on top of enabled adapter retries.
- Do not retry every HTTP 4xx or every provider error; permanent errors can
  consume tokens or hold the queue without any chance of recovery.
- Do not accept Retry-After: 0 as permission for immediate synchronized retries.
- Do not use identical fixed delays for concurrent fragments.
- Do not emit the failed task event while sibling requests remain in flight.

## Validation

```text
node_modules/.bin/vitest run test/translation/base-translator.test.ts \
  test/translation/base-translator-runtime.test.ts \
  test/translation/subtitle-translation-retry-policy.test.ts \
  test/ai/modelRuntimeClient.test.ts
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Cover recovery after more attempts than the previous budget, exponential delay
ceilings, Retry-After: 0, transient HTTP 200 failed envelopes, unusual gateway
status codes, and permanent quota/configuration failures.

## Related files

- `electron/main/translation/class/base-translator.ts`
- `electron/main/translation/retry-policy.ts`
- `electron/main/ai/provider-error-classification.ts`
- `electron/main/ai/adapters/chat-completions-adapter.ts`
- `electron/main/ai/adapters/responses-adapter.ts`
- `test/translation/base-translator.test.ts`
- `test/translation/subtitle-translation-retry-policy.test.ts`
- `test/ai/modelRuntimeClient.test.ts`
