# FK-PIT-0078: Retry transient downloads inside one resource job

## Area

Node / resumable downloads

## Triggers

first download fails,second click works,ECONNRESET,HTTP 503,Range retry

## Symptoms

Treating a transient connection failure as a terminal resource-job failure forces the user to provide the retry loop manually.

## Root cause

A resumable transport can safely recover from connection resets, response
header timeouts, premature response endings, and temporary HTTP failures. If
the downloader maps the first such failure directly to a terminal ResourceJob
error, the next UI click succeeds only because the user manually created the
missing retry loop. This also leaves multiple job records for one logical
installation attempt.

## Do

- Retry only a bounded allowlist of transient network codes and temporary HTTP
  statuses.
- Keep the retry inside the same ResourceJob and reuse Range/If-Range only when
  persisted bytes have a trusted validator.
- Restart from zero when safe resume metadata could not be persisted.
- Make retry delays abortable with the same signal as the active request.
- Preserve fail-fast behavior for policy, integrity, disk, and validation
  failures.

## Avoid

- Do not retry every exception; callback, filesystem, and verification bugs
  must remain visible.
- Do not require a second install click for `ECONNRESET`, header timeout, HTTP
  503, or a premature response close.
- Do not retain an empty `.part` across a zero-byte retry because the next
  exclusive open will fail.
- Do not sleep between retries without racing the delay against cancellation.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/resourceDownload.test.ts test/local-subtitle/modelManager.test.ts test/local-subtitle/modelManagerIpc.test.ts
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Cover a transient failure before headers, a temporary HTTP response, a body
failure after persisted bytes, and cancellation during a long retry delay.
Assert recovery completes in the original call and the resumed request carries
the exact Range and If-Range values.

## Related files

- `electron/main/local-subtitle/resource-download.ts`
- `electron/main/local-subtitle/model-manager.ts`
- `test/local-subtitle/resourceDownload.test.ts`
- `test/local-subtitle/modelManagerIpc.test.ts`
