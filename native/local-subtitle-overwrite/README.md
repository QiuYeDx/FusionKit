# Local subtitle overwrite native addon

This directory contains the macOS arm64 and Windows x64 implementations of the
synchronous local-subtitle overwrite transaction backend. They are plain
Node-API addons and do not depend on `node-addon-api`.

The canonical developer builds are:

- macOS arm64:
  `node scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.mjs`
- Windows x64:
  `node scripts/local-subtitle/overwrite-native/build-addon-windows-x64.mjs
  --toolchain-root <absolute-llvm-mingw-root>
  --node-headers <absolute-current-node-headers>
  --node-lib <absolute-current-node-lib>`

Both recipes require headers that exactly match the running Node version and
publish through a no-clobber temporary artifact. The Windows recipe additionally
requires an explicit portable LLVM-MinGW root and matching x64 `node.lib`; its
minimal child environment and receipt do not record private absolute paths.
Neither recipe invokes a package manager or `node-gyp`. `binding.gyp` is source
metadata only; it is not the verified build, staging, signing, or packaging
contract.

The production module exports exactly these own properties:

- `protocolVersion: 4`
- `platform: "darwin"` with `architecture: "arm64"`, or
  `platform: "win32"` with `architecture: "x64"`
- `begin(request)`
- `recover(request)`
- `acknowledge(request)`

`begin` accepts exactly `directoryPath`, `expectedDirectoryIdentity`,
`transactionId`, `partialLeaf`, `finalLeaf`, `expectedPartialIdentity`, and
`expectedByteSize`. `transactionId` must match
`^[A-Za-z0-9-]{1,80}$`, and `partialLeaf` must equal
`.fusionkit-local-subtitle-${transactionId}.partial`. It returns an object with
the exact own properties `expectedFinalIdentity`, `finalize`, `rollback`, and
`acknowledge`. All operations are synchronous.

`begin` writes a journal-version-3, addon-write-once, checksummed journal in the
retained output directory before its first namespace mutation. The journal
stores `transactionId` and the complete validated begin snapshot needed for
either terminal direction. Its exact leaves are
`<partialLeaf>.fusionkit-overwrite.open`,
`<partialLeaf>.fusionkit-overwrite.finalize`, and
`<partialLeaf>.fusionkit-overwrite.rollback`.

`recover` and module-level `acknowledge` accept exactly `directoryPath`,
`expectedDirectoryIdentity`, `transactionId`, and `decision`, where `decision`
is `finalize` or `rollback`. After the caller reauthorizes the directory, the
addon derives all three journal leaves from that opaque ID and never scans the
directory or accepts caller-supplied begin metadata. A validated journal
reconstructs the remaining begin request fields. Recovery of `.open` first
atomically renames it to the requested terminal marker, verifies the renamed
journal, and syncs the directory before any terminal namespace mutation.
An existing `.finalize` or `.rollback` marker that conflicts with the request is
rejected without consulting the current business-file layout.

Recovery returns exactly `finalized`, `rolled_back`, or `not_found`. A successful
terminal operation keeps its `.finalize` or `.rollback` marker and the receipt
enters pending acknowledgement. The caller must first persist its composite
state as settled, then call receipt `acknowledge()` or module-level
`acknowledge(request)`. Acknowledgement revalidates the marker and terminal
layout before removing the marker; module-level acknowledgement returns exactly
`acknowledged` or `not_found`. Therefore a pending recovery never treats a
missing marker as native terminal success. Only an already-settled composite
owner may interpret acknowledgement `not_found` as completion after a crash at
the marker-unlink boundary. Malformed, replaced, multiply linked, or
request-mismatched journals are rejected.

The absolute directory path is used only to open and verify one no-follow
directory descriptor/HANDLE. Every child lookup, rename, link, and unlink after
that point is relative to that retained authority. macOS uses
`renameatx_np(RENAME_SWAP/RENAME_EXCL)`. Windows uses `NtCreateFile` with
`RootDirectory` and `OBJ_DONT_REPARSE`, plus root-relative
`FileRenameInformationEx`, `FileLinkInformation`, and
`FileDispositionInformationEx`. The Windows existing-target path first creates
an exact hard-link backup, then installs the prepared file with POSIX replace
semantics; rollback atomically renames that backup over the installed file.

macOS identities are exact `{ dev, ino, birthtimeMs }` snapshots. Windows
identities are exact lowercase fixed-width strings:
`{ volumeSerialHex: 8 hex chars, fileIdHex: 32 hex chars }`. Windows creation
time is deliberately excluded: NTFS file tunneling can change it across an
otherwise identity-preserving rename/restore. A 128-bit Windows FileId must
never be coerced through a JavaScript safe-number `dev`/`ino` shape.

Rollback has a retryable cleanup phase. It first restores the original target
or its prior absence, then removes the identity-matching new partial relative
to the retained directory descriptor. If that unlink fails, another
`rollback()` call resumes cleanup without repeating the rename. Once rollback
has been attempted, the TypeScript receipt remains `rollback_pending` after a
failure and rejects finalize. Once cleanup completes, the rollback marker
remains until acknowledgement. The N-API finalizer continues an already-armed
rollback direction once, but never chooses rollback for an open receipt, never
acknowledges persistent state, and is not a recovery owner.

Finalize publishes its durable `.finalize` direction before deleting an existing
victim. Once finalize has started, only finalize may retry and rollback is
rejected. Existing-victim cleanup and absent-victim verification both retain the
finalize marker until acknowledgement, so fresh-process recovery continues the
persisted direction without guessing from layout. The N-API finalizer must not
reverse a pending finalize into rollback or acknowledge the marker. It may
remove a prepared `.open` journal only before begin mutates the namespace. Once
begin is open, finalization leaves `.open` intact for the main-process durable
decision; already-armed finalize or rollback work may continue only in that same
direction.

The prepared partial must have exactly one directory link. Rollback retains its
open file descriptor until `fstat` proves that link count reached zero, so a
concurrent move or added hard link cannot be reported as completed cleanup.
Failures after `napi_wrap` synchronously detach and delete the native state
before `begin()` throws; integration exercises repeated permission-denied
renames and requires a zero open-file-descriptor delta.

## Developer checkpoint evidence

### Windows x64 — 2026-07-24 (historical protocol-v3 evidence)

- Real Node load: exact five-export production surface, protocol 3.
- Production integration: 4 terminal cases, 5 recovery cases, and 6 rejection
  cases.
- Fresh-process fault integration: 3 begin crashes, 14 rollback crashes, 14
  rollback error/retries, 5 finalize error/retries, and 2 explicit
  finalize-crash boundary cases.
- RootDirectory-relative child operations, reparse/no-follow rejection,
  lossless volume/FileId identities, exact existing/absent rollback, and
  same-receipt terminal retry all passed on Windows x64.
- No finalize-crash recovery or power-loss safety claim is made.

### macOS arm64 — 2026-07-23

- Native Node tests: 11/11.
- Production integration: 4 terminal cases, 1 retained-parent case, 1 open
  decision case, 4 recovery-request contract cases, 1 hard-link retry, 6
  rejection cases, and 8 journal validation cases.
- Test-only integration: 2 begin crashes, 14 rollback crashes, 14 rollback
  error/retries, 5 finalize error/retries, and 1 unsupported-checkpoint proof.

The historical Windows protocol-v3 artifacts and earlier macOS artifact sizes
and hashes are intentionally not carried forward as protocol-v4 evidence. The
temporary protocol-v4 test artifacts are not packaged or release-manifest
identities, and the report makes no power-loss-safety claim. The current macOS
production addon has separately passed build, ad-hoc sign, stage, and
fresh-process load; the equivalent Windows protocol-v4 matrix remains pending.

This addon is only a backend primitive. Callers must load it through the
validated TypeScript adapter and
`LocalSubtitleOverwriteTransactionCoordinator`; it does not by itself permit
the production overwrite conflict policy. The production module has the exact
six-export surface above. A separately compiled fault-test artifact has one
extra `testFaultInjection` export, so the strict production loader rejects it.

Retaining the directory descriptor/HANDLE closes parent-path replacement.
Darwin's public name-based syscalls do not provide compare-and-rename/unlink
against an expected vnode, so partial/final/journal leaves must be exclusive to
cooperative FusionKit writers throughout a terminal window. Non-cooperative
same-directory writers are outside the guarantee; rechecks can detect only some
races and cannot guarantee zero mutation of foreign vnodes.

Production remains gated. The Windows component is intentionally not staged,
signed, packaged, or instantiated by production main in this checkpoint. The
component-level durable preclaim/decision, main/Registry recovery owner,
path-free repository, exact reauthorization method, generation-bound staging
and builder consumption contracts exist. Production runtime composition,
reauthorization IPC/UI, the real Windows protocol-v4 matrix, and packaged
validation remain cross-platform follow-up work.
