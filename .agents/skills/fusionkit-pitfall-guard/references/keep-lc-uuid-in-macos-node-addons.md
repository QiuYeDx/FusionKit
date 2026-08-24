# FK-PIT-0058: Keep LC_UUID in macOS Node-API addons

## Area

macOS native builds, plain Node-API addons, and packaged Electron runtime validation.

## Triggers

`LC_UUID`, `-Wl,-no_uuid`, `ERR_DLOPEN_FAILED`, `missing LC_UUID load command`,
macOS 26, `.node`, reproducible native build.

## Symptoms

- The addon compiles and reports the expected arm64 Mach-O file type.
- `require()` or `process.dlopen()` fails with `ERR_DLOPEN_FAILED` and
  `missing LC_UUID load command`.
- Source and compiler inputs look valid, so the failure is misclassified as a
  Node-API ABI or architecture mismatch.

## Root cause

Passing `-Wl,-no_uuid` removes the Mach-O `LC_UUID` load command. Current macOS
dyld requires that command when loading the bundle, so suppressing it for byte
reproducibility produces an artifact that cannot be loaded.

## Do

- Let the linker emit `LC_UUID` for macOS `.node` bundles.
- Validate the final artifact with both `file` / Mach-O metadata inspection and
  a real Node `require()` that checks the native protocol exports.
- Freeze hashes only after the final link/signing phase defined by the runtime
  staging contract.
- Treat successful compilation as build evidence, not loadability evidence.

## Avoid

- Do not pass `-Wl,-no_uuid` to a loadable macOS Node addon.
- Do not trade runtime loadability for deterministic bytes.
- Do not replace a real artifact load test with a compiler exit-code assertion.

## Validation

```text
node scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.mjs
node --test scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.test.mjs
```

Confirm the built `.node` is arm64, contains `LC_UUID`, loads in the supported
Node runtime, and exports the exact native protocol object.

## Related files

- `native/local-subtitle-overwrite/src/addon.cc`
- `scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.mjs`
- `scripts/local-subtitle/overwrite-native/build-addon-macos-arm64.test.mjs`
