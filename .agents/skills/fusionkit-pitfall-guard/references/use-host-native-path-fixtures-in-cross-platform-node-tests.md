# FK-PIT-0030: Use host-native path fixtures in cross-platform Node tests

## Area

Cross-platform Node tests / path and process launch contracts.

## Triggers

`node:path`, Windows path literal, macOS test, `path.dirname`, PATH delimiter,
native runtime tests.

## Symptoms

- A process-launch unit test passes on Windows but expects `C:\\runtime` while
  running on macOS, where `path.dirname()` returns `.` for that literal.
- A PATH assertion fails because the test expects `;` semantics on a POSIX
  host or `:` semantics on Windows.
- Production behavior is correct on its target, but a supposedly portable
  contract test fails for fixture syntax unrelated to the behavior under test.

## Root cause

The default `node:path` implementation follows the current host. A foreign OS
path string is not automatically parsed with `path.win32` or `path.posix`.
Combining a foreign literal with host-native helpers creates a hybrid path that
does not represent either platform.

## Do

- Use `path.join()` and `path.parse(process.cwd()).root` for tests intended to
  run on every host.
- When testing foreign path semantics specifically, inject or call
  `path.win32`/`path.posix` explicitly and assert the selected implementation.
- Derive PATH assertions from `path.delimiter` and keep executable paths
  platform-native unless the test is explicitly platform-gated.
- Run native contract tests on both Windows and macOS before treating them as
  shared PRE evidence.

## Avoid

- Do not pass `C:\\...` into the host `path.dirname()` from a cross-platform
  test.
- Do not fix the assertion by weakening it to a substring that can also match
  an invalid path.
- Do not platform-skip a pure path test when a host-native fixture expresses
  the same contract.

## Validation

```text
node --test scripts/local-subtitle/whisper-server/*.test.mjs
```

Confirm launch cwd, PATH allowlist and secret-exclusion assertions pass on both
Windows and macOS without changing production behavior.

## Related files

- `scripts/local-subtitle/whisper-server/supervisor.mjs`
- `scripts/local-subtitle/whisper-server/supervisor.test.mjs`
