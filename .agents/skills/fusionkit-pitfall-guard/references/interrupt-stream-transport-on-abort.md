# FK-PIT-0076: Interrupt the active stream transport on abort

## Area

Node network streaming, resource downloads, and cancellation.

## Triggers

`AbortSignal`, download cancel, stalled stream, `for await`, response body,
spinner, `.part` cleanup.

## Symptoms

- Clicking cancel changes the job to `cancelling`, but the UI keeps spinning.
- The model or other resource continues downloading after cancellation.
- Cancellation settles only after another network chunk arrives or the server
  closes the response.
- Chunk-based cancellation tests pass even though a stalled real download
  cannot be interrupted.

## Root cause

Checking `signal.aborted` inside a `for await` loop only runs after the next
iterator result arrives. If the response body is blocked waiting for network
data, the loop never reaches that check. Aborting the request after response
headers have arrived also does not reliably close an already active response
body unless the transport is explicitly bound to the signal. Even after
`discard()` is called, treating iterator rejection as guaranteed creates a
second hidden dependency on cooperative stream behavior.

## Do

- Register an abort listener for every active response body and synchronously
  destroy both the client request and response when cancellation is requested.
- Race every pending `iterator.next()` against the abort signal so the download
  loop stops writing even if transport discard does not settle the iterator.
- Make response discard idempotent because abort and error cleanup can race.
- Remove the abort listener in `finally` after the response settles.
- Preserve the original abort reason and run the existing identity-bound
  partial and metadata cleanup before publishing `cancelled`.
- Test both an iterator that rejects on `discard()` and one that stays pending
  forever after discard.

## Avoid

- Do not rely only on `throwIfAborted()` between chunks.
- Do not rely on `response.destroy()` or `discard()` as the only mechanism that
  releases a pending async iterator.
- Do not treat passing tests that abort between two immediately available
  chunks as proof that network cancellation works.
- Do not clear the renderer spinner optimistically while the main-process job
  and transport remain active.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/resourceDownload.test.ts test/local-subtitle/modelManager.test.ts test/local-subtitle/modelManagerIpc.test.ts
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Assert that abort synchronously calls `discard()` once, cancellation settles
without waiting for the iterator, fixed public IPC returns `cancelled: true`,
the resource job reaches `cancelled`, and `.part`, metadata, staging, and final
destination files are absent.

## Related files

- `electron/main/local-subtitle/resource-download.ts`
- `electron/main/local-subtitle/resource-job.ts`
- `electron/main/local-subtitle/model-manager.ts`
- `test/local-subtitle/resourceDownload.test.ts`
- `test/local-subtitle/modelManager.test.ts`
- `test/local-subtitle/modelManagerIpc.test.ts`
