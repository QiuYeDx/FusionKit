# FK-PIT-0023: Bundle native media runtime instead of using system PATH

## Area

Electron packaging / native media runtime / FFmpeg distribution.

## Triggers

FFmpeg, ffprobe, extraResources, system PATH, Homebrew, Chocolatey, packaged app, native media dependency, executable picker, local subtitle transcription

## Symptoms

- Media conversion works on a developer machine but fails on a clean user machine.
- A packaged app silently resolves `ffmpeg` or `ffprobe` from PATH.
- Product documentation asks users to install FFmpeg or browse to an executable.
- The installer succeeds even though a required binary, manifest or license file is missing.
- A corrupt or wrong-architecture bundled binary is discovered only after tasks have entered the queue.

## Root cause

Development preflight and packaged runtime have different evidence boundaries. A PATH probe is useful before release staging exists, but it says nothing about a signed application's resources. Treating the probe as the production resolver makes behavior depend on untrusted, mutable host state and bypasses the application's architecture, hash, signing and license controls.

## Do

- Treat system FFmpeg as a PRE/development PoC tool only, never as an end-user prerequisite or release proof.
- Package audited per-platform ffmpeg/ffprobe binaries outside asar with `extraResources`.
- Resolve packaged files only from a versioned, signature-covered manifest containing platform, architecture, relative path, byte size, SHA-256, version and license reference.
- Fail staging/build when a required binary, manifest entry, license or source-offer record is missing or inconsistent.
- Probe bundled resources before enqueue and map missing, invalid and launch failure to stable actionable errors.
- Preserve drafts, settings, managed models and committed user artifacts when repair/update/reinstall is required.
- Run packaged validation with system FFmpeg removed or PATH-isolated, then inject missing, corrupt, wrong-arch and non-executable resource cases.

## Avoid

- Do not fall back to PATH, Homebrew, Chocolatey, the Windows registry or a user-selected executable in packaged mode.
- Do not copy an arbitrary static build from a developer machine into release staging.
- Do not let tasks enter the queue when the bundled media runtime generation is invalid.
- Do not mutate a signed macOS app bundle as an ad hoc repair strategy; use the supported updater/repair/reinstall path.
- Do not describe a successful development PATH probe as packaged or licensing evidence.

## Validation

```text
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/preflight.test.mjs scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

For implementation and release packages, additionally verify that the build fails for every missing required resource, the packaged app succeeds with an empty media-tool PATH, all manifest hashes and architectures match, the three stable media-runtime errors block enqueue, and no UI or IPC accepts an executable path.

## Related files

- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- `docs/v0.2.11/local-subtitle-transcriber/feat/2026-07-16_local-subtitle-transcriber_arm64-only-and-bundled-ffmpeg.md`
- `scripts/local-subtitle/benchmark/preflight.mjs`
- Planned: `electron/main/local-subtitle/resource-path.ts`
- Planned: `electron/main/local-subtitle/media-normalizer.ts`
- Planned: `electron-builder.json`
