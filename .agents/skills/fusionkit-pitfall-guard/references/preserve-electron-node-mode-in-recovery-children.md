# FK-PIT-0141: Preserve Electron Node mode in recovery children

## Area

Windows native acceptance / Electron child-process host selection.

## Triggers

`ELECTRON_RUN_AS_NODE`, `process.execPath`, fresh-process recovery, minimal child environment, Electron version differs from embedded Node.

## Symptoms

A native acceptance runner works in its Electron parent, but a fresh recovery child uses the Electron application interpreter instead of Node. The same executable reports Electron 41.10.6 without the flag and embedded Node 24.18.0 with it.

## Root cause

The parent is launched with `ELECTRON_RUN_AS_NODE=1`. Its recovery helper correctly sanitizes the child environment but discards that host-selection flag while spawning `process.execPath`. Reusing the executable path alone does not preserve interpreter mode.

## Do

- Preserve exactly `ELECTRON_RUN_AS_NODE=1` when the parent environment explicitly selects it.
- Keep the remaining child environment minimal; do not forward `NODE_OPTIONS`, arbitrary application values, or proxy credentials.
- Prove the counterexample using the same actual Electron executable and both environments, then run real fresh-process native recovery.
- Keep production and fault-injection addon artifacts separate, and close all test children.

## Avoid

- Do not replace Electron acceptance with a plain Node load to make the test pass.
- Do not inherit the complete host environment as a workaround.
- Do not treat a copied `process.execPath` as evidence that the child's interpreter matches the parent's.

## Validation

`windows-electron-host.test.mjs` checks the exact flag allowlist and demonstrates the actual interpreter difference. The new Windows recovery integration then executes the native fault matrix through fresh Electron children. T07 records both kinds of evidence separately from production runtime behavior.

## Related files

- `scripts/subtitle-studio/transcription/overwrite-native/run-addon-windows-recovery-integration.mjs`
- `scripts/subtitle-studio/transcription/overwrite-native/windows-electron-host.test.mjs`
- `scripts/subtitle-studio-provenance/windows-addon-copy-recipe.json`
- `docs/features/subtitle-studio/records/2026-09-12-transcription-windows-runtime.md`
