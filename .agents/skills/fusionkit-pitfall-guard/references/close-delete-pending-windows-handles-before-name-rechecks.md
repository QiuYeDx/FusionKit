# FK-PIT-0069: Close delete-pending Windows handles before name rechecks

## Area

Windows native overwrite recovery / NTFS

## Triggers

FileDispositionInformationEx, POSIX delete, delete pending, RootDirectory,
NtCreateFile, rollback, finalize, recovery, Windows error 5

## Symptoms

- A rollback or finalize mutation succeeds, but the following named absence or
  identity proof fails with `NtCreateFile(...): Windows error 5`.
- The deleted object's retained HANDLE reports zero links while reopening the
  old leaf name is still denied.
- Contract tests pass, but fresh-process recovery fails only on real NTFS.

## Root cause

`FileDispositionInformationEx` with POSIX delete removes the directory entry,
but the file object remains delete-pending until every open HANDLE to that
object closes. Reopening or revalidating the same leaf while recovery still
retains final, partial, victim, or unlinked-object handles can therefore return
access denied instead of the expected missing status.

## Do

- Prove the unlinked object's link count on the retained HANDLE first.
- Close every recovery HANDLE that may still reference the deleted or renamed
  object before any name-based absence or restored-identity check.
- Treat explicit close failures as filesystem failures; do not silently defer
  them to RAII destruction after the proof.
- Add semantic labels to each recovery open so a failure identifies the exact
  final, partial, or victim boundary.
- Cover existing-target and absent-target rollback/finalize, crash injection,
  and same-receipt retry on real Windows x64.

## Avoid

- Do not reopen a POSIX-deleted leaf while a related retained HANDLE is still
  alive.
- Do not move the zero-link proof after closing the only handle that can prove
  the deleted object.
- Do not interpret access denied as equivalent to absent.
- Do not rely on lexical scope alone when the next proof occurs before scope
  exit.

## Validation

```powershell
node scripts/local-subtitle/overwrite-native/run-addon-windows-integration.mjs --addon <absolute-production-addon.node>
node scripts/local-subtitle/overwrite-native/run-addon-windows-recovery-integration.mjs --addon <absolute-test-addon.node>
```

The real matrix must include existing/absent terminal cases, open decisions,
begin/rollback/finalize/acknowledgement crash boundaries, error retries,
conflicts, and post-delete named absence checks.

## Related files

- `native/local-subtitle-overwrite/src/addon-win32.cc`
- `scripts/local-subtitle/overwrite-native/run-addon-windows-integration.mjs`
- `scripts/local-subtitle/overwrite-native/run-addon-windows-recovery-integration.mjs`
