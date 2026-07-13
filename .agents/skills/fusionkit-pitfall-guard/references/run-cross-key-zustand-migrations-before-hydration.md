# FK-PIT-0006: Run cross-key Zustand migrations before hydration

## Area

Frontend state / persistence

## Triggers

Zustand, persist, cross-key migration, hydration, legacy store, dangling references

## Symptoms

- A new persisted Store is empty even though the old key still contains data.
- A legacy Store migration filters dangling references before a cross-key migration can preserve them.
- Importing Store A before Store B produces a different result from importing Store B first.
- A failed target write still leaves a completion marker and prevents retry.

## Root cause

Zustand `persist` can hydrate synchronously while the Store module is evaluated. If
the source Store is created first, its own migration/merge may normalize or filter
data before application-entry bootstrap code runs. Cross-key migration then sees
only the already-reduced state. Module import order becomes an undocumented data
migration dependency.

## Do

- Keep the pure transformation separate from storage I/O.
- Run one idempotent bootstrap before `create(persist(...))` in both source and target Store modules.
- Parse the raw source envelope directly and reject structures that normalization would discard.
- Preserve the source key; write the target, read it back, and verify the complete serialized state before recording completion.
- Test both Store import orders with `vi.resetModules()`, missing-reference data, a second bootstrap, and read/write failures.

## Avoid

- Do not defer cross-key migration to an app entry component, effect, or post-hydration callback.
- Do not rely on the target Store being imported first.
- Do not mark migration complete after only calling `setItem` or checking a marker in a potentially truncated readback.
- Do not delete or mutate the source key during the compatibility window.

## Validation

```text
node_modules/.bin/vitest run src/lib/audio-api-migration.test.ts src/store/audioStoreBootstrap.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

Confirm model-first and target-first imports produce the same target state, a
missing-reference profile survives, failed persistence remains retryable, and a
completed second bootstrap performs no write.

## Related files

- `src/lib/audio-api-migration.ts`
- `src/store/useAudioApiStore.ts`
- `src/store/useModelStore.ts`
- `src/store/audioStoreBootstrap.test.ts`
- `docs/v0.2.11/audio-toolkit/audio-toolkit-config-ux-refactor_final_design.md`
