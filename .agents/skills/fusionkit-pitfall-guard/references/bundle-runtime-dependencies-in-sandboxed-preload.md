# FK-PIT-0075: Bundle runtime dependencies in sandboxed preload

## Area

Electron preload build and sandbox compatibility.

## Triggers

`sandbox preload`, `module not found`, `zod`, `motion`, `Unable to load preload script`, `external`.

## Symptoms

- Electron reports `Unable to load preload script` followed by `module not found` for an npm package.
- The renderer then fails because a context bridge such as `window.localSubtitleApi` or the legacy IPC bridge is undefined.
- The generated `dist-electron/preload/index.mjs` contains `require("<package>")` for an ordinary npm dependency.

## Root cause

Electron sandboxed preloads expose only a limited `require` implementation. Marking ordinary npm runtime dependencies as Rollup externals leaves `require("zod")`, `require("motion")`, or a similar call in the generated preload, which the sandbox cannot resolve.

## Do

- Bundle every npm runtime dependency imported by the preload graph.
- Keep only Electron-supported modules in the preload external allowlist.
- Validate the generated preload bundle, not only TypeScript compilation or a successful Vite build.
- Treat renderer bridge errors after a preload load failure as secondary symptoms.

## Avoid

- Do not externalize all `package.json` dependencies for a sandboxed preload.
- Do not add one package exception at a time as new preload imports appear.
- Do not disable sandbox or context isolation to make an external package resolvable.
- Do not fix downstream `window.*Api` consumers before restoring preload execution.

## Validation

```text
node_modules/.bin/vite build --mode=test
node scripts/check-preload-bundle.mjs
node_modules/.bin/tsc --noEmit
git diff --check
```

Confirm that `dist-electron/preload/index.mjs` requires only sandbox-allowlisted modules (currently `electron`) and does not contain an external `require("zod")` or `require("motion")`.

## Related files

- `vite.config.ts`
- `scripts/check-preload-bundle.mjs`
- `electron/preload/index.ts`
- `electron/preload/local-subtitle-api.ts`
- `electron/preload/subtitle-translation-api.ts`
- `docs/startup-loading-design.md`
