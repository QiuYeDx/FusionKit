# FK-PIT-0048: Use the root Vite config for Electron build validation

## Area

FusionKit frontend, Electron main/preload build validation.

## Triggers

`vite.config.main.ts`, `vite.config.preload.ts`, missing config, three-part build,
`vite-plugin-electron`.

## Symptoms

- Validation reports that `vite.config.main.ts` or `vite.config.preload.ts` cannot
  be resolved.
- A successful renderer/main/preload build is repeated with invented config
  paths and then misclassified as a product build failure.

## Root cause

FusionKit has one root `vite.config.ts`. Its `vite-plugin-electron/simple`
configuration builds the renderer, Electron main, and preload outputs in one
`vite build` invocation. There are no standalone main or preload config files.

## Do

- Inspect the repository config before choosing build commands.
- Run `node_modules/.bin/vite build --mode=test` for the three-part test build.
- Confirm the output includes `dist/`, `dist-electron/main`, and
  `dist-electron/preload`.
- Call the checked-in local binary directly when pnpm lockfile compatibility is
  part of the task constraints.

## Avoid

- Do not invent `--config vite.config.main.ts` or
  `--config vite.config.preload.ts` commands.
- Do not classify a missing invented config as a regression in application code.
- Do not run an unpinned package-manager command merely to invoke Vite.

## Validation

```text
rg --files -g 'vite.config*' -g 'electron.vite.config*'
node_modules/.bin/vite build --mode=test
```

Expected build output includes renderer, main, and preload artifacts from the
single command.

## Related files

- `vite.config.ts`
- `package.json`
