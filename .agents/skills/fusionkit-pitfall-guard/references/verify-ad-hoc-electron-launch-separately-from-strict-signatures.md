# FK-PIT-0155: Verify ad-hoc Electron launch separately from strict signatures

## Area

Electron packaging / ad-hoc signing / library validation

## Triggers

different Team IDs, dyld, adhoc runtime, hardenedRuntime, optionsForFile, strict signing passes, Electron Framework

## Symptoms

A packaged app passes codesign --verify --deep --strict and retains all frozen native hashes, but immediately fails to start. The dynamic loader reports different Team IDs when loading Electron Framework. Signature inspection shows Signature=adhoc, flags=0x10002(adhoc,runtime) and no TeamIdentifier.

## Root cause

An ad-hoc signature does not provide a signing Team ID. Enabling hardened runtime for that local candidate applies library validation that can reject its Electron framework despite structurally valid signatures. @electron/osx-sign 1.0.5 enables hardened runtime by default and reads the setting from optionsForFile; a top-level hardenedRuntime property does not configure the per-file signing behavior.

This is separate from the osx-sign 1.0.5 strictVerify argument issue in FK-PIT-0035 and from frozen native hash ordering in FK-PIT-0033. Passing those checks does not prove that the final executable can load its frameworks.

## Do

- Choose the signing mode explicitly. For the local ad-hoc candidate only, use optionsForFile: () => ({ hardenedRuntime: false }). Keep hardened runtime enabled for Developer ID signing.
- Read back the final signature flags. Reject an ad-hoc + hardened-runtime candidate in this workflow; require final nested Developer ID signatures, hardened runtime and a secure timestamp in the Developer ID workflow.
- Preserve both native-resource contributions and compare their frozen hashes before and after outer signing. Re-stage before hashing when a nested signing identity or option changes.
- Run independent system deep/strict verification and then launch the exact final signed app with an isolated profile. Check startup, native loading and the intended business flow, and clean all owned processes.
- Keep ad-hoc integrity, functional startup, Developer ID signing, notarization and Gatekeeper distribution acceptance as distinct evidence.

## Avoid

- Do not infer launch success from a valid codesign result or unchanged resource hashes.
- Do not place hardenedRuntime only at the top level when using the affected osx-sign version.
- Do not disable hardened runtime in the Developer ID path to make an ad-hoc experiment pass.
- Do not edit a signed app's manifests to hide changed nested bytes, or describe a working ad-hoc candidate as formally distributed or notarized.

## Validation

The real 2026-09-14 candidate passed system deep/strict verification but failed startup with a dyld different-Team-IDs error. Its outer app reported adhoc,runtime and no Team ID. The signing helper now supplies optionsForFile for every app/framework file and rejects the unsafe local-mode flags during read-only verification.

The signing tests cover per-file options for both ad-hoc and Developer ID, both frozen resource contributions, explicit system strict verification, and rejection of an ad-hoc runtime flag even when strict verification itself passes. Final app launch evidence is recorded separately in the I9 release records; this case does not substitute unit tests for that launch.

## Related files

- scripts/packaging/sign-subtitle-studio.mjs
- scripts/packaging/sign-subtitle-studio.test.mjs
- docs/features/subtitle-studio/records/2026-09-14-release-signing-readiness.md
- freeze-native-hashes-after-final-nested-signing.md
- verify-macos-signatures-outside-osx-sign-strictverify-1-0-5.md
