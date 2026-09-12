# FK-PIT-0137: Match filesystem runtime fixtures to the host target

## Area

Subtitle Studio / native lifecycle tests / Windows filesystem permissions.

## Triggers

Darwin fixture on Windows, startup cleanup directory is not private, 0700,
stat.mode, runtime initialization, synthetic child process, cross-platform tests.

## Symptoms

A runtime suite fails during startup cleanup on Windows before reaching its
assertions, even though its server and process adapters are synthetic. The
fixture selects darwin/arm64, so the real cleanup code rejects Windows directory
mode bits as if they were POSIX permissions.

## Root cause

Mocking process launch does not replace the host filesystem. The runtime passes
its selected target into resource startup cleanup, and a non-Windows target
correctly requires private directories with mode 0700. Windows does not expose
those POSIX permission semantics. A foreign fixture target therefore creates a
hybrid test that exercises neither platform's real contract.

## Do

- When the fixture exercises real filesystem creation, stat checks, cleanup, or
  resource layout, select the supported target for the current host: win32/x64
  on Windows and darwin/arm64 for the supported macOS fixture.
- Generate the resource manifest and runtime environment from that same target;
  keep native processes, network, and inference behind the isolated adapters.
- Derive invalid-target test cases from the selected fixture target. A fixed
  x64 value is not invalid once the Windows fixture correctly uses x64.
- If testing a foreign target specifically, isolate or inject its filesystem
  semantics too, and label the result as a contract test rather than native
  platform evidence.
- Re-run the real runtime startup and cleanup tests without bypassing the
  permission guard. Keep all fixture userData under their temporary roots.

## Avoid

- Do not weaken or disable the production private-directory guard to repair a
  mismatched test fixture.
- Do not assume a synthetic child process makes every runtime operation
  platform-independent.
- Do not use a host-correct fixture pass as proof of real ASR, native executable,
  GPU, signing, or packaging readiness.

## Validation

```text
node node_modules/vitest/vitest.mjs run test/subtitle-studio/transcription-runtime.test.ts test/subtitle-studio/transcription-runtime-lifecycle.test.ts --maxWorkers=1 --minWorkers=1
```

The lifecycle suite uses real runtime composition and capability cleanup around
a controlled task queue. It must initialize on Windows, retain the root during
failed/pending cleanup, and permit reopening only after successful cleanup.

## Related files

- `test/subtitle-studio/helpers/transcription-runtime.ts`
- `test/subtitle-studio/transcription-runtime.test.ts`
- `test/subtitle-studio/transcription-runtime-lifecycle.test.ts`
- `electron/main/subtitle-studio/transcription/runtime.ts`
- `electron/main/subtitle-studio/transcription/native/resource-startup-cleaner.ts`
- [Use host-native path fixtures](use-host-native-path-fixtures-in-cross-platform-node-tests.md)
