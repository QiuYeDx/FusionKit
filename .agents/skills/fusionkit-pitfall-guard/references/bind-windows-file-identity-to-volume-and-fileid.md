# FK-PIT-0063: Bind Windows file identity to volume serial and FileId

## Area

Windows native filesystem transactions / Node-API

## Triggers

Windows, NTFS, FileId, volume serial, birthtime, creation time, file
tunneling, rename, replace, overwrite recovery, PCM window, multipart upload,
runtime_protocol_mismatch

## Symptoms

- An identity-preserving rollback or replacement fails because creation time
  changed by a small amount.
- A Windows `fs.stat()` identity is converted to JavaScript `number` fields and
  silently loses high FileId bits.
- A newly materialized PCM window intermittently fails before upload with
  `runtime_protocol_mismatch`, even though the native server protocol is valid.
- The same file HANDLE proves one object while a `{ dev, ino, birthtimeMs }`
  snapshot reports a mismatch after a rename/replace sequence.

## Root cause

NTFS file tunneling can preserve or substitute directory-entry metadata during
rapid delete/rename/recreate operations, so creation time is not a stable part
of object identity for this transaction. Windows FileId is 128 bits and cannot
be represented losslessly by JavaScript's safe-integer range. Reusing the POSIX
identity shape therefore creates both false mismatches and possible collisions.

## Do

- Query `FILE_ID_INFO` from the already opened HANDLE.
- Represent the exact identity as fixed-width lowercase strings:
  `{ volumeSerialHex: 8 hex chars, fileIdHex: 32 hex chars }`.
- Compare both fields exactly and validate the exact own-key shape at every
  JavaScript/native boundary.
- Keep Windows and POSIX identities as a discriminated structural union.
- Reuse `filesystem-object-identity.ts` for complete file proofs used by input
  authorization, PCM materialization, inference dispatch, and multipart upload;
  do not reintroduce local `{ dev, ino }` helpers in those layers.
- Test identity continuity through existing-target replace, absent-target
  install, rollback, finalize, and fresh-process recovery.

## Avoid

- Do not include creation/birth time in Windows object identity.
- Do not coerce a 128-bit FileId through `Number`, `dev`, or `ino`.
- Do not accept variable-width, uppercase, or expanded identity objects.
- Do not assume a millisecond creation-time delta proves that the HANDLE now
  names a different object.

## Validation

```powershell
node node_modules/typescript/bin/tsc --noEmit --pretty false
node node_modules/vitest/vitest.mjs run test/local-subtitle/filesystemObjectIdentity.test.ts test/local-subtitle/mediaNormalizer.test.ts test/local-subtitle/pcmWindow.test.ts test/local-subtitle/serverContract.test.ts test/local-subtitle/serverHttpClient.test.ts test/local-subtitle/productionExecutor.test.ts
node node_modules/vitest/vitest.mjs run test/local-subtitle/overwriteDirectoryCoordinator.test.ts test/local-subtitle/overwriteTransaction.test.ts test/local-subtitle/overwriteNativeBackend.test.ts
node scripts/local-subtitle/overwrite-native/run-addon-windows-integration.mjs --addon <absolute-production-addon.node>
node scripts/local-subtitle/overwrite-native/run-addon-windows-recovery-integration.mjs --addon <absolute-test-addon.node>
```

The native integrations must compare Node's bigint `st_dev`/`st_ino` rendering
with the addon's fixed-width volume/FileId strings and must pass both
existing-target and absent-target terminal/recovery cases.

## Related files

- `native/local-subtitle-overwrite/src/addon-win32.cc`
- `electron/main/local-subtitle/overwrite-transaction.ts`
- `electron/main/local-subtitle/overwrite-directory-coordinator.ts`
- `electron/main/local-subtitle/filesystem-object-identity.ts`
- `electron/main/local-subtitle/pcm-window.ts`
- `electron/main/local-subtitle/server-http-client.ts`
- `scripts/local-subtitle/overwrite-native/run-addon-windows-integration.mjs`
- `scripts/local-subtitle/overwrite-native/run-addon-windows-recovery-integration.mjs`
