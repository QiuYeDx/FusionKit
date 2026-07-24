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

- `protocolVersion: 3`
- `platform: "darwin"` with `architecture: "arm64"`, or
  `platform: "win32"` with `architecture: "x64"`
- `begin(request)`
- `recover(request)`

`begin` accepts exactly `directoryPath`, `expectedDirectoryIdentity`,
`transactionId`, `partialLeaf`, `finalLeaf`, `expectedPartialIdentity`, and
`expectedByteSize`. `transactionId` must match
`^[A-Za-z0-9-]{1,80}$`, and `partialLeaf` must equal
`.fusionkit-local-subtitle-${transactionId}.partial`. It returns an object with
the exact own properties `expectedFinalIdentity`, `finalize`, and `rollback`.
All three operations are synchronous.

`begin` writes a journal-version-2, addon-write-once, checksummed journal in the
retained output directory before its first namespace mutation. The journal
stores `transactionId` and the complete validated begin snapshot needed for
rollback. Its exact leaves are `<partialLeaf>.fusionkit-overwrite.open` and
`<partialLeaf>.fusionkit-overwrite.rollback`.

`recover` accepts exactly `directoryPath`, `expectedDirectoryIdentity`, and
`transactionId`. After the caller reauthorizes the directory, the addon derives
the two possible journal leaves from that opaque ID and never scans the
directory or accepts caller-supplied rollback metadata. A validated journal
reconstructs the remaining begin request fields. The first rollback attempt
atomically renames `.open` to `.rollback` before restoring or deleting any leaf.
Recovery returns exactly one state: `rolled_back`, `decision_required`, or
`not_found`. A valid, ID-matching open journal is
`decision_required`; malformed, replaced, multiply linked, or request-mismatched
journals are rejected. This checkpoint does not guess a terminal direction for
an abandoned receipt or finalize crash. A finalize crash after `.open` has
already been unlinked may instead make `recover()` return `not_found`; finalize
crash recovery is intentionally unsupported and unclaimed at this checkpoint.

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
failure and rejects finalize. The N-API finalizer makes one best-effort attempt
but is not a persistent recovery owner.

Finalize has a separate in-memory direction lock. Once the native finalize
method has started, a throw leaves the TypeScript receipt `finalize_pending`;
only `finalize()` on that same receipt may retry, and rollback is rejected. The
Exporter retries once and, if the retry also fails, keeps the activated Registry
commit direction for a future composite owner. This is not a durable commit
decision: after a process crash the remaining `.open` journal still produces
`decision_required`, and the N-API finalizer must not reverse a pending finalize
into rollback.

The prepared partial must have exactly one directory link. Rollback retains its
open file descriptor until `fstat` proves that link count reached zero, so a
concurrent move or added hard link cannot be reported as completed cleanup.
Failures after `napi_wrap` synchronously detach and delete the native state
before `begin()` throws; integration exercises repeated permission-denied
renames and requires a zero open-file-descriptor delta.

## Developer checkpoint evidence

### Windows x64 — 2026-07-24

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

Protocol-v2 artifact sizes and hashes are intentionally not carried forward as
protocol-v3 evidence. The temporary protocol-v3 test artifacts are not staged,
signed, packaged, or release-manifest identities, and the report makes no
finalize crash-recovery or power-loss-safety claim.

This addon is only a backend primitive. Callers must load it through the
validated TypeScript adapter and
`LocalSubtitleOverwriteTransactionCoordinator`; it does not by itself permit
the production overwrite conflict policy. The production module has the exact
five-export surface above. A separately compiled fault-test artifact has one
extra `testFaultInjection` export, so the strict production loader rejects it.

Retaining the directory descriptor/HANDLE closes parent-path replacement.
Darwin's public name-based syscalls do not provide compare-and-rename/unlink
against an expected vnode, so partial/final/journal leaves must be exclusive to
cooperative FusionKit writers throughout a terminal window. Non-cooperative
same-directory writers are outside the guarantee; rechecks can detect only some
races and cannot guarantee zero mutation of foreign vnodes.

Production remains gated. The Windows component is intentionally not staged,
signed, packaged, or instantiated by production main in this checkpoint. The
component-level main/Registry recovery owner, path-free repository, and exact
reauthorization method exist, but the prepared handoff is process-local rather
than a durable preclaim. Durable finalize/open decisions, production runtime
composition, staging/builder integration, reauthorization IPC/UI, and packaged
validation remain cross-platform follow-up work.
