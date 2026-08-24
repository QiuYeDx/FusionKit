# FK-PIT-0097: Preserve safe task diagnostics across IPC sanitization

## Area

Electron local-task sessions / IPC snapshots / user-facing error diagnostics.

## Triggers

generic task failed, error details omit the reason, session sanitizer, private
media paths, diagnostic allowlist, retryable task with no actionable explanation.

## Symptoms

- The executor constructs a concrete failure reason and bounded diagnostic lines,
  but the renderer sees only a fixed generic message and error code.
- Retrying the same file sometimes passes, while the error dialog cannot identify
  the failed window, recovery count or post-processing rule.
- Removing sanitization would expose source paths, tokens or native stderr.

## Root cause

A session-boundary sanitizer replaced every task error with one generic object to
prevent private backend data from crossing IPC. The safety boundary erased stable,
non-sensitive structured facts together with arbitrary strings, making real failures
impossible to diagnose from the UI.

## Do

- Preserve code, stable stage and retryability as typed fields.
- For approved error codes, allowlist exact diagnostic grammars and numeric metadata
  such as reason identifiers, window indices, retry depths and segment counts.
- Rebuild the public summary from fixed application text. Drop arbitrary messages,
  unknown lines, native stderr, paths, tokens and unapproved metadata.
- Mark diagnostics truncated whenever unsafe or unknown content was removed.
- Test useful safe facts and representative secrets in the same fixture.

## Avoid

- Do not forward `Error.message`, stack traces or metadata wholesale to the renderer.
- Do not solve privacy by reducing every failure to the same sentence.
- Do not use a broad character filter as an allowlist; constrain field names and
  value grammars independently.

## Validation

- A quality failure keeps its stable shaping/window reason and numeric counts.
- A private source path, token-like value, arbitrary summary and unknown metadata
  are absent from the sanitized snapshot.
- The Electron error dialog shows the allowlisted reason after a real failing run.

## Related files

- `electron/main/local-subtitle/session-registry.ts`
- `electron/main/local-subtitle/production-executor.ts`
- `test/local-subtitle/sessionRegistry.test.ts`
- `test/local-subtitle/productionExecutor.test.ts`
