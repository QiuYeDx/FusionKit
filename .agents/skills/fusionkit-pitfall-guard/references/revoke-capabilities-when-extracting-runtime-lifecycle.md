# FK-PIT-0134: Revoke capabilities when extracting runtime lifecycle

## Area

Subtitle Studio / runtime composition / owner lifetime.

## Triggers

runtime factory, releaseOwner, session lifecycle, input authorization, asynchronous revocation.

## Symptoms

An extracted runtime stops jobs and sessions successfully, but capabilities issued by its input, output, artifact or import-token registries remain valid. An asynchronous request can also finish after its owner was released.

## Root cause

The original IPC composition revoked registries separately from the session lifecycle. Copying only the lifecycle call omits that second responsibility. An admission check alone does not fence an asynchronous result against later owner release.

## Do

- Trace the entire original composition, including cleanup in IPC registration and teardown.
- Fence the owner and abort its operations before releasing lifecycle services and every capability registry.
- Attempt all independent revocations even if one throws; collect failures and allow cleanup retry.
- Recheck owner lifetime before returning an asynchronous capability or resource result.
- Retain the canonical runtime-root lock until all required cleanup succeeds.

## Avoid

- Do not treat successful session cleanup as proof that all capabilities expired.
- Do not stop revocation after the first registry error or release the resource-root lock after failed shutdown.
- Do not test revocation solely with structurally forged tokens that were never valid.

## Validation

Run `node node_modules/vitest/vitest.mjs run test/subtitle-studio/transcription-runtime.test.ts --maxWorkers=1 --minWorkers=1`. Cover an actually issued token with a valid positive control, registry failure and retry, asynchronous release, separate owners, and failed shutdown retaining the canonical root lock.

## Related files

- `electron/main/subtitle-studio/transcription/runtime.ts`
- `electron/main/subtitle-studio/transcription/native/session-lifecycle.ts`
- `test/subtitle-studio/transcription-runtime.test.ts`
- `docs/features/subtitle-studio/records/2026-09-12-transcription-runtime-native.md`
