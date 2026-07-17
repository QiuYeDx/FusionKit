# FK-PIT-0033: Freeze native hashes after final nested signing

## Area

Electron packaging / code signing / runtime manifest

## Triggers

codesign,nested executable,SHA-256,runtime manifest,extraResources

## Symptoms

Hashing a Mach-O before its final nested signature makes the manifest stale because codesign mutates the binary.

## Root cause

Mach-O code signing writes or replaces the executable's code-signature load
command and signature blob. That changes the file size and SHA-256 even when
the program code is otherwise unchanged. If a manifest is created from the
unsigned bytes, or if an outer Electron signing pass signs the nested runtime
again, the packaged bytes no longer match the frozen manifest.

## Do

- Copy native executables into their final staging layout first.
- Apply the final nested identity, identifier and hardened-runtime options
  before calculating byte size or SHA-256.
- Verify each nested signature, then generate the runtime manifest from those
  signed bytes.
- Copy the frozen staging directory through `extraResources` and exclude it
  from any recursive outer-app signing pass.
- After signing the outer app, compare every packaged runtime hash with the
  pre-signing manifest and run an independent deep/strict app verification.
- Re-stage and regenerate the manifest whenever the nested identity or signing
  options change.

## Avoid

- Do not hash an unsigned executable and sign it afterward.
- Do not let electron-builder or another deep-signing helper silently re-sign
  native files after the manifest is frozen.
- Do not repair a mismatch by editing the manifest inside a signed app bundle.

## Validation

```text
node --test scripts/local-subtitle/runtime/*.test.mjs
node scripts/local-subtitle/runtime/stage-runtime.mjs <ignored staging arguments>
node scripts/local-subtitle/runtime/sign-packaged-spike.mjs --app <packaged app>
```

The signing report must say that outer signing left the runtime manifest and
all artifact hashes unchanged. `/usr/bin/codesign --verify --deep --strict`
must also pass for the final app.

## Related files

- `scripts/local-subtitle/runtime/stage-runtime.mjs`
- `scripts/local-subtitle/runtime/runtime-manifest.mjs`
- `scripts/local-subtitle/runtime/generate-electron-builder-spike.mjs`
- `scripts/local-subtitle/runtime/sign-packaged-spike.mjs`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
