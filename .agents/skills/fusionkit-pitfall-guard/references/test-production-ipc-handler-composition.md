# FK-PIT-0079: Test production IPC handler composition

## Area

Electron / preload / production IPC composition.

## Triggers

fixed preload API, public IPC contract, handler missing, unavailable fallback, production composition, renderer API exists, bridge unit test passes

## Symptoms

- A renderer method exists in TypeScript and preload tests but always returns the generic unavailable fallback in the running application.
- Adjacent IPC operations work, creating a contradictory UI where one state source is ready and another is unavailable.
- Bridge-level tests pass because they never exercise the handler object assembled in `electron/main/index.ts`.

## Root cause

Declaring a channel and exposing a preload method does not register its production main-process handler. A dedicated bridge can also be implemented correctly but omitted from the public handler spreads used to construct `LocalSubtitleIpcService`.

## Do

- Give each fixed public operation a concrete main-process owner or an intentional built-in implementation.
- Register the bridge in the production `LocalSubtitleIpcService` composition before any renderer window is created.
- Add a production-composition test that asserts the bridge is instantiated, its public handlers are included, and IPC setup completes before the first window.
- Keep a focused bridge test that validates the real result schema and expected failure classifications.
- When two renderer state sources disagree, trace each IPC channel independently before changing UI readiness logic.

## Avoid

- Do not treat shared channel enums, renderer typings, preload allowlists, or preload tests as proof that production main handles the operation.
- Do not replace a missing handler with a renderer-side ready flag or suppress the unavailable error.
- Do not rely only on tests that manually assemble a subset of handlers.

## Validation

```text
node_modules/.bin/vitest run test/local-subtitle/runtimeIpc.test.ts test/local-subtitle/overwriteProductionRuntime.test.ts
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode=test
node scripts/check-preload-bundle.mjs
git diff --check
```

## Related files

- `electron/main/index.ts`
- `electron/main/local-subtitle/ipc.ts`
- `electron/main/local-subtitle/runtime-ipc.ts`
- `electron/preload/local-subtitle-api.ts`
- `test/local-subtitle/runtimeIpc.test.ts`
- `test/local-subtitle/overwriteProductionRuntime.test.ts`
