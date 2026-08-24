# FK-PIT-0080: Probe Windows native addons in Electron, not plain Node

## Area

Electron / Windows Node-API addon build, staging, and startup.

## Triggers

- A `.node` addon loads successfully in Node but crashes Electron.
- Electron exits with `0xFFFF7003` / `-36861` while loading a native module.
- `crashpad_client_win.cc` reports `not connected`, followed by a Vite
  `taskkill` "process not found" error.
- PE imports contain an eager `node.exe` dependency.

## Symptoms

The renderer, main, and preload builds all succeed, but Electron exits before
the first window appears. A plain Node smoke still reports the expected addon
exports, so Node-only staging and packaged validators falsely pass.

## Root cause

Electron exports the Windows Node symbols from the application executable, not
from a separately loaded `node.exe`. A Windows addon linked eagerly against a
plain Node `node.lib` can therefore pass Node tests and terminate Electron at
load time. Electron-compatible Windows native modules require the Electron
import library plus delayed `node.exe` loading and the delay-load hook.

## Do

- Probe the final addon with the actual Electron executable and
  `ELECTRON_RUN_AS_NODE=1`, not only with `process.execPath` from plain Node.
- Isolate the production startup probe in a child Electron host. Treat every
  non-zero exit, signal, spawn failure, or timeout as `module_load_failed` and
  keep the main app running with the capability unavailable.
- Give the probe a minimal allowlisted environment with no `NODE_OPTIONS`, app
  secrets, or proxy credentials.
- Revalidate the content-addressed addon proof after the child probe and before
  loading the module in the main process.
- For the permanent Windows artifact build, follow Electron's required
  `node.lib` + `/DELAYLOAD:node.exe` + `win_delay_load_hook` contract.

## Avoid

- Do not accept a successful plain Node `require(addonPath)` as Electron load
  evidence.
- Do not load an unprobed Windows addon eagerly in the Electron main process;
  a loader-level failure cannot be caught by JavaScript.
- Do not mistake Vite's later `taskkill` error for the primary crash.
- Do not pass the full parent environment into a native-module probe.

## Validation

1. Inspect the PE import table and confirm that Node symbols are not eagerly
   bound to `node.exe`.
2. Run the addon probe through the installed Electron host with
   `ELECTRON_RUN_AS_NODE=1`.
3. Run the overwrite host-preflight and production-runtime regression tests.
4. Start the full Vite/Electron development flow and confirm the FusionKit
   window remains alive even when the staged addon is incompatible.
5. Stop Vite/Electron and confirm no project processes or development ports
   remain.

## Related files

- `electron/main/local-subtitle/overwrite-native-host-preflight.ts`
- `electron/main/local-subtitle/overwrite-native-backend.ts`
- `scripts/local-subtitle/overwrite-native/overwrite-staging.mjs`
- `scripts/local-subtitle/overwrite-native/build-addon-windows-x64.mjs`
- `test/local-subtitle/overwriteNativeHostPreflight.test.ts`

