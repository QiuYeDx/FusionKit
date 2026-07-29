# FK-PIT-0068: Flush NT-opened journals with NtFlushBuffersFile

## Area

Windows native filesystem transactions / Node-API

## Triggers

NtCreateFile, NtFlushBuffersFile, FlushFileBuffers, FILE_WRITE_DATA,
GENERIC_WRITE, overwrite journal, Windows error 5

## Symptoms

- Journal creation and writes succeed, but the durability flush fails with
  `ERROR_ACCESS_DENIED`.
- Adding `GENERIC_WRITE` or `FILE_GENERIC_WRITE` to a RootDirectory-relative
  `NtCreateFile` call makes the open itself fail.
- Contract fixtures pass while the real Windows x64 terminal or recovery
  matrix fails at the first journal sync.

## Root cause

`FlushFileBuffers` is a Win32 API whose documented handle contract requires
`GENERIC_WRITE`. A journal opened through `NtCreateFile` with the narrower NT
specific rights `FILE_READ_DATA | FILE_WRITE_DATA` can read and write bytes but
does not satisfy that Win32 generic-access check. Expanding the desired access
is not equivalent and can exceed the permissions accepted by the
RootDirectory-relative open.

## Do

- Keep the least-privilege NT journal access mask needed by the protocol.
- Resolve `NtFlushBuffersFile` from the same `ntdll` API set used for
  `NtCreateFile` and `NtSetInformationFile`.
- Flush the already-open journal HANDLE with `NtFlushBuffersFile` and an
  `IO_STATUS_BLOCK`.
- Convert the returned `NTSTATUS` through the existing native error path.
- Exercise the real production and fault-test addons on Windows; source-string
  checks alone cannot prove the handle contract.

## Avoid

- Do not pass a narrowly NT-opened HANDLE to `FlushFileBuffers`.
- Do not broaden the journal open to `GENERIC_WRITE` merely to satisfy a
  different API layer.
- Do not weaken journal durability or omit the flush when the Win32 call fails.
- Do not classify `ERROR_ACCESS_DENIED` here as a user directory permission
  problem before checking the open/flush API contract.

## Validation

```powershell
node --test scripts/local-subtitle/overwrite-native/build-addon-windows-x64.test.mjs
node scripts/local-subtitle/overwrite-native/run-addon-windows-integration.mjs --addon <absolute-production-addon.node>
node scripts/local-subtitle/overwrite-native/run-addon-windows-recovery-integration.mjs --addon <absolute-test-addon.node>
```

The build test must compile and load both variants without skipping. The real
terminal and fresh-process recovery matrices must pass with durable journal
sync enabled.

## Related files

- `native/local-subtitle-overwrite/src/addon-win32.cc`
- `scripts/local-subtitle/overwrite-native/build-addon-windows-x64.mjs`
- `scripts/local-subtitle/overwrite-native/build-addon-windows-x64.test.mjs`
- `scripts/local-subtitle/overwrite-native/run-addon-windows-integration.mjs`
- `scripts/local-subtitle/overwrite-native/run-addon-windows-recovery-integration.mjs`
