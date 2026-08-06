# FK-PIT-0074: Verify pinned archive entry roots with real bytes

## Area

On-demand native accelerator archives / safe extraction / production resource managers.

## Triggers

ZIP entry root, `Release/`, flat fixture, selected leaf, archive allowlist,
safe extraction, real archive, CUDA pack

## Symptoms

- Unit fixtures with flat names pass, but the official pinned archive fails
  immediately after its whole-file hash completes.
- A manual stager succeeds from a pre-extracted subdirectory while the
  production resource manager cannot extract the original archive.
- The manifest pins correct leaf hashes, but the archive contract compares
  those leaves against the wrong central-directory names.

## Root cause

The selected artifact names describe installed leaves, not necessarily the
exact names stored in the ZIP central directory. The official Windows CUDA
archive stores every file under `Release/`, while a flat fixture and the old
contract assumed bare leaf names. Rejecting every slash looked strict but made
the valid pinned archive impossible to install.

## Do

- Inspect the exact pinned archive central directory before freezing the
  extraction contract.
- Pin the full archive entry name, including a fixed directory root, separately
  from the installed output path.
- Allow only safe relative archive paths and then require an exact
  case-insensitive-unique allowlist match.
- Keep output authority in a separate fixed `outputRelativePath`; never derive
  it from an untrusted archive entry.
- Add at least one opt-in test that runs the complete real archive through the
  production resource manager, probe, commit, resolve and delete lifecycle.

## Avoid

- Do not infer archive layout from a pre-extracted `Release` directory.
- Do not let flat synthetic ZIP fixtures be the only extraction evidence.
- Do not weaken traversal, symlink/reparse, duplicate, unknown-entry,
  compression-ratio, size or hash checks merely to allow directory prefixes.
- Do not treat a separate native runtime smoke as proof that the production
  archive manager can install the same bytes.

## Validation

Run the exact pinned archive through both the low-level guard matrix and the
production manager on Windows. Confirm every selected file matches its pinned
size/SHA, the minimal launch probe passes, publication is atomic, the branded
pack resolves, production CUDA attestation binds the exact child PID, and all
temporary/installed resources can be removed.

## Related files

- `electron/main/local-subtitle/accelerator-manifest.ts`
- `electron/main/local-subtitle/accelerator-archive.ts`
- `test/local-subtitle/acceleratorArchive.test.ts`
- `test/local-subtitle/acceleratorManager.real.test.ts`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_implementation_records/2026-08-06_MODEL-002_FE-002_windows-real-resource-admission-closure.md`
