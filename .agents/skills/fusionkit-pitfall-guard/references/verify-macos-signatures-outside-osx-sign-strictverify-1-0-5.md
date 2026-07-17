# FK-PIT-0035: Verify macOS signatures outside osx-sign strictVerify 1.0.5

## Area

Electron packaging / macOS signing / tool compatibility

## Triggers

osx-sign 1.0.5,strictVerify,codesign --strict=true,macOS 26

## Symptoms

osx-sign 1.0.5 can emit an invalid codesign strict argument on macOS 26 and falsely fail a valid packaged app.

## Root cause

The `@electron/osx-sign` 1.0.5 verification path serializes its strict option as
`codesign --strict=true`. The macOS 26 system `codesign` accepts `--strict`
but rejects that value form, so the helper can report a signing failure even
when the app can be signed and independently verified correctly.

## Do

- Scope the compatibility workaround to the affected helper version: call the
  signing helper with `strictVerify: false`.
- Immediately run `/usr/bin/codesign --verify --deep --strict --verbose=4` on
  the completed app and make that command authoritative.
- Preserve and compare frozen nested-runtime hashes before and after outer
  signing so the workaround cannot hide recursive runtime mutation.
- Re-evaluate and remove the workaround when `@electron/osx-sign` is upgraded;
  keep a regression test for the explicit system verification.
- Treat Developer ID, notarization and Gatekeeper acceptance as their owning
  release QA gate, independently from packaged-like ad-hoc verification.

## Avoid

- Do not disable both helper verification and the system verification.
- Do not rewrite `--strict=true` errors as an invalid runtime or signing
  identity without checking the exact command emitted by the helper.
- Do not treat Gatekeeper rejection of an ad-hoc build as a PRE functional
  failure when public no-warning distribution is not in scope.

## Validation

```text
node --test scripts/local-subtitle/runtime/sign-packaged-spike.test.mjs
node scripts/local-subtitle/runtime/sign-packaged-spike.mjs --app <packaged app> --identity -
/usr/bin/codesign --verify --deep --strict --verbose=4 <packaged app>
```

The report must show deep strict verification passed and nested runtime hashes
unchanged. Gatekeeper status is recorded separately and is not promoted into a
PRE gate.

## Related files

- `scripts/local-subtitle/runtime/sign-packaged-spike.mjs`
- `scripts/local-subtitle/runtime/generate-electron-builder-spike.mjs`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
