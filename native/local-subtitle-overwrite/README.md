# Local subtitle overwrite native addon

This directory contains the macOS arm64 implementation of the synchronous
local-subtitle overwrite transaction backend. It is a plain Node-API addon and
does not depend on `node-addon-api`.

The canonical developer build is
`node scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.mjs`.
It uses the current Node installation's matching headers and does not invoke a
package manager or `node-gyp`. `binding.gyp` is source metadata only; it is not
the verified build, staging, signing, or packaging contract.

The production module exports exactly these own properties:

- `protocolVersion: 3`
- `platform: "darwin"`
- `architecture: "arm64"`
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
directory descriptor. Every child lookup, rename, swap, and unlink after that
point is relative to the retained descriptor. Existing targets are installed
with `RENAME_SWAP`; absent targets use `RENAME_EXCL`.

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

## 2026-07-23 developer checkpoint evidence

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

Retaining the directory descriptor closes parent-path replacement. Darwin's
public name-based syscalls do not provide compare-and-rename/unlink against an
expected vnode, so partial/final/journal leaves must be exclusive to cooperative
FusionKit writers throughout a terminal window. Non-cooperative same-directory
writers are outside the guarantee; rechecks can detect only some races and
cannot guarantee zero mutation of foreign vnodes. Production remains gated.
The component-level main/Registry recovery owner, path-free repository, and
exact reauthorization method now exist, but the prepared handoff is
process-local rather than a durable preclaim and production main does not
instantiate the native runtime or owner. Windows, durable finalize/open
decisions, runtime staging, reauthorization IPC/UI, and packaged validation
also remain incomplete.
