# Derive current runtime metadata from the package manifest

## Area

Docs / Frontend / Build metadata

## Triggers

Electron upgrade, stale About page, README version mismatch, tech stack, build information, package.json

## Symptoms

- `package.json` and the lockfile use a newer Electron release, while the About page still displays an older major version.
- Current README or developer-reference pages describe a dependency range that no longer matches the pinned runtime.
- Updating one visible string leaves another current metadata surface stale.

## Root cause

Runtime versions were copied into renderer strings and documentation independently. The build had no package-backed metadata define for the About page, and no regression check bound current static documentation to the manifest.

## Do

- Treat the pinned dependency in `package.json` as the source of truth for current runtime metadata.
- Inject renderer-visible build metadata from the manifest in Vite configuration.
- Keep current README and developer-reference values exact, and cover them with a lightweight consistency test.
- Preserve historical implementation records, evidence captures, and compatibility fixtures as records of the runtime they actually tested.

## Avoid

- Do not hardcode the current Electron version directly in a renderer component.
- Do not bulk-replace historical Electron version references across archived evidence or test fixtures.
- Do not infer the active version from an old design document when the manifest and lockfile are available.

## Validation

- Run `pnpm exec vitest run test/projectMetadata.test.ts`.
- Run `pnpm exec tsc --noEmit`.
- Run the root `pnpm exec vite build --mode=test` so renderer, main, and preload build together.
- Search current, non-historical surfaces for the superseded version.

## Related files

- `package.json`
- `pnpm-lock.yaml`
- `vite.config.ts`
- `src/vite-env.d.ts`
- `src/pages/About/index.tsx`
- `README.md`
- `docs/electron-renderer-api-quick-reference.md`
- `test/projectMetadata.test.ts`
