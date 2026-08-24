# FK-PIT-0059: Detach wrapped native state on begin failure

## Area

Node-API synchronous transactions, native receipt ownership, and file descriptor lifecycle.

## Triggers

`napi_wrap`, `napi_remove_wrap`, released `unique_ptr`, begin failure, native
receipt, file descriptor leak, rename failure, GC finalizer.

## Symptoms

- The native transaction passes happy-path build and integration tests.
- Repeated synchronous `begin()` failures grow `/dev/fd` by the number of
  directory and partial-file handles retained by each attempt.
- Forcing JavaScript garbage collection does not provide a bounded or timely
  release guarantee.
- Filesystem contents remain unchanged, hiding the resource leak from ordinary
  atomicity assertions.

## Root cause

The native transaction is attached to a JavaScript receipt with `napi_wrap`, and
its `unique_ptr` ownership is released before the filesystem commit completes.
If the later commit step throws, the callback reports the error without removing
the wrap or deleting the native transaction. Cleanup is then delegated to an
unreachable receipt's eventual finalizer even though the synchronous `begin`
contract requires every handle to be released before the error returns.

## Do

- Keep explicit native ownership metadata for a receipt until `begin()` returns
  successfully.
- On every post-wrap failure, call `napi_remove_wrap`, verify that the removed
  pointer is the expected transaction, and synchronously delete it before
  throwing into JavaScript.
- Ensure destruction in the prepared phase closes every retained descriptor and
  does not perform a path-based fallback.
- Test a deterministic post-wrap failure, such as a permission-denied atomic
  rename after the directory and partial descriptors have opened.
- Repeat that failure enough times to compare `/dev/fd` before and after; require
  an exact zero descriptor delta and unchanged victim/partial bytes.
- Keep commit ordering explicit. If receipt construction moves after the native
  mutation, every possible N-API construction failure must instead perform a
  synchronous, verified rollback.

## Avoid

- Do not rely on a GC finalizer to satisfy synchronous begin-failure atomicity.
- Do not release `unique_ptr` ownership into `napi_wrap` and then return from a
  later catch path without an explicit detach/delete step.
- Do not treat unchanged directory entries as proof that native resources were
  released.
- Do not move receipt construction after commit merely to hide the leak; that
  creates an unreachable committed transaction unless rollback is guaranteed.

## Validation

```text
node --test scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.test.mjs
node scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.mjs --output <absolute-temp-path>/local-subtitle-overwrite.node
node scripts/local-subtitle/overwrite-native/run-addon-integration.mjs --addon <absolute-temp-path>/local-subtitle-overwrite.node
```

The integration report must include repeated permission-denied `begin` attempts,
`openFileDescriptorDelta: 0`, unchanged partial/victim data, and
`productionGateChanged: false`.

## Related files

- `native/local-subtitle-overwrite/src/addon.cc`
- `scripts/local-subtitle/overwrite-native/run-addon-integration.mjs`
- `scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.test.mjs`
- `electron/main/local-subtitle/overwrite-transaction.ts`
