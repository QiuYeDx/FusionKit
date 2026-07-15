# FK-PIT-0017: Do not gate audio routes on inert verification metadata

## Area

Audio configuration state / Electron runtime routing

## Triggers

verification, untested, unverified, failed verification, no test connection, inert badge

## Symptoms

- Every newly configured audio API shows an "Untested" badge with no action that can change it.
- A migrated `failed` value blocks real requests even though the current product cannot re-run verification.
- Fixtures or historical metadata are presented as current provider connectivity.

## Root cause

The standalone audio profile retained route verification fields from the legacy model, but the
new settings flow never implemented a route verifier or called the Store update action. The UI
treated missing data as a meaningful product status, and main treated historical failure data as
an authoritative request gate.

## Do

- Show connectivity or verification state only when an executable, cancellable flow can update it.
- Until that flow exists, let actual task requests report credential, balance, permission, model,
  and parameter errors through the normal provider error contract.
- Keep legacy verification fields only where migration compatibility requires them, and document
  that they are not a current UI status or runtime gate.
- If verification returns later, define its per-route IPC contract, timestamps, invalidation rules,
  and retry behavior before restoring badges.

## Avoid

- Do not default missing metadata to a visible "Untested" state.
- Do not block requests on a state the user cannot refresh or repair.
- Do not describe a fixture, route shape check, or successful persistence write as provider verification.

## Validation

```text
node_modules/.bin/vitest run test/audio/audioRuntimeConfig.test.ts src/pages/Setting/components/audioApiConfigModel.test.ts src/store/tools/audio/audioToolConfig.test.ts
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
```

In Electron, seed a legacy `verification.failed` value, confirm no verification badge appears, and
confirm the actual task reaches the provider and surfaces its real result.

## Related files

- `src/pages/Setting/components/AudioApiConfig.tsx`
- `src/pages/Tools/Audio/shared/AudioToolShell.tsx`
- `electron/main/audio/audio-runtime-config.ts`
- `src/type/audio.ts`
