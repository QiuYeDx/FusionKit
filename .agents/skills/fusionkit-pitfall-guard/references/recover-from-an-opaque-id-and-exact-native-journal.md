# FK-PIT-0062: Recover from an opaque ID and exact native journal

## Area

Node/Electron transactional recovery, output-directory authorization, and
privacy-preserving persistence.

## Triggers

Recovery ID, reauthorization, path-free repository, native journal, prefix scan,
durable decision, terminal marker, acknowledgement, `not_found`.

## Symptoms

- A recovery repository persists the original output path, capability, token, or
  a complete rollback request so startup can recover without user interaction.
- Recovery scans `.fusionkit-*` prefixes and claims an identity-looking journal
  that the current transaction never proved it created.
- A caller reconstructs native rollback metadata from mutable application state
  instead of reading the exact write-once journal bound to the transaction.
- `not_found` is treated as completion and releases a selected directory even
  though the composite native/Registry decision remains unresolved.

## Root cause

An application-level recovery record is durable coordination metadata, not
filesystem ownership proof. Persisting a path or full native request weakens the
capability boundary, while a prefix match cannot prove journal ownership. An
opaque ID becomes useful only after the user reauthorizes the exact directory and
the native backend derives and validates the one journal leaf bound to that ID.

## Do

- Persist only the recovery schema, opaque ID, owner fingerprint,
  task/generation/format, durable decision, native state, and timestamps.
- Require the user to reauthorize the directory, then verify its exact object
  identity before invoking recovery.
- Pass only the opaque transaction ID, authorized directory, expected directory
  identity, and persisted finalize/rollback decision to native recovery.
- Let the native backend derive the exact journal names and reconstruct rollback
  metadata from the checksummed, ID-matching journal.
- Keep `pending` or `retry_failed` plus recovery `not_found` pending: retain the
  durable record and selected directory fence until native and Registry
  authority truly converge. Only `rollback_unpublished + not_started` may use
  recovery `not_found` to prove begin never created a journal.
- Retain `.finalize` or `.rollback` after namespace convergence; remove it only
  after the owner durably records `settled` and calls exact acknowledgement.

## Avoid

- Do not persist raw output paths, capabilities, tokens, partial/final leaves,
  Registry references, or caller-built rollback requests.
- Do not scan user directories by prefix or infer journal ownership from layout,
  file identity, or matching content.
- Do not accept caller-supplied native rollback metadata after restart.
- Do not release a recovery fence merely because the exact journal is absent;
  absence can also follow an unresolved finalize crash.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/overwriteNativeBackend.test.ts \
  test/local-subtitle/overwriteRecoveryOwner.test.ts
node --test scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.test.mjs
node_modules/.bin/tsc --noEmit --pretty false
git diff --check
```

Cover path/token-free serialization, exact four-key request validation, stale
metadata, same-recovery concurrent directory selections, pending `not_found`
fences, settled acknowledgement, malformed or mismatched journals, and
fresh-process exact-ID recovery.

## Related files

- `electron/main/local-subtitle/overwrite-recovery-owner.ts`
- `electron/main/local-subtitle/overwrite-native-backend.ts`
- `native/local-subtitle-overwrite/src/addon.cc`
- `test/local-subtitle/overwriteRecoveryOwner.test.ts`
- `test/local-subtitle/overwriteNativeBackend.test.ts`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
